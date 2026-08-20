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

describe("how much of the history is on show", () => {
  const history = (n) =>
    Array.from({ length: n }, (_, i) =>
      track({ title: `old ${i + 1}`, playedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString() }),
    );

  const rowsIn = (html) => html.match(/<div class="track(?:\s|")/g)?.length ?? 0;
  const visiblePart = (html) => html.split("<details")[0];
  const hiddenPart = (html) => html.split("<details")[1] ?? "";

  test("nothing playing: three recent tracks are visible", () => {
    const html = renderTracks({ playing: null, recent: history(20), staleMs: 0 });
    expect(rowsIn(visiblePart(html))).toBe(3);
    expect(visiblePart(html)).toContain("old 3");
    expect(visiblePart(html)).not.toContain("old 4");
  });

  test("something playing: the current track plus two recent ones", () => {
    const html = renderTracks({
      playing: track({ title: "right now", progressMs: 0 }),
      recent: history(20),
      staleMs: 0,
    });

    expect(rowsIn(visiblePart(html))).toBe(3);
    expect(visiblePart(html)).toContain("right now");
    expect(visiblePart(html)).toContain("old 2");
    expect(visiblePart(html)).not.toContain("old 3");
  });

  test("the rest go behind a dropdown", () => {
    const html = renderTracks({ playing: null, recent: history(20), staleMs: 0 });

    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(rowsIn(hiddenPart(html))).toBe(17);
    expect(hiddenPart(html)).toContain("old 20");
  });

  test("the dropdown says how many it is hiding", () => {
    const playing = renderTracks({
      playing: track({ title: "right now", progressMs: 0 }),
      recent: history(20),
      staleMs: 0,
    });
    expect(playing).toContain("18 more");

    const idle = renderTracks({ playing: null, recent: history(20), staleMs: 0 });
    expect(idle).toContain("17 more");
  });

  test("every one of the twenty is rendered somewhere", () => {
    const html = renderTracks({ playing: null, recent: history(20), staleMs: 0 });
    expect(rowsIn(html)).toBe(20);
    for (let i = 1; i <= 20; i++) expect(html).toContain(`old ${i}`);
  });

  test("the dropdown is closed to begin with", () => {
    const html = renderTracks({ playing: null, recent: history(20), staleMs: 0 });
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  test("no dropdown at all when everything already fits", () => {
    const html = renderTracks({ playing: null, recent: history(3), staleMs: 0 });
    expect(html).not.toContain("<details");
    expect(rowsIn(html)).toBe(3);
  });

  test("no dropdown when there is exactly one row too few to need one", () => {
    const html = renderTracks({
      playing: track({ title: "right now", progressMs: 0 }),
      recent: history(2),
      staleMs: 0,
    });
    expect(html).not.toContain("<details");
  });

  test("a single hidden track is announced in the singular", () => {
    const html = renderTracks({ playing: null, recent: history(4), staleMs: 0 });
    expect(html).toContain("1 more");
    expect(html).not.toContain("1 mores");
  });

  test("copes with less history than there are slots", () => {
    const html = renderTracks({ playing: null, recent: history(1), staleMs: 0 });
    expect(rowsIn(html)).toBe(1);
    expect(html).not.toContain("<details");
  });

  test("only the playing track is live, however deep the list", () => {
    const html = renderTracks({
      playing: track({ title: "right now", progressMs: 0 }),
      recent: history(20),
      staleMs: 0,
    });
    expect(html.match(/track-live/g)).toHaveLength(1);
  });

  test("hidden tracks are escaped too", () => {
    const nasty = history(20);
    nasty[19] = track({ title: "<img src=x onerror=alert(1)>", playedAt: new Date().toISOString() });

    const html = renderTracks({ playing: null, recent: nasty, staleMs: 0 });
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x");
  });
});
