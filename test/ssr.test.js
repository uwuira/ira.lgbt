import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

import worker from "../src/index.js";
import { STATE_CACHE_KEY } from "../src/spotify.js";

const song = (over = {}) => ({
  title: "seaside vacation",
  artist: "boa",
  album: "some album",
  url: "https://open.spotify.com/track/abc",
  art: "https://i.scdn.co/abc",
  durationMs: 210_000,
  ...over,
});

/**
 * Puts a known widget in the Worker's cache so a page render is deterministic
 * and never reaches for the real Spotify API.
 */
async function seed(widget) {
  await caches.default.put(
    new Request(STATE_CACHE_KEY),
    new Response(JSON.stringify(widget), {
      headers: {
        "content-type": "application/json",
        "cache-control": "max-age=5",
        "x-fetched-at": String(Date.now()),
      },
    }),
  );
}

const getIndex = async (init) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://ira.lgbt/", init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

beforeEach(async () => {
  await caches.default.delete(new Request(STATE_CACHE_KEY));
});

describe("the page arrives with the widget already on it", () => {
  test("the playing track is in the HTML, not fetched afterwards", async () => {
    await seed({ playing: song({ progressMs: 45_000 }), recent: [] });

    const html = await (await getIndex()).text();
    expect(html).toContain("seaside vacation");
    expect(html).toContain("now playing");
    expect(html).toContain("track-live");
  });

  test("the progress bar and clock are already filled in", async () => {
    await seed({ playing: song({ progressMs: 105_000 }), recent: [] });

    const html = await (await getIndex()).text();
    expect(html).toMatch(/width:\s*5[01](\.\d+)?%/);
    expect(html).toContain("3:30");
  });

  test("recent tracks are rendered too", async () => {
    await seed({
      playing: null,
      recent: [
        song({ title: "first one", playedAt: new Date().toISOString() }),
        song({ title: "second one", playedAt: new Date().toISOString() }),
      ],
    });

    const html = await (await getIndex()).text();
    expect(html).toContain("first one");
    expect(html).toContain("second one");
  });

  test("the section is revealed when there is something to show", async () => {
    await seed({ playing: song({ progressMs: 0 }), recent: [] });

    const html = await (await getIndex()).text();
    const section = html.match(/<section id="spotify"[^>]*>/)[0];
    expect(section).not.toContain("hidden");
  });

  test("the section stays hidden when there is nothing to show", async () => {
    await seed({ playing: null, recent: [] });

    const html = await (await getIndex()).text();
    const section = html.match(/<section id="spotify"[^>]*>/)[0];
    expect(section).toContain("hidden");
  });
});

describe("the embedded state the browser picks up", () => {
  test("carries the same widget the markup was rendered from", async () => {
    await seed({ playing: song({ progressMs: 45_000 }), recent: [] });

    const html = await (await getIndex()).text();
    const json = html.match(
      /<script type="application\/json" id="spotify-state">([\s\S]*?)<\/script>/,
    )[1];

    const state = JSON.parse(json.replaceAll("\\u003c", "<"));
    expect(state.playing.title).toBe("seaside vacation");
    expect(state.playing.durationMs).toBe(210_000);
    expect(state).toHaveProperty("staleMs");
  });

  test("a track title cannot break out of the script tag", async () => {
    await seed({
      playing: song({ title: "</script><img src=x onerror=alert(1)>", progressMs: 0 }),
      recent: [],
    });

    const html = await (await getIndex()).text();
    // The literal closing tag must not appear inside the JSON block.
    const json = html.match(
      /<script type="application\/json" id="spotify-state">([\s\S]*?)<\/script>/,
    )[1];
    expect(json).not.toContain("</script>");
    expect(json).not.toContain("<img");
    expect(JSON.parse(json.replaceAll("\\u003c", "<")).playing.title).toBe(
      "</script><img src=x onerror=alert(1)>",
    );
  });

  test("a track title cannot inject markup into the rendered rows", async () => {
    await seed({
      playing: song({ title: "<img src=x onerror=alert(1)>", progressMs: 0 }),
      recent: [],
    });

    const html = await (await getIndex()).text();
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("the page itself", () => {
  test("is still HTML, and still 200", async () => {
    await seed({ playing: song({ progressMs: 0 }), recent: [] });

    const res = await getIndex();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  test("is not cached, since it now embeds live state", async () => {
    const res = await getIndex();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  test("still contains the rest of the site", async () => {
    await seed({ playing: song({ progressMs: 0 }), recent: [] });

    const html = await (await getIndex()).text();
    expect(html).toMatch(/<h1>hi<\/h1>/);
    expect(html).toContain("inbox-form");
  });

  test("answers HEAD without a body", async () => {
    const res = await getIndex({ method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("renders even when Spotify has nothing for us", async () => {
    await seed({ playing: null, recent: [] });

    const res = await getIndex();
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<h1>hi<\/h1>/);
  });
});

describe("the shared renderer is served to the browser too", () => {
  test("GET /render.js is a module the page can import", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://ira.lgbt/render.js"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toContain("export");
  });
});
