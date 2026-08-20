// Markup for the Spotify widget.
//
// Imported by the Worker, which renders the widget into the page before it is
// ever sent, and by the browser, which re-renders it as the track changes.
// One implementation so the two can never drift into looking different.
//
// Everything here builds an HTML string, so every value that came from Spotify
// goes through escapeHtml, and every URL is checked to be https before it is
// allowed into an href or a src.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Only https URLs are ever emitted — never a javascript: or data: one. */
function safeUrl(value) {
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

/** m:ss, counting on past an hour rather than wrapping around. */
export function formatTime(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "";

  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "";

  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/**
 * Where playback had reached by the time this HTML was built.
 *
 * The snapshot may have come from the Worker's cache, so `staleMs` is added on
 * — otherwise a listener who loads the page four seconds into a cached
 * response would see the bar jump backwards.
 */
export function elapsedMs(playing, staleMs = 0) {
  return Math.min(playing.durationMs ?? Infinity, (playing.progressMs ?? 0) + staleMs);
}

/**
 * Where the bar should be right now, given the last thing Spotify told us.
 *
 * Playback is derived from an anchor and the wall clock rather than counted up
 * by a timer, so a throttled background tab or a missed tick corrects itself
 * on the very next frame instead of drifting further behind.
 */
export function playbackAt(anchor, now = Date.now()) {
  const since = Math.max(0, now - anchor.at);
  const elapsed = Math.min(anchor.durationMs, anchor.progressMs + since);

  return {
    elapsed,
    percent: Math.min(100, (elapsed / anchor.durationMs) * 100),
    label: formatTime(elapsed),
    ended: elapsed >= anchor.durationMs,
  };
}

function artHtml(track) {
  const art = safeUrl(track.art);
  return art
    ? `<img class="track-art" src="${escapeHtml(art)}" alt="" loading="lazy">`
    : `<div class="track-art track-art-blank"></div>`;
}

function titleHtml(track) {
  const url = safeUrl(track.url);
  const title = escapeHtml(track.title);

  return url
    ? `<a class="track-title" href="${escapeHtml(url)}" target="_blank" rel="noopener">${title}</a>`
    : `<span class="track-title">${title}</span>`;
}

/**
 * The progress bar and clock, rendered only for the track actually playing.
 * The data- attributes are the anchor the browser animates from between polls.
 */
function progressHtml(playing, staleMs) {
  const duration = playing.durationMs;
  if (!duration) return "";

  const elapsed = elapsedMs(playing, staleMs);
  const percent = Math.min(100, (elapsed / duration) * 100);

  return (
    `<div class="track-progress" data-duration="${duration}" data-progress="${elapsed}">` +
    `<div class="track-bar"><div class="track-bar-fill" style="width:${percent}%"></div></div>` +
    `<div class="track-times muted">` +
    `<span class="track-elapsed">${formatTime(elapsed)}</span>` +
    `<span class="track-duration">${formatTime(duration)}</span>` +
    `</div></div>`
  );
}

function trackHtml(track, { live, staleMs }) {
  const badge = live ? "now playing" : timeAgo(track.playedAt);

  return (
    `<div class="track${live ? " track-live" : ""}">` +
    artHtml(track) +
    `<div class="track-lines">` +
    `<span class="track-badge">${escapeHtml(badge)}</span>` +
    titleHtml(track) +
    `<div class="track-meta muted">${escapeHtml(track.artist)}</div>` +
    `</div>` +
    (live ? progressHtml(track, staleMs) : "") +
    `</div>`
  );
}

/** The inner HTML of #spotify-tracks. Empty string when there is nothing. */
export function renderTracks({ playing, recent = [], staleMs = 0 }) {
  const rows = [
    ...(playing ? [trackHtml(playing, { live: true, staleMs })] : []),
    ...recent.map((track) => trackHtml(track, { live: false, staleMs })),
  ];

  return rows.join("");
}

export const hasTracks = ({ playing, recent = [] }) => Boolean(playing) || recent.length > 0;
