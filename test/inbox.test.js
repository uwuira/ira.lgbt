import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

import worker from "../src/index.js";
import { LIMITS } from "../src/inbox.js";
import { COOKIE_NAME, hashIp } from "../src/lib/sender.js";

// A real 1x1 PNG — small, but with the magic bytes a real upload would carry.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM submissions");
  await env.DB.exec("DELETE FROM blocks");
});

async function post(body, { cookie, ip = "203.0.113.7" } = {}) {
  const headers = { "content-type": "application/json", "CF-Connecting-IP": ip };
  if (cookie) headers.cookie = cookie;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://ira.lgbt/api/inbox", { method: "POST", headers, body: JSON.stringify(body) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** The Set-Cookie value a response hands back, so a test can keep an identity. */
const cookieFrom = (res) => res.headers.get("set-cookie")?.split(";")[0];

const rows = async () =>
  (await env.DB.prepare("SELECT * FROM submissions ORDER BY created_at").all()).results;

describe("sending a message", () => {
  test("accepts text and stores it", async () => {
    const res = await post({ text: "hi ira, cool site" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });

    const [row] = await rows();
    expect(row.text).toBe("hi ira, cool site");
    expect(row.drawing_key).toBe(null);
  });

  test("hands the sender a signed cookie so later messages are attributable", async () => {
    const res = await post({ text: "first" });
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));

    await post({ text: "second" }, { cookie });

    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored[0].sender_id).toBe(stored[1].sender_id);
  });

  test("treats a visitor with no cookie as a new sender each time", async () => {
    await post({ text: "one" });
    await post({ text: "two" });

    const stored = await rows();
    expect(stored[0].sender_id).not.toBe(stored[1].sender_id);
  });

  test("records a salted ip hash, never the address", async () => {
    await post({ text: "hi" }, { ip: "198.51.100.9" });

    const [row] = await rows();
    expect(row.ip_hash).toBe(await hashIp("198.51.100.9", env.IP_SALT));
    expect(JSON.stringify(row)).not.toContain("198.51.100.9");
  });

  test("trims surrounding whitespace", async () => {
    await post({ text: "   padded   " });
    expect((await rows())[0].text).toBe("padded");
  });

  test("stores the message verbatim, escaping is the reader's job", async () => {
    const nasty = '<script>alert(1)</script> & "quotes"';
    await post({ text: nasty });
    expect((await rows())[0].text).toBe(nasty);
  });
});

describe("sending a drawing", () => {
  test("accepts a PNG, stores the bytes in R2 and the key in D1", async () => {
    const res = await post({ drawing: PNG_1X1 });
    expect(res.status).toBe(201);

    const [row] = await rows();
    expect(row.drawing_key).toMatch(/^drawings\//);

    const object = await env.DRAWINGS.get(row.drawing_key);
    expect(object).toBeTruthy();
    expect(new Uint8Array(await object.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  test("accepts a data: URL, which is what a canvas produces", async () => {
    const res = await post({ drawing: `data:image/png;base64,${PNG_1X1}` });
    expect(res.status).toBe(201);
    expect((await rows())[0].drawing_key).toBeTruthy();
  });

  test("accepts a message and a drawing together", async () => {
    await post({ text: "drew you something", drawing: PNG_1X1 });

    const [row] = await rows();
    expect(row.text).toBe("drew you something");
    expect(row.drawing_key).toBeTruthy();
  });

  test("rejects anything that is not a PNG", async () => {
    const jpegMagic = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0));
    const res = await post({ drawing: jpegMagic });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions").first("n")).toBe(0);
  });

  test("rejects a drawing that is too large", async () => {
    const huge = btoa(
      String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) +
        "x".repeat(LIMITS.drawingBytes + 1000),
    );
    const res = await post({ drawing: huge });
    expect(res.status).toBe(400);
  });

  test("rejects a drawing that is not valid base64", async () => {
    expect((await post({ drawing: "!!!! not base64 !!!!" })).status).toBe(400);
  });
});

describe("what gets refused", () => {
  test("an empty submission", async () => {
    for (const body of [{}, { text: "" }, { text: "   " }, { text: null }]) {
      const res = await post(body);
      expect(res.status, `expected 400 for ${JSON.stringify(body)}`).toBe(400);
    }
  });

  test("a message longer than the limit", async () => {
    expect((await post({ text: "x".repeat(LIMITS.text + 1) })).status).toBe(400);
    expect((await post({ text: "x".repeat(LIMITS.text) })).status).toBe(201);
  });

  test("a body that is not JSON", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://ira.lgbt/api/inbox", { method: "POST", body: "not json at all" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  test("text that is not a string", async () => {
    expect((await post({ text: { nested: "object" } })).status).toBe(400);
    expect((await post({ text: 12345 })).status).toBe(400);
  });

  test("a GET, which is not how you send anything", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://ira.lgbt/api/inbox"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  test("nothing is stored when validation fails", async () => {
    await post({ text: "" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions").first("n")).toBe(0);
  });
});

describe("blocking", () => {
  test("a blocked sender is refused", async () => {
    const cookie = cookieFrom(await post({ text: "first one is fine" }));
    const senderId = (await rows())[0].sender_id;

    await env.DB.prepare("INSERT INTO blocks (kind, value, created_at) VALUES ('sender', ?, 0)")
      .bind(senderId)
      .run();

    const res = await post({ text: "spam" }, { cookie });
    expect(res.status).toBe(403);
    expect(await rows()).toHaveLength(1);
  });

  test("a blocked ip is refused even from a brand new browser", async () => {
    const ipHash = await hashIp("203.0.113.7", env.IP_SALT);
    await env.DB.prepare("INSERT INTO blocks (kind, value, created_at) VALUES ('ip', ?, 0)")
      .bind(ipHash)
      .run();

    const res = await post({ text: "spam" }, { ip: "203.0.113.7" });
    expect(res.status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  test("blocking one ip does not block everyone else", async () => {
    await env.DB.prepare("INSERT INTO blocks (kind, value, created_at) VALUES ('ip', ?, 0)")
      .bind(await hashIp("203.0.113.7", env.IP_SALT))
      .run();

    expect((await post({ text: "innocent" }, { ip: "203.0.113.8" })).status).toBe(201);
  });

  test("a blocked drawing never reaches R2", async () => {
    await env.DB.prepare("INSERT INTO blocks (kind, value, created_at) VALUES ('ip', ?, 0)")
      .bind(await hashIp("203.0.113.7", env.IP_SALT))
      .run();

    await post({ drawing: PNG_1X1 });
    expect((await env.DRAWINGS.list()).objects.filter((o) => o.key.startsWith("drawings/"))).toEqual(
      expect.arrayContaining([]),
    );
    expect(await rows()).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  test("stops a sender who floods, and says when to come back", async () => {
    let cookie = cookieFrom(await post({ text: "1" }));

    for (let i = 2; i <= LIMITS.perSenderPerHour; i++) {
      expect((await post({ text: String(i) }, { cookie })).status).toBe(201);
    }

    const res = await post({ text: "one too many" }, { cookie });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await rows()).toHaveLength(LIMITS.perSenderPerHour);
  });

  test("stops a flood from one address even as the cookie keeps changing", async () => {
    for (let i = 0; i < LIMITS.perIpPerHour; i++) {
      await post({ text: `msg ${i}` }, { ip: "203.0.113.99" });
    }

    const res = await post({ text: "still me" }, { ip: "203.0.113.99" });
    expect(res.status).toBe(429);
  });

  test("only counts the last hour", async () => {
    const cookie = cookieFrom(await post({ text: "recent" }));
    const senderId = (await rows())[0].sender_id;

    // Backdate everything by two hours; the window should have moved on.
    await env.DB.prepare("UPDATE submissions SET created_at = created_at - ?")
      .bind(2 * 60 * 60 * 1000)
      .run();

    for (let i = 0; i < LIMITS.perSenderPerHour; i++) {
      expect((await post({ text: `new ${i}` }, { cookie })).status).toBe(201);
    }

    const stored = await rows();
    expect(stored.every((row) => row.sender_id === senderId)).toBe(true);
  });

  test("one person hitting the limit does not stop anybody else", async () => {
    const cookie = cookieFrom(await post({ text: "1" }));
    for (let i = 2; i <= LIMITS.perSenderPerHour + 2; i++) {
      await post({ text: String(i) }, { cookie });
    }

    expect((await post({ text: "hello" }, { ip: "198.51.100.55" })).status).toBe(201);
  });
});
