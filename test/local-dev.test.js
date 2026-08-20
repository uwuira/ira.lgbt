import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import worker from "../src/index.js";

// Cloudflare Access cannot run in front of `wrangler dev`, so local work on
// the admin page needs one explicit switch. It lives only in .dev.vars.
const bypassed = { ...env, ADMIN_DEV_BYPASS: "true" };

const get = async (url, environment = env, init) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), environment, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

describe("ADMIN_DEV_BYPASS", () => {
  test("opens admin without an Access token when it is exactly 'true'", async () => {
    expect((await get("https://ira.lgbt/admin", bypassed)).status).toBe(200);
    expect((await get("https://ira.lgbt/admin/api/submissions", bypassed)).status).toBe(200);
  });

  test("is off unless set, so admin stays shut by default", async () => {
    expect((await get("https://ira.lgbt/admin")).status).toBe(403);
  });

  test("is not enabled by a merely truthy value", async () => {
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      const res = await get("https://ira.lgbt/admin", { ...env, ADMIN_DEV_BYPASS: value });
      expect(res.status, `expected 403 for ADMIN_DEV_BYPASS=${JSON.stringify(value)}`).toBe(403);
    }
  });

  test("opens nothing beyond admin — other hosts still 404", async () => {
    expect((await get("https://blog.ira.lgbt/admin", bypassed)).status).toBe(404);
    expect((await get("https://blog.ira.lgbt/", bypassed)).status).toBe(404);
  });

  test("does not make the admin page public as an asset", async () => {
    expect((await get("https://ira.lgbt/admin.html", bypassed)).status).toBe(404);
  });
});

describe("the site under wrangler dev", () => {
  // `wrangler dev` presents the configured route's hostname to the Worker, so
  // the host rules need no local special case at all.
  test("serves normally on the apex, which is what dev sees", async () => {
    expect((await get("https://ira.lgbt/")).status).toBe(200);
    expect((await get("https://ira.lgbt/widgets.js")).status).toBe(200);
  });
});
