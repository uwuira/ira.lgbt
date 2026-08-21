import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import worker from "../src/index.js";
import { generateKeyPair, publicJwk, signJwt } from "./helpers/jwt.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let keys;
let outsiderKeys;
let adminToken;

beforeAll(async () => {
  keys = await generateKeyPair();
  outsiderKeys = await generateKeyPair();

  // Seed the JWKS cache so nothing here reaches for the network.
  await env.CACHE.put(
    "access:jwks",
    JSON.stringify({ keys: [await publicJwk(keys.publicKey, "test-key")] }),
  );

  adminToken = await signJwt(
    {
      iss: env.ACCESS_TEAM_DOMAIN,
      aud: [env.ACCESS_AUD],
      email: "ira@uwuu.moe",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    keys.privateKey,
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM submissions");
  await env.DB.exec("DELETE FROM blocks");
});

async function call(path, { token = adminToken, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers["cf-access-jwt-assertion"] = token;
  if (body) headers["content-type"] = "application/json";

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://ira.lgbt${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Sends a real submission through the public endpoint. */
async function submit(body, ip = "203.0.113.7") {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://ira.lgbt/api/inbox", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res.json();
}

describe("the door", () => {
  test("no Access token gets nothing", async () => {
    for (const path of ["/admin", "/admin/api/submissions", "/admin/api/blocks"]) {
      const res = await call(path, { token: null });
      expect(res.status, `expected 403 for ${path}`).toBe(403);
    }
  });

  test("a token signed by someone else gets nothing", async () => {
    const forged = await signJwt(
      {
        iss: env.ACCESS_TEAM_DOMAIN,
        aud: [env.ACCESS_AUD],
        email: "attacker@evil.example",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      outsiderKeys.privateKey,
    );
    expect((await call("/admin/api/submissions", { token: forged })).status).toBe(403);
  });

  test("an expired token gets nothing", async () => {
    const stale = await signJwt(
      {
        iss: env.ACCESS_TEAM_DOMAIN,
        aud: [env.ACCESS_AUD],
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      keys.privateKey,
    );
    expect((await call("/admin/api/submissions", { token: stale })).status).toBe(403);
  });

  test("a valid token opens the admin page", async () => {
    const res = await call("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/inbox/i);
  });

  test("the admin page is never reachable as a plain asset", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://ira.lgbt/admin.html"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  test("admin is not served on other hosts", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://blog.ira.lgbt/admin", {
        headers: { "cf-access-jwt-assertion": adminToken },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  test("admin responses are never cached or indexed", async () => {
    const res = await call("/admin");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });
});

describe("reading the inbox", () => {
  test("lists submissions newest first", async () => {
    await submit({ text: "oldest" });
    await submit({ text: "middle" });
    await submit({ text: "newest" });

    const { submissions } = await (await call("/admin/api/submissions")).json();
    expect(submissions.map((s) => s.text)).toEqual(["newest", "middle", "oldest"]);
  });

  test("includes what is needed to block the sender", async () => {
    await submit({ text: "hello" }, "198.51.100.4");

    const { submissions } = await (await call("/admin/api/submissions")).json();
    expect(submissions[0]).toMatchObject({
      text: "hello",
      senderId: expect.stringMatching(/^[0-9a-f]{32}$/),
      ipHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(submissions[0].createdAt).toBeGreaterThan(0);
  });

  test("keeps the country out of the payload entirely", async () => {
    await submit({ text: "hello" }, "198.51.100.4");

    const { submissions } = await (await call("/admin/api/submissions")).json();
    expect(submissions[0]).not.toHaveProperty("country");
  });

  test("flags a drawing and links it, rather than inlining the bytes", async () => {
    const { id } = await submit({ drawing: PNG_1X1 });

    const { submissions } = await (await call("/admin/api/submissions")).json();
    expect(submissions[0].drawingUrl).toBe(`/admin/drawing/${id}`);
  });

  test("counts how many are unread", async () => {
    await submit({ text: "one" });
    await submit({ text: "two" });

    expect((await (await call("/admin/api/submissions")).json()).unread).toBe(2);

    await call("/admin/api/seen", { method: "POST" });
    expect((await (await call("/admin/api/submissions")).json()).unread).toBe(0);
  });

  test("pages through with a cursor instead of returning everything", async () => {
    for (let i = 0; i < 5; i++) await submit({ text: `msg ${i}` }, `198.51.100.${i}`);

    const first = await (await call("/admin/api/submissions?limit=2")).json();
    expect(first.submissions).toHaveLength(2);
    expect(first.cursor).toBeTruthy();

    const second = await (await call(`/admin/api/submissions?limit=2&cursor=${first.cursor}`)).json();
    expect(second.submissions).toHaveLength(2);

    const ids = [...first.submissions, ...second.submissions].map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
  });

  test("caps an absurd limit rather than obeying it", async () => {
    const res = await call("/admin/api/submissions?limit=99999");
    expect(res.status).toBe(200);
  });
});

describe("drawings", () => {
  test("are served as PNG, and only to admin", async () => {
    const { id } = await submit({ drawing: PNG_1X1 });

    const res = await call(`/admin/drawing/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await call(`/admin/drawing/${id}`, { token: null })).status).toBe(403);
  });

  test("404 for an unknown id", async () => {
    expect((await call("/admin/drawing/does-not-exist")).status).toBe(404);
  });

  test("a malformed id is a miss, not a crash", async () => {
    expect((await call("/admin/drawing/%")).status).toBe(404);
    expect((await call("/admin/api/submissions/%", { method: "DELETE" })).status).toBe(404);
  });

  test("an id cannot be used to reach other keys in the bucket", async () => {
    await env.DRAWINGS.put("secret.txt", "not for you");
    const res = await call("/admin/drawing/..%2Fsecret.txt");
    expect(res.status).toBe(404);
  });
});

describe("blocking people", () => {
  test("blocks a sender, who can then no longer send", async () => {
    await submit({ text: "spam" });
    const { submissions } = await (await call("/admin/api/submissions")).json();

    const res = await call("/admin/api/block", {
      method: "POST",
      body: { kind: "sender", value: submissions[0].senderId, note: "spammer" },
    });
    expect(res.status).toBe(200);

    const { blocks } = await (await call("/admin/api/blocks")).json();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "sender", note: "spammer" });
  });

  test("blocks an ip", async () => {
    await submit({ text: "spam" }, "198.51.100.66");
    const { submissions } = await (await call("/admin/api/submissions")).json();

    await call("/admin/api/block", {
      method: "POST",
      body: { kind: "ip", value: submissions[0].ipHash },
    });

    const { blocks } = await (await call("/admin/api/blocks")).json();
    expect(blocks[0].kind).toBe("ip");
  });

  test("blocking twice is not an error", async () => {
    await call("/admin/api/block", { method: "POST", body: { kind: "sender", value: "abc" } });
    const res = await call("/admin/api/block", {
      method: "POST",
      body: { kind: "sender", value: "abc" },
    });
    expect(res.status).toBe(200);
    expect((await (await call("/admin/api/blocks")).json()).blocks).toHaveLength(1);
  });

  test("unblocks again", async () => {
    await call("/admin/api/block", { method: "POST", body: { kind: "sender", value: "abc" } });
    await call("/admin/api/unblock", { method: "POST", body: { kind: "sender", value: "abc" } });
    expect((await (await call("/admin/api/blocks")).json()).blocks).toHaveLength(0);
  });

  test("refuses a block of an unknown kind", async () => {
    const res = await call("/admin/api/block", {
      method: "POST",
      body: { kind: "everyone", value: "abc" },
    });
    expect(res.status).toBe(400);
  });

  test("refuses a block with no value", async () => {
    expect(
      (await call("/admin/api/block", { method: "POST", body: { kind: "sender", value: "" } })).status,
    ).toBe(400);
  });

  test("an outsider cannot block anyone", async () => {
    const res = await call("/admin/api/block", {
      token: null,
      method: "POST",
      body: { kind: "sender", value: "abc" },
    });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks").first("n")).toBe(0);
  });
});

describe("deleting submissions", () => {
  test("removes the row and the drawing behind it", async () => {
    const { id } = await submit({ text: "bye", drawing: PNG_1X1 });
    expect(await env.DRAWINGS.get(`drawings/${id}.png`)).toBeTruthy();

    const res = await call(`/admin/api/submissions/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect((await (await call("/admin/api/submissions")).json()).submissions).toHaveLength(0);
    expect(await env.DRAWINGS.get(`drawings/${id}.png`)).toBe(null);
  });

  test("deleting something already gone is not an error", async () => {
    expect((await call("/admin/api/submissions/nope", { method: "DELETE" })).status).toBe(200);
  });

  test("an outsider cannot delete", async () => {
    const { id } = await submit({ text: "keep me" });
    const res = await call(`/admin/api/submissions/${id}`, { token: null, method: "DELETE" });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions").first("n")).toBe(1);
  });
});

describe("unknown admin routes", () => {
  test("404 rather than falling through to the site", async () => {
    expect((await call("/admin/nope")).status).toBe(404);
    expect((await call("/admin/api/nope")).status).toBe(404);
  });

  test("wrong method on a real route", async () => {
    expect((await call("/admin/api/block")).status).toBe(405);
  });
});

describe("marking one message read", () => {
  const list = async () => (await (await call("/admin/api/submissions")).json()).submissions;

  const setRead = (id, read) =>
    call(`/admin/api/submissions/${id}/read`, { method: "POST", body: { read } });

  test("stamps just that one, and leaves the others alone", async () => {
    await submit({ text: "one" });
    await submit({ text: "two" });

    const before = await list();
    expect(before.every((s) => s.readAt === null)).toBe(true);

    const res = await setRead(before[0].id, true);
    expect(res.status).toBe(200);

    const after = await list();
    expect(after.find((s) => s.id === before[0].id).readAt).toBeGreaterThan(0);
    expect(after.find((s) => s.id === before[1].id).readAt).toBe(null);
  });

  test("the unread count drops by exactly one", async () => {
    await submit({ text: "one" });
    await submit({ text: "two" });
    await submit({ text: "three" });

    const [first] = await list();
    await setRead(first.id, true);

    const { unread } = await (await call("/admin/api/submissions")).json();
    expect(unread).toBe(2);
  });

  test("hands back the new state so the page need not reload", async () => {
    await submit({ text: "one" });
    await submit({ text: "two" });

    const [first] = await list();
    const body = await (await setRead(first.id, true)).json();

    expect(body.ok).toBe(true);
    expect(body.readAt).toBeGreaterThan(0);
    expect(body.unread).toBe(1);
  });

  test("can be put back to unread again", async () => {
    await submit({ text: "one" });
    const [only] = await list();

    await setRead(only.id, true);
    const body = await (await setRead(only.id, false)).json();

    expect(body.readAt).toBe(null);
    expect(body.unread).toBe(1);
    expect((await list())[0].readAt).toBe(null);
  });

  test("defaults to marking read when the body says nothing", async () => {
    await submit({ text: "one" });
    const [only] = await list();

    const res = await call(`/admin/api/submissions/${only.id}/read`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await list())[0].readAt).toBeGreaterThan(0);
  });

  test("marking read twice is not an error", async () => {
    await submit({ text: "one" });
    const [only] = await list();

    await setRead(only.id, true);
    expect((await setRead(only.id, true)).status).toBe(200);
  });

  test("404s for a message that is not there", async () => {
    expect((await setRead("does-not-exist", true)).status).toBe(404);
    expect((await setRead("%", true)).status).toBe(404);
  });

  test("an outsider cannot mark anything", async () => {
    await submit({ text: "one" });
    const [only] = await list();

    const res = await call(`/admin/api/submissions/${only.id}/read`, {
      token: null,
      method: "POST",
      body: { read: true },
    });

    expect(res.status).toBe(403);
    expect((await list())[0].readAt).toBe(null);
  });

  test("rejects the wrong method", async () => {
    await submit({ text: "one" });
    const [only] = await list();
    expect((await call(`/admin/api/submissions/${only.id}/read`)).status).toBe(405);
  });

  test("does not collide with deleting the same message", async () => {
    await submit({ text: "one" });
    const [only] = await list();

    await setRead(only.id, true);
    expect((await call(`/admin/api/submissions/${only.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await list()).toHaveLength(0);
  });
});
