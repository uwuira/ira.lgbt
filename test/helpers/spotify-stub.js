// A stand-in for Spotify's API. Routes by URL, records every call, and lets a
// test queue a different response for the second call to the same endpoint
// (which is how the 401-then-retry path gets exercised).

export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const NOW_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";
export const RECENT_URL = "https://api.spotify.com/v1/me/player/recently-played";

export function track(name, artist = "some artist") {
  return {
    name,
    duration_ms: 210_000,
    artists: [{ name: artist }],
    album: {
      name: `${name} - single`,
      images: [
        { url: `https://i.scdn.co/${name}-640`, width: 640, height: 640 },
        { url: `https://i.scdn.co/${name}-300`, width: 300, height: 300 },
        { url: `https://i.scdn.co/${name}-64`, width: 64, height: 64 },
      ],
    },
    external_urls: { spotify: `https://open.spotify.com/track/${name}` },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * `routes` maps a URL prefix to either a Response or an array of Responses
 * consumed one per call.
 */
export function stubFetch(routes) {
  const calls = [];

  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init, body: init.body ?? null });

    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unstubbed request to ${url}`);

    const route = routes[key];
    const response = Array.isArray(route) ? (route.shift() ?? route.at(-1)) : route;
    if (!response) throw new Error(`no queued response left for ${url}`);
    return response.clone ? response.clone() : response;
  };

  fetchImpl.calls = calls;
  fetchImpl.callsTo = (prefix) => calls.filter((call) => call.url.startsWith(prefix));
  return fetchImpl;
}

export const responses = {
  token: (overrides = {}) => json({ access_token: "fresh-access-token", expires_in: 3600, ...overrides }),
  nothingPlaying: () => new Response(null, { status: 204 }),
  playing: (item, extra = {}) => json({ is_playing: true, progress_ms: 45_000, item, ...extra }),
  recent: (items) =>
    json({
      items: items.map(([item, playedAt]) => ({ track: item, played_at: playedAt })),
    }),
  unauthorized: () => json({ error: { status: 401, message: "The access token expired" } }, 401),
  serverError: () => json({ error: { status: 503 } }, 503),
};
