import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

import worker from "../src/index.js";
import { STATE_CACHE_KEY, WIDGET_TTL_MS, spotifyState, spotifyWidget } from "../src/spotify.js";
import {
  NOW_PLAYING_URL,
  RECENT_URL,
  TOKEN_URL,
  recentTracks,
  responses,
  stubFetch,
  track,
} from "./helpers/spotify-stub.js";

// KV survives between tests in the same worker, so the cached token has to go.
beforeEach(async () => {
  for (const key of ["spotify:access_token", "spotify:refresh_token", "spotify:widget"]) {
    await env.CACHE.delete(key);
  }
});

// The widget now carries the whole recent history; deciding how much of it to
// show is the renderer's job, not the API's.
const twoRecent = () => responses.recent(recentTracks(2));
const manyRecent = (n = 20) => responses.recent(recentTracks(n));

describe("what the widget reports", () => {
  test("something playing: the current track plus the one before it", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(track("first")),
      [RECENT_URL]: twoRecent(),
    });

    const widget = await spotifyWidget(env, { fetchImpl });

    expect(widget.playing).toMatchObject({ title: "first", artist: "some artist" });
    expect(widget.recent.map((t) => t.title)).toEqual(["recent-1", "recent-2"]);
  });

  test("nothing playing: the history and no current track", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: manyRecent(20),
    });

    const widget = await spotifyWidget(env, { fetchImpl });

    expect(widget.playing).toBe(null);
    expect(widget.recent).toHaveLength(20);
    expect(widget.recent[0].title).toBe("recent-1");
  });

  test("asks Spotify for a full page of history, not just the last couple", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: manyRecent(20),
    });

    await spotifyWidget(env, { fetchImpl });

    expect(fetchImpl.callsTo(RECENT_URL)[0].url).toContain("limit=20");
  });

  test("keeps at most twenty, however many Spotify returns", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: manyRecent(50),
    });

    const widget = await spotifyWidget(env, { fetchImpl });
    expect(widget.recent).toHaveLength(20);
  });

  test("copes with an account that has barely any history", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: responses.recent(recentTracks(1)),
    });

    const widget = await spotifyWidget(env, { fetchImpl });
    expect(widget.recent).toHaveLength(1);
  });

  test("paused counts as not playing", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(track("first"), { is_playing: false }),
      [RECENT_URL]: twoRecent(),
    });

    const widget = await spotifyWidget(env, { fetchImpl });

    expect(widget.playing).toBe(null);
    expect(widget.recent).toHaveLength(2);
  });

  test("a track carries everything the UI needs and nothing else", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(track("first", "boa")),
      [RECENT_URL]: twoRecent(),
    });

    const { playing } = await spotifyWidget(env, { fetchImpl });

    expect(playing).toEqual({
      title: "first",
      artist: "boa",
      album: "first - single",
      url: "https://open.spotify.com/track/first",
      art: "https://i.scdn.co/first-300",
      durationMs: 210_000,
      progressMs: 45_000,
    });
  });

  test("joins multiple artists", async () => {
    const collab = track("first");
    collab.artists = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(collab),
      [RECENT_URL]: twoRecent(),
    });

    const { playing } = await spotifyWidget(env, { fetchImpl });
    expect(playing.artist).toBe("a, b, c");
  });

  test("recent tracks report when they were played, not a progress bar", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });

    const { recent } = await spotifyWidget(env, { fetchImpl });
    expect(Date.parse(recent[0].playedAt)).toBe(Date.parse("2026-08-19T10:00:00Z"));
    expect(recent[0].progressMs).toBeUndefined();
  });

  test("survives a podcast episode, which has a show instead of artists", async () => {
    const episode = {
      name: "some episode",
      duration_ms: 1000,
      show: { name: "some show", images: [{ url: "https://i.scdn.co/show", width: 300 }] },
      external_urls: { spotify: "https://open.spotify.com/episode/x" },
    };
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(episode),
      [RECENT_URL]: twoRecent(),
    });

    const { playing } = await spotifyWidget(env, { fetchImpl });
    expect(playing.title).toBe("some episode");
    expect(playing.artist).toBe("some show");
  });

  test("reports an empty widget rather than throwing when Spotify is down", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.serverError(),
      [RECENT_URL]: responses.serverError(),
    });

    const widget = await spotifyWidget(env, { fetchImpl });
    expect(widget).toEqual({ playing: null, recent: [] });
  });

  test("still shows the current track if only the recent-tracks call fails", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(track("first")),
      [RECENT_URL]: responses.serverError(),
    });

    const widget = await spotifyWidget(env, { fetchImpl });
    expect(widget.playing.title).toBe("first");
    expect(widget.recent).toEqual([]);
  });
});

describe("access tokens", () => {
  test("refreshes with the right grant and Basic credentials", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });

    await spotifyWidget(env, { fetchImpl });

    const [call] = fetchImpl.callsTo(TOKEN_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe(`Basic ${btoa("test-client-id:test-client-secret")}`);
    expect(String(call.body)).toContain("grant_type=refresh_token");
    expect(String(call.body)).toContain("refresh_token=test-refresh-token");
  });

  test("caches the access token so the next call skips the refresh", async () => {
    const routes = () => ({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });

    const first = stubFetch(routes());
    await spotifyWidget(env, { fetchImpl: first });
    expect(first.callsTo(TOKEN_URL)).toHaveLength(1);

    const second = stubFetch(routes());
    await spotifyWidget(env, { fetchImpl: second });
    expect(second.callsTo(TOKEN_URL)).toHaveLength(0);
  });

  test("sends the cached token as a Bearer credential", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });

    await spotifyWidget(env, { fetchImpl });

    const [call] = fetchImpl.callsTo(NOW_PLAYING_URL);
    expect(call.init.headers.Authorization).toBe("Bearer fresh-access-token");
  });

  test("stores a rotated refresh token and uses it next time", async () => {
    const first = stubFetch({
      [TOKEN_URL]: responses.token({ refresh_token: "rotated-refresh-token" }),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });
    await spotifyWidget(env, { fetchImpl: first });

    await env.CACHE.delete("spotify:access_token"); // force another refresh

    const second = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });
    await spotifyWidget(env, { fetchImpl: second });

    expect(String(second.callsTo(TOKEN_URL)[0].body)).toContain("refresh_token=rotated-refresh-token");
  });

  test("a cached token that Spotify rejects is refreshed once and the call retried", async () => {
    await env.CACHE.put("spotify:access_token", "stale-token");

    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: [responses.unauthorized(), responses.playing(track("first"))],
      [RECENT_URL]: [responses.unauthorized(), twoRecent()],
    });

    const widget = await spotifyWidget(env, { fetchImpl });

    expect(fetchImpl.callsTo(TOKEN_URL)).toHaveLength(1);
    expect(widget.playing.title).toBe("first");
  });

  test("gives up quietly if the refresh itself fails", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.serverError(),
      [NOW_PLAYING_URL]: responses.nothingPlaying(),
      [RECENT_URL]: twoRecent(),
    });

    expect(await spotifyWidget(env, { fetchImpl })).toEqual({ playing: null, recent: [] });
  });
});

describe("configuration", () => {
  test("reports an empty widget when Spotify is not configured at all", async () => {
    const bare = { ...env, SPOTIFY_REFRESH_TOKEN: undefined };
    const fetchImpl = stubFetch({});
    expect(await spotifyWidget(bare, { fetchImpl })).toEqual({ playing: null, recent: [] });
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------- the 5 second cache */

describe("the worker's own cache", () => {
  const routes = () => ({
    [TOKEN_URL]: responses.token(),
    [NOW_PLAYING_URL]: responses.playing(track("first")),
    [RECENT_URL]: twoRecent(),
  });

  beforeEach(async () => {
    await caches.default.delete(new Request(STATE_CACHE_KEY));
  });

  test("the first caller pays for the Spotify round trip", async () => {
    const fetchImpl = stubFetch(routes());
    const state = await spotifyState(env, { fetchImpl, now: 1000 });

    expect(state.playing.title).toBe("first");
    expect(state.staleMs).toBe(0);
    expect(fetchImpl.callsTo(NOW_PLAYING_URL)).toHaveLength(1);
  });

  test("a caller a second later gets the cached answer, and Spotify is untouched", async () => {
    await spotifyState(env, { fetchImpl: stubFetch(routes()), now: 1000 });

    const second = stubFetch(routes());
    const state = await spotifyState(env, { fetchImpl: second, now: 2000 });

    expect(state.playing.title).toBe("first");
    expect(second.calls).toHaveLength(0);
  });

  test("the cached answer reports how stale it is, so progress stays honest", async () => {
    await spotifyState(env, { fetchImpl: stubFetch(routes()), now: 10_000 });

    const state = await spotifyState(env, { fetchImpl: stubFetch(routes()), now: 13_500 });
    expect(state.staleMs).toBe(3500);
  });

  test("once it is older than the window, Spotify is asked again", async () => {
    await spotifyState(env, { fetchImpl: stubFetch(routes()), now: 1000 });

    const later = stubFetch(routes());
    const state = await spotifyState(env, { fetchImpl: later, now: 1000 + WIDGET_TTL_MS + 1 });

    expect(later.callsTo(NOW_PLAYING_URL)).toHaveLength(1);
    expect(state.staleMs).toBe(0);
  });

  test("a refetch replaces the entry rather than stacking up", async () => {
    await spotifyState(env, { fetchImpl: stubFetch(routes()), now: 1000 });

    const changed = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: responses.playing(track("second")),
      [RECENT_URL]: twoRecent(),
    });
    await spotifyState(env, { fetchImpl: changed, now: 1000 + WIDGET_TTL_MS + 1 });

    const after = await spotifyState(env, { fetchImpl: stubFetch(routes()), now: 1000 + WIDGET_TTL_MS + 100 });
    expect(after.playing.title).toBe("second");
  });

  test("many visitors at once still cost one Spotify round trip", async () => {
    const fetchImpl = stubFetch({
      [TOKEN_URL]: responses.token(),
      [NOW_PLAYING_URL]: Array.from({ length: 10 }, () => responses.playing(track("first"))),
      [RECENT_URL]: Array.from({ length: 10 }, () => twoRecent()),
    });

    await spotifyState(env, { fetchImpl, now: 1000 });
    for (let i = 0; i < 5; i++) await spotifyState(env, { fetchImpl, now: 1000 + i * 500 });

    expect(fetchImpl.callsTo(NOW_PLAYING_URL)).toHaveLength(1);
  });
});

describe("GET /api/spotify", () => {
  beforeEach(async () => {
    await caches.default.delete(new Request(STATE_CACHE_KEY));
  });

  test("returns the widget with its staleness", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://ira.lgbt/api/spotify"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("playing");
    expect(body).toHaveProperty("recent");
    expect(body).toHaveProperty("staleMs");
  });

  test("is never cached by the browser — the worker's cache is the shield", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://ira.lgbt/api/spotify"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
});
