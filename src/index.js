const APEX = "ira.lgbt";
const WWW = `www.${APEX}`;

// The only paths the site actually exposes. Everything else 404s, including
// /index.html — the landing page is reachable at / and nowhere else.
const SERVED = new Set(["/", "/favicon.jpg"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    if (host === WWW) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }

    if (host !== APEX || !SERVED.has(url.pathname)) {
      return notFound(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// Serve the styled 404 page under a 404 status, whatever the request was for.
async function notFound(request, env) {
  const page = new URL("/404.html", request.url);
  const res = await env.ASSETS.fetch(new Request(page, { method: "GET" }));
  return new Response(request.method === "HEAD" ? null : res.body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
