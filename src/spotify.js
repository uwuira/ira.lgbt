// The "what ira is listening to" widget.
//
// Spotify's refresh token is long-lived and lives in a Worker secret. Access
// tokens last an hour and live in KV, so a burst of visitors shares one
// refresh rather than each triggering their own.
//
// Nothing here ever fails loudly: a dead Spotify API should leave the rest of
// the page intact, so every failure path degrades to an empty widget.

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";
const RECENT_URL = "https://api.spotify.com/v1/me/player/recently-played";

const ACCESS_TOKEN_KEY = "spotify:access_token";
const REFRESH_TOKEN_KEY = "spotify:refresh_token";

// Visitors poll every few seconds so the progress bar stays honest, but
// Spotify must not see that traffic. Every visitor shares one snapshot for
// this long, so the API call rate is capped no matter how many people are
// looking at the page.
export const WIDGET_TTL_MS = 5000;

// A Worker-side cache entry, not a real route. Nothing is ever served from
// this URL — it is only ever a key into caches.default.
export const STATE_CACHE_KEY = "https://spotify-widget.ira.lgbt/state";

const FETCHED_AT_HEADER = "x-fetched-at";

const EMPTY = { playing: null, recent: [] };

/** Spotify may hand back a new refresh token; if it ever did, KV wins. */
async function refreshToken(env) {
  return (await env.CACHE.get(REFRESH_TOKEN_KEY)) ?? env.SPOTIFY_REFRESH_TOKEN;
}

async function mintAccessToken(env, fetchImpl) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: await refreshToken(env),
  });

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`spotify token refresh failed: ${res.status}`);

  const data = await res.json();

  // KV's floor for expirationTtl is 60s; the 60s safety margin below keeps us
  // above it for any real token lifetime.
  await env.CACHE.put(ACCESS_TOKEN_KEY, data.access_token, {
    expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 60),
  });

  if (data.refresh_token) await env.CACHE.put(REFRESH_TOKEN_KEY, data.refresh_token);

  return data.access_token;
}

async function accessToken(env, fetchImpl) {
  return (await env.CACHE.get(ACCESS_TOKEN_KEY)) ?? (await mintAccessToken(env, fetchImpl));
}

/**
 * A cached access token can be revoked or expire early. On a 401 we mint a new
 * one and replay the request exactly once — never in a loop, so a permanently
 * rejected credential cannot spin.
 */
async function callSpotify(url, env, fetchImpl, tokenRef) {
  const send = (token) => fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });

  let res = await send(tokenRef.token);
  if (res.status === 401) {
    // The two API calls run concurrently, so a stale token 401s both of them
    // at once. Sharing one in-flight refresh keeps that from becoming two
    // refreshes, the second of which would invalidate the first.
    tokenRef.refreshing ??= (async () => {
      await env.CACHE.delete(ACCESS_TOKEN_KEY);
      return mintAccessToken(env, fetchImpl);
    })();
    res = await send(await tokenRef.refreshing);
  }
  return res;
}

function pickArt(images = []) {
  // Spotify sorts these largest first. 300px is the sweet spot for a widget:
  // sharp on a retina display without shipping a 640px album cover.
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((image) => (image.width ?? 0) >= 300) ?? sorted.at(-1))?.url ?? null;
}

/** Flattens a Spotify track *or* podcast episode into what the UI renders. */
function toTrack(item, extra = {}) {
  if (!item?.name) return null;

  return {
    title: item.name,
    // Episodes have a show where tracks have artists.
    artist: item.artists?.map((artist) => artist.name).join(", ") ?? item.show?.name ?? "",
    album: item.album?.name ?? item.show?.name ?? "",
    url: item.external_urls?.spotify ?? null,
    art: pickArt(item.album?.images ?? item.show?.images),
    durationMs: item.duration_ms ?? null,
    ...extra,
  };
}

/**
 * What is playing now, plus enough history to always show two things:
 * one current + one previous, or the last two played.
 */
export async function spotifyWidget(env, { fetchImpl = fetch } = {}) {
  // Every credential is needed, so a missing one means the widget is simply
  // not set up — show nothing rather than calling Spotify with a half-config.
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !(await refreshToken(env))) {
    return EMPTY;
  }

  try {
    const tokenRef = { token: await accessToken(env, fetchImpl), refreshing: null };

    const [nowRes, recentRes] = await Promise.all([
      callSpotify(`${NOW_PLAYING_URL}?additional_types=track,episode`, env, fetchImpl, tokenRef),
      callSpotify(`${RECENT_URL}?limit=2`, env, fetchImpl, tokenRef),
    ]);

    let playing = null;
    // 204 means the player is idle — an expected answer, not a failure.
    if (nowRes.status === 200) {
      const data = await nowRes.json();
      if (data.is_playing) playing = toTrack(data.item, { progressMs: data.progress_ms ?? 0 });
    }

    let history = [];
    if (recentRes.ok) {
      const data = await recentRes.json();
      history = (data.items ?? [])
        .map((entry) => toTrack(entry.track, { playedAt: entry.played_at }))
        .filter(Boolean);
    }

    // Two slots total. A current track takes one of them.
    return { playing, recent: history.slice(0, playing ? 1 : 2) };
  } catch {
    return EMPTY;
  }
}

/**
 * The widget, plus how old the snapshot is.
 *
 * A hit inside the window is returned as-is with its age; anything older is
 * refetched. `staleMs` is what lets the browser start its progress bar from
 * the right place instead of from wherever playback was when the snapshot was
 * taken.
 *
 * `now` and `cache` are injectable so the window has a testable clock.
 */
export async function spotifyState(
  env,
  { fetchImpl = fetch, cache = caches.default, now = Date.now() } = {},
) {
  const key = new Request(STATE_CACHE_KEY);
  const hit = await cache.match(key);

  if (hit) {
    const fetchedAt = Number(hit.headers.get(FETCHED_AT_HEADER));
    const staleMs = now - fetchedAt;

    // A negative age means the clock moved backwards; treat it as a miss
    // rather than reporting a snapshot from the future.
    if (Number.isFinite(fetchedAt) && staleMs >= 0 && staleMs < WIDGET_TTL_MS) {
      return { ...(await hit.json()), staleMs };
    }
  }

  const widget = await spotifyWidget(env, { fetchImpl });

  await cache.put(
    key,
    new Response(JSON.stringify(widget), {
      headers: {
        "content-type": "application/json",
        "cache-control": `max-age=${Math.round(WIDGET_TTL_MS / 1000)}`,
        [FETCHED_AT_HEADER]: String(now),
      },
    }),
  );

  return { ...widget, staleMs: 0 };
}

export async function handleSpotify(request, env) {
  const state = await spotifyState(env);

  return new Response(JSON.stringify(state), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The Worker's cache above is what shields Spotify. The browser must
      // not keep its own copy: a stale one would carry a stale `staleMs` and
      // the progress bar would silently drift.
      "cache-control": "no-store",
    },
  });
}
