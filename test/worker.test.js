import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";

const publicDir = new URL("../public/", import.meta.url);

// Stand-in for the Cloudflare `assets` binding: resolves a request against
// ./public the same way Cloudflare does, including `not_found_handling: 404-page`.
const env = {
  ASSETS: {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      try {
        const body = readFileSync(fileURLToPath(new URL(name, publicDir)));
        const type = name.endsWith(".jpg") ? "image/jpeg" : "text/html; charset=utf-8";
        return new Response(body, { status: 200, headers: { "content-type": type } });
      } catch {
        const body = readFileSync(fileURLToPath(new URL("404.html", publicDir)));
        return new Response(body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      }
    },
  },
};

const get = (url, init) => worker.fetch(new Request(url, init), env);

describe("apex (ira.lgbt)", () => {
  test("serves the index page at /", async () => {
    const res = await get("https://ira.lgbt/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /<h1>hi<\/h1>/);
  });

  test("serves the favicon, so og:image resolves", async () => {
    const res = await get("https://ira.lgbt/favicon.jpg");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
  });

  test("404s any other path", async () => {
    for (const path of ["/about", "/games", "/deep/nested/path", "/404.html"]) {
      const res = await get(`https://ira.lgbt${path}`);
      assert.equal(res.status, 404, `expected 404 for ${path}`);
    }
  });

  test("404s /index.html — the index is only reachable at /", async () => {
    const res = await get("https://ira.lgbt/index.html");
    assert.equal(res.status, 404);
  });

  test("serves the styled 404 page as the not-found body", async () => {
    const res = await get("https://ira.lgbt/nope");
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /<h1>404<\/h1>/);
  });

  test("matches the host case-insensitively", async () => {
    const res = await get("https://IRA.LGBT/");
    assert.equal(res.status, 200);
  });
});

describe("www.ira.lgbt", () => {
  test("permanently redirects to the apex", async () => {
    const res = await get("https://www.ira.lgbt/");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "https://ira.lgbt/");
  });

  test("preserves path and query when redirecting", async () => {
    const res = await get("https://www.ira.lgbt/foo/bar?a=1&b=2");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "https://ira.lgbt/foo/bar?a=1&b=2");
  });
});

describe("every other subdomain", () => {
  test("404s without serving assets", async () => {
    for (const host of ["blog.ira.lgbt", "cdn.ira.lgbt", "a.b.ira.lgbt"]) {
      const res = await get(`https://${host}/`);
      assert.equal(res.status, 404, `expected 404 for ${host}`);
    }
  });

  test("404s even for paths the apex would serve", async () => {
    const res = await get("https://blog.ira.lgbt/favicon.jpg");
    assert.equal(res.status, 404);
  });

  test("does not redirect a host that merely ends in www", async () => {
    const res = await get("https://notwww.ira.lgbt/");
    assert.equal(res.status, 404);
  });
});
