// The two interactive bits of the page: what ira is listening to, and the
// thing you can send her. Both fail quietly — if either endpoint is down the
// rest of the page is unaffected, and the widget just hides itself.

import { elapsedMs, hasTracks, playbackAt, renderTracks } from "/render.js";

const $ = (selector) => document.querySelector(selector);

/* ---------------------------------------------------------------- spotify */

// The page already arrives with the widget rendered into it, so nothing here
// is about getting something on screen — it is about keeping it true. The bar
// advances locally every tick, and a poll every few seconds re-anchors it to
// what Spotify actually says.

const SPOTIFY_POLL_MS = 5000;
const TICK_MS = 250;

// Where playback was, and when we learned that. Everything the bar draws is
// derived from these two numbers rather than from a timer that counts up.
let anchor = null;
let shape = null;
let polling = false;

const anchorFrom = (state) => {
  const playing = state.playing;
  if (!playing?.durationMs) return null;

  return {
    progressMs: elapsedMs(playing, state.staleMs ?? 0),
    durationMs: playing.durationMs,
    at: Date.now(),
  };
};

/**
 * The markup a state would produce with playback held still.
 *
 * Re-rendering on every poll would rebuild the album art four times a minute
 * and make it flicker, so the DOM is only replaced when something other than
 * the progress actually changed — a new track, or a recent one ageing.
 */
const shapeOf = (state) =>
  renderTracks({
    ...state,
    playing: state.playing ? { ...state.playing, progressMs: 0 } : null,
    staleMs: 0,
  });

function applyState(state) {
  const section = $("#spotify");
  if (!section) return;

  if (!hasTracks(state)) {
    section.hidden = true;
    anchor = null;
    shape = null;
    return;
  }

  section.hidden = false;

  const next = shapeOf(state);
  if (next !== shape) {
    $("#spotify-tracks").innerHTML = renderTracks(state);
    shape = next;
  }

  anchor = anchorFrom(state);
}

/** Moves the bar between polls, so it is never frozen waiting for one. */
function tick() {
  if (!anchor) return;

  const fill = document.querySelector(".track-live .track-bar-fill");
  const label = document.querySelector(".track-live .track-elapsed");
  if (!fill) return;

  const at = playbackAt(anchor);
  fill.style.width = `${at.percent}%`;
  if (label) label.textContent = at.label;

  // The track just ran out, so whatever is playing now is something else.
  if (at.ended) {
    anchor = null;
    loadSpotify();
  }
}

async function loadSpotify() {
  if (polling) return;
  polling = true;

  try {
    const res = await fetch("/api/spotify");
    if (!res.ok) throw new Error(String(res.status));
    applyState(await res.json());
  } catch {
    // Leave whatever is on screen alone. A blip should not blank the widget.
  } finally {
    polling = false;
  }
}

function setupSpotify() {
  const section = $("#spotify");
  if (!section) return;

  // The server rendered the rows already; read the snapshot it rendered them
  // from so the bar can start moving without waiting for the first poll.
  try {
    const initial = JSON.parse(document.getElementById("spotify-state")?.textContent ?? "null");
    if (initial) {
      anchor = anchorFrom(initial);
      shape = shapeOf(initial);
    }
  } catch {
    // No usable snapshot; the first poll will fill everything in.
  }

  setInterval(tick, TICK_MS);
  setInterval(() => {
    if (document.visibilityState === "visible") loadSpotify();
  }, SPOTIFY_POLL_MS);

  // Coming back to the tab, the bar is however stale the tab was old.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadSpotify();
  });
}

/* ------------------------------------------------------------------ canvas */

const CANVAS_W = 800;
const CANVAS_H = 500;
const PAPER = "#0d0d0d";
const UNDO_DEPTH = 20;

function setupCanvas() {
  const canvas = $("#draw");
  if (!canvas) return null;

  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const undoStack = [];
  let dirty = false;
  let drawing = false;
  let erasing = false;

  const fill = () => {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  };
  fill();

  const snapshot = () => {
    undoStack.push(canvas.toDataURL("image/png"));
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    $("#undo").disabled = false;
  };

  // The canvas is displayed scaled down, so pointer coordinates need mapping
  // back onto the 800x500 backing store or strokes land in the wrong place.
  const pointAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const stroke = (from, to) => {
    ctx.strokeStyle = erasing ? PAPER : $("#pen-color").value;
    ctx.lineWidth = Number($("#pen-size").value) * (erasing ? 2.5 : 1);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  let last = null;

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    snapshot();
    drawing = true;
    dirty = true;
    last = pointAt(event);
    stroke(last, last); // a tap should leave a dot
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    event.preventDefault();
    const next = pointAt(event);
    stroke(last, next);
    last = next;
  });

  // Not pointerleave: the pointer is captured, so dragging briefly outside the
  // canvas and back should continue the stroke rather than cut it.
  for (const type of ["pointerup", "pointercancel"]) {
    canvas.addEventListener(type, () => {
      drawing = false;
    });
  }

  const restore = (dataUrl) =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        ctx.drawImage(image, 0, 0);
        resolve();
      };
      image.src = dataUrl;
    });

  $("#undo").onclick = async () => {
    const previous = undoStack.pop();
    if (!previous) return;
    fill();
    await restore(previous);
    $("#undo").disabled = !undoStack.length;
    // Undoing back to the very first snapshot means the canvas is blank again.
    if (!undoStack.length) dirty = false;
  };

  // Clear starts over rather than becoming an undo step: undoing back past a
  // clear would restore the drawing but leave it flagged as untouched, and it
  // would then be silently dropped on send.
  $("#clear").onclick = () => {
    fill();
    undoStack.length = 0;
    dirty = false;
    $("#undo").disabled = true;
  };

  const eraser = $("#eraser");
  eraser.onclick = () => {
    erasing = !erasing;
    eraser.setAttribute("aria-pressed", String(erasing));
    eraser.textContent = erasing ? "erasing" : "eraser";
  };

  return {
    // Only send a drawing if something was actually drawn — an untouched
    // canvas would otherwise arrive as a blank rectangle.
    export: () => (dirty ? canvas.toDataURL("image/png") : null),
    reset: () => {
      fill();
      undoStack.length = 0;
      dirty = false;
      $("#undo").disabled = true;
    },
  };
}

/* ------------------------------------------------------------------- inbox */

function setupInbox() {
  const form = $("#inbox-form");
  if (!form) return;

  const canvas = setupCanvas();
  const status = $("#inbox-status");
  const button = $("#inbox-send");
  const text = $("#inbox-text");

  const say = (message, tone = "") => {
    status.textContent = message;
    status.className = `inbox-status ${tone}`;
  };

  text.addEventListener("input", () => {
    $("#inbox-count").textContent = `${text.value.length}/1000`;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const drawing = canvas?.export() ?? null;
    const message = text.value.trim();

    if (!message && !drawing) {
      say("write something or draw something first", "bad");
      return;
    }

    button.disabled = true;
    say("sending…");

    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ text: message || null, drawing }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        say("sent — thank you ♡", "good");
        text.value = "";
        $("#inbox-count").textContent = "0/1000";
        canvas?.reset();
      } else if (res.status === 429) {
        say(data.error ?? "too many messages, try later", "bad");
      } else if (res.status === 403) {
        say("you can't send messages", "bad");
      } else {
        say(data.error ?? "that didn't work", "bad");
      }
    } catch {
      say("couldn't reach the server", "bad");
    } finally {
      button.disabled = false;
    }
  });
}

/* -------------------------------------------------------------------- boot */

setupSpotify();
setupInbox();
