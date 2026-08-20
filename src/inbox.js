// The anonymous inbox: a message, a drawing, or both.
//
// Submissions are private — nothing here is ever served back to the public
// site, so a submission cannot become a defacement. The only defences that
// matter are therefore about volume and about being able to shut one person
// off, which is what the blocklist and the rate limits below do.

import { hashIp, readSender, senderCookie } from "./lib/sender.js";

export const LIMITS = {
  text: 1000,
  drawingBytes: 512 * 1024,
  perSenderPerHour: 5,
  perIpPerHour: 12,
};

const HOUR_MS = 60 * 60 * 1000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** Decodes a canvas export — bare base64 or a full `data:` URL — to bytes. */
function decodeDrawing(value) {
  if (typeof value !== "string" || !value) return { error: "drawing must be a string" };

  const base64 = value.startsWith("data:")
    ? (value.split(",", 2)[1] ?? "")
    : value;

  // Reject before decoding: base64 inflates by 4/3, so this bounds the work.
  if (base64.length > Math.ceil((LIMITS.drawingBytes * 4) / 3) + 64) {
    return { error: "drawing is too large" };
  }

  let bytes;
  try {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return { error: "drawing is not valid base64" };
  }

  if (bytes.length > LIMITS.drawingBytes) return { error: "drawing is too large" };
  if (bytes.length < PNG_MAGIC.length) return { error: "drawing is not a PNG" };

  // The canvas only ever produces PNG, so anything else is not from the widget.
  if (PNG_MAGIC.some((byte, i) => bytes[i] !== byte)) return { error: "drawing is not a PNG" };

  return { bytes };
}

function validate(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "expected a JSON object" };
  }

  let text = null;
  if (body.text !== undefined && body.text !== null) {
    if (typeof body.text !== "string") return { error: "text must be a string" };
    text = body.text.trim();
    if (text.length > LIMITS.text) return { error: `text is longer than ${LIMITS.text} characters` };
    if (!text) text = null;
  }

  let drawing = null;
  if (body.drawing !== undefined && body.drawing !== null) {
    const decoded = decodeDrawing(body.drawing);
    if (decoded.error) return decoded;
    drawing = decoded.bytes;
  }

  if (!text && !drawing) return { error: "send a message, a drawing, or both" };

  return { text, drawing };
}

/** Blocks are checked in one round trip — a spammer is usually both. */
async function findBlock(env, senderId, ipHash) {
  return env.DB.prepare(
    "SELECT kind FROM blocks WHERE (kind = 'sender' AND value = ?1) OR (kind = 'ip' AND value = ?2) LIMIT 1",
  )
    .bind(senderId, ipHash)
    .first();
}

/**
 * Two independent ceilings. The sender limit is the honest one; the ip limit
 * is what catches somebody who noticed that clearing cookies resets it.
 */
async function rateLimit(env, senderId, ipHash, now) {
  const since = now - HOUR_MS;

  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) FILTER (WHERE sender_id = ?1) AS by_sender,
       COUNT(*) FILTER (WHERE ip_hash = ?2)   AS by_ip
     FROM submissions
     WHERE created_at > ?3`,
  )
    .bind(senderId, ipHash, since)
    .first();

  const exceeded =
    counts.by_sender >= LIMITS.perSenderPerHour || counts.by_ip >= LIMITS.perIpPerHour;
  if (!exceeded) return null;

  // Tell them when the window frees up rather than leaving them guessing.
  const oldest = await env.DB.prepare(
    `SELECT MIN(created_at) AS at FROM submissions
     WHERE created_at > ?3 AND (sender_id = ?1 OR ip_hash = ?2)`,
  )
    .bind(senderId, ipHash, since)
    .first();

  const retryAfter = Math.max(1, Math.ceil((oldest.at + HOUR_MS - now) / 1000));
  return { retryAfter };
}

export async function handleInbox(request, env) {
  if (request.method !== "POST") {
    return json({ error: "send it with POST" }, 405, { allow: "POST" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected a JSON object" }, 400);
  }

  const submission = validate(body);
  if (submission.error) return json({ error: submission.error }, 400);

  const sender = await readSender(request, env);
  const ipHash = await hashIp(request.headers.get("CF-Connecting-IP"), env.IP_SALT);

  // Always hand back the cookie, even on a refusal: without it a rejected
  // sender gets a fresh identity on their next try and the sender-level
  // limits never bite.
  const headers = sender.isNew ? { "set-cookie": senderCookie(sender.token) } : {};

  if (await findBlock(env, sender.id, ipHash)) {
    return json({ error: "you can't send messages" }, 403, headers);
  }

  const now = Date.now();
  const limited = await rateLimit(env, sender.id, ipHash, now);
  if (limited) {
    return json({ error: "slow down a little", retryAfter: limited.retryAfter }, 429, {
      ...headers,
      "retry-after": String(limited.retryAfter),
    });
  }

  const id = crypto.randomUUID();
  let drawingKey = null;

  if (submission.drawing) {
    drawingKey = `drawings/${id}.png`;
    await env.DRAWINGS.put(drawingKey, submission.drawing, {
      httpMetadata: { contentType: "image/png" },
    });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO submissions (id, created_at, sender_id, ip_hash, text, drawing_key, user_agent, country)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        id,
        now,
        sender.id,
        ipHash,
        submission.text,
        drawingKey,
        request.headers.get("user-agent")?.slice(0, 300) ?? null,
        request.cf?.country ?? null,
      )
      .run();
  } catch (error) {
    // Don't leave the drawing orphaned in R2 if the row never landed.
    if (drawingKey) await env.DRAWINGS.delete(drawingKey);
    throw error;
  }

  return json({ ok: true, id }, 201, headers);
}
