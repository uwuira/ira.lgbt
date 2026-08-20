import { hasTracks, renderTracks } from "../public/render.js";
import { handleAdmin } from "./admin.js";
import { handleInbox } from "./inbox.js";
import { handleSpotify, spotifyState } from "./spotify.js";

const APEX = "ira.lgbt";
const WWW = `www.${APEX}`;

// The only static paths the site exposes. Everything else 404s, including
// /index.html — the landing page is reachable at / and nowhere else.
const SERVED = new Set(["/", "/favicon.jpg", "/widgets.js", "/render.js"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    if (host === WWW) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }

    // `wrangler dev` serves under the configured route's hostname too, so this
    // rule behaves identically locally and in production.
    if (host !== APEX) return notFound(request, env);

    // Everything under /admin is gated by Cloudflare Access; handleAdmin
    // verifies the Access token itself rather than assuming we got here
    // through it.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    if (url.pathname === "/api/spotify") return handleSpotify(request, env, ctx);
    if (url.pathname === "/api/inbox") return handleInbox(request, env, ctx);

    if (!SERVED.has(url.pathname)) return notFound(request, env);

    // The landing page is assembled here rather than served flat, so the
    // Spotify widget is already on the page when it arrives.
    if (url.pathname === "/") return renderIndex(request, env);

    return env.ASSETS.fetch(request);
  },
};

/**
 * Serves index.html with the Spotify widget already rendered into it.
 *
 * Without this the widget pops in a moment after load, once the browser has
 * parsed the page, fetched the script and fetched the state. The same snapshot
 * is also embedded as JSON so the browser can start animating the progress bar
 * immediately instead of waiting for its first poll.
 */
async function renderIndex(request, env) {
  const page = await env.ASSETS.fetch(new Request(new URL("/", request.url), { method: "GET" }));

  const headers = new Headers(page.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  // The page now embeds a snapshot that is only good for a few seconds.
  headers.set("cache-control", "no-store");

  if (request.method === "HEAD") return new Response(null, { status: page.status, headers });

  const state = await spotifyState(env);
  const showing = hasTracks(state);

  return new HTMLRewriter()
    .on("#spotify", {
      element(element) {
        if (showing) element.removeAttribute("hidden");
      },
    })
    .on("#spotify-tracks", {
      element(element) {
        element.setInnerContent(renderTracks(state), { html: true });
      },
    })
    .on("#spotify-state", {
      element(element) {
        // Script content is raw text to a browser, so entity-escaping would
        // corrupt the JSON. Escaping every `<` to its \\u003c form is still
        // valid JSON, preserves the value exactly, and makes it impossible
        // for a track title to write a closing script tag.
        const json = JSON.stringify(state).replaceAll("<", "\\u003c");
        element.setInnerContent(json, { html: true });
      },
    })
    .transform(new Response(page.body, { status: page.status, headers }));
}

// Serve the styled 404 page under a 404 status, whatever the request was for.
async function notFound(request, env) {
  const page = new URL("/404.html", request.url);
  const res = await env.ASSETS.fetch(new Request(page, { method: "GET" }));
  return new Response(request.method === "HEAD" ? null : res.body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
