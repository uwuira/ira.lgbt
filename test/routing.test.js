import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import worker from "../src/index.js";

const get = async (url, init) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

describe("apex (ira.lgbt)", () => {
  test("serves the index page at /", async () => {
    const res = await get("https://ira.lgbt/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<h1>hi<\/h1>/);
  });

  test("serves the favicon, so og:image resolves", async () => {
    const res = await get("https://ira.lgbt/favicon.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  test("serves the widget script", async () => {
    const res = await get("https://ira.lgbt/widgets.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  test("404s any other path", async () => {
    for (const path of ["/about", "/games", "/deep/nested/path", "/404.html", "/admin.html"]) {
      const res = await get(`https://ira.lgbt${path}`);
      expect(res.status, `expected 404 for ${path}`).toBe(404);
    }
  });

  test("404s /index.html — the index is only reachable at /", async () => {
    const res = await get("https://ira.lgbt/index.html");
    expect(res.status).toBe(404);
  });

  test("serves the styled 404 page as the not-found body", async () => {
    const res = await get("https://ira.lgbt/nope");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<h1>404<\/h1>/);
  });

  test("matches the host case-insensitively", async () => {
    const res = await get("https://IRA.LGBT/");
    expect(res.status).toBe(200);
  });
});

describe("www.ira.lgbt", () => {
  test("permanently redirects to the apex", async () => {
    const res = await get("https://www.ira.lgbt/");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://ira.lgbt/");
  });

  test("preserves path and query when redirecting", async () => {
    const res = await get("https://www.ira.lgbt/foo/bar?a=1&b=2");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://ira.lgbt/foo/bar?a=1&b=2");
  });
});

describe("every other subdomain", () => {
  test("404s without serving assets", async () => {
    for (const host of ["blog.ira.lgbt", "cdn.ira.lgbt", "a.b.ira.lgbt"]) {
      const res = await get(`https://${host}/`);
      expect(res.status, `expected 404 for ${host}`).toBe(404);
    }
  });

  test("404s even for paths the apex would serve", async () => {
    const res = await get("https://blog.ira.lgbt/favicon.jpg");
    expect(res.status).toBe(404);
  });

  test("does not redirect a host that merely ends in www", async () => {
    const res = await get("https://notwww.ira.lgbt/");
    expect(res.status).toBe(404);
  });
});
