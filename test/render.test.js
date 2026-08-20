import { describe, expect, test } from "vitest";

import { escapeHtml, formatTime, playbackAt, renderTracks, timeAgo } from "../public/render.js";

const track = (over = {}) => ({
  title: "some song",
  artist: "some artist",
  album: "some album",
  url: "https://open.spotify.com/track/abc",
  art: "https://i.scdn.co/abc",
  durationMs: 210_000,
  ...over,
});

describe("formatTime", () => {
  test("renders m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(45_000)).toBe("0:45");
    expect(formatTime(210_000)).toBe("3:30");
    expect(formatTime(65_000)).toBe("1:05");
  });

  test("pads seconds to two digits", () => {
    expect(formatTime(61_000)).toBe("1:01");
  });

  test("keeps counting past an hour rather than wrapping", () => {
    expect(formatTime(3_660_000)).toBe("61:00");
  });

  test("is blank for a duration we do not know", () => {
    expect(formatTime(null)).toBe("");
    expect(formatTime(undefined)).toBe("");
  });

  test("never renders a negative time", () => {
    expect(formatTime(-5000)).toBe("0:00");
  });
});

describe("escapeHtml", () => {
  test("neutralises everything that could break out of markup", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  test("leaves ordinary text alone", () => {
    expect(escapeHtml("bocchi the rock!")).toBe("bocchi the rock!");
  });
});

describe("renderTracks", () => {
  test("renders the playing track with a live badge", () => {
    const html = renderTracks({ playing: track({ progressMs: 45_000 }), recent: [], staleMs: 0 });
    expect(html).toContain("track-live");
    expect(html).toContain("now playing");
    expect(html).toContain("some song");
  });

  test("shows elapsed and total time", () => {
    const html = renderTracks({ playing: track({ progressMs: 45_000 }), recent: [], staleMs: 0 });
    expect(html).toContain("0:45");
    expect(html).toContain("3:30");
  });

  test("advances elapsed by however stale the cached snapshot is", () => {
    const html = renderTracks({ playing: track({ progressMs: 45_000 }), recent: [], staleMs: 4000 });
    expect(html).toContain("0:49");
  });

  test("carries duration and progress as data for the client to animate from", () => {
    const html = renderTracks({ playing: track({ progressMs: 45_000 }), recent: [], staleMs: 1000 });
    expect(html).toMatch(/data-duration="210000"/);
    expect(html).toMatch(/data-progress="46000"/);
  });

  test("sets the bar width to the elapsed fraction", () => {
    const html = renderTracks({ playing: track({ progressMs: 105_000 }), recent: [], staleMs: 0 });
    expect(html).toMatch(/width:\s*50(\.0+)?%/);
  });

  test("never lets the bar exceed full", () => {
    const html = renderTracks({ playing: track({ progressMs: 999_000 }), recent: [], staleMs: 0 });
    expect(html).toMatch(/width:\s*100(\.0+)?%/);
  });

  test("renders recent tracks with how long ago they played", () => {
    const playedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = renderTracks({ playing: null, recent: [track({ playedAt })], staleMs: 0 });
    expect(html).toContain("5m ago");
    expect(html).not.toContain("track-live");
  });

  test("gives a track with no art a placeholder rather than a broken image", () => {
    const html = renderTracks({ playing: null, recent: [track({ art: null })], staleMs: 0 });
    expect(html).toContain("track-art-blank");
    expect(html).not.toContain("<img");
  });

  test("is empty when there is nothing to show", () => {
    expect(renderTracks({ playing: null, recent: [], staleMs: 0 })).toBe("");
  });
});

describe("renderTracks is not an injection hole", () => {
  test("escapes a title containing markup", () => {
    const html = renderTracks({
      playing: track({ title: '<img src=x onerror=alert(1)>', progressMs: 0 }),
      recent: [],
      staleMs: 0,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("escapes an artist containing a quote that would break an attribute", () => {
    const html = renderTracks({
      playing: null,
      recent: [track({ artist: '" onmouseover="alert(1)', playedAt: new Date().toISOString() })],
      staleMs: 0,
    });
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  test("refuses a javascript: url instead of linking it", () => {
    const html = renderTracks({
      playing: null,
      // eslint-disable-next-line no-script-url
      recent: [track({ url: "javascript:alert(1)", playedAt: new Date().toISOString() })],
      staleMs: 0,
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
  });

  test("refuses non-https art rather than embedding it", () => {
    const html = renderTracks({
      playing: null,
      recent: [
        track({ art: "javascript:alert(1)", playedAt: new Date().toISOString() }),
      ],
      staleMs: 0,
    });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("track-art-blank");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const ago = (ms) => timeAgo(new Date(now - ms).toISOString(), now);

  test("reads naturally at each scale", () => {
    expect(ago(20_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
  });

  test("is blank when there is no timestamp", () => {
    expect(timeAgo(null, now)).toBe("");
  });
});

describe("playbackAt — what the bar draws between polls", () => {
  const anchor = { progressMs: 45_000, durationMs: 210_000, at: 1_000_000 };

  test("advances in real time from where the snapshot left off", () => {
    expect(playbackAt(anchor, 1_000_000).elapsed).toBe(45_000);
    expect(playbackAt(anchor, 1_003_000).elapsed).toBe(48_000);
    expect(playbackAt(anchor, 1_010_000).elapsed).toBe(55_000);
  });

  test("reports the fraction the bar should fill", () => {
    expect(playbackAt({ ...anchor, progressMs: 105_000 }, 1_000_000).percent).toBeCloseTo(50);
  });

  test("gives a ready-made clock label", () => {
    expect(playbackAt(anchor, 1_003_000).label).toBe("0:48");
  });

  test("stops at the end of the track instead of running past it", () => {
    const done = playbackAt(anchor, 1_000_000 + 600_000);
    expect(done.elapsed).toBe(210_000);
    expect(done.percent).toBe(100);
    expect(done.ended).toBe(true);
  });

  test("is not ended while the track is still going", () => {
    expect(playbackAt(anchor, 1_005_000).ended).toBe(false);
  });

  test("never goes backwards if the clock jumps behind the anchor", () => {
    const back = playbackAt(anchor, 900_000);
    expect(back.elapsed).toBe(45_000);
    expect(back.percent).toBeGreaterThanOrEqual(0);
  });
});
