// The private side: reading the inbox and cutting people off.
//
// Cloudflare Access does the authenticating — there is no password here, and
// no session of our own. What this module does is refuse to believe the
// request came through Access unless the Access JWT actually verifies.

import { authenticateAdmin } from "./lib/access.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const BLOCK_KINDS = new Set(["sender", "ip"]);

// Nothing under /admin should ever be cached by a browser or a proxy, and
// none of it should ever be indexed.
const PRIVATE_HEADERS = {
  "cache-control": "no-store, private",
  "x-robots-tag": "noindex, nofollow",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...PRIVATE_HEADERS,
      ...headers,
    },
  });

/** decodeURIComponent throws on a malformed escape; a bad id is just a miss. */
function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function toSubmission(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    text: row.text,
    drawingUrl: row.drawing_key ? `/admin/drawing/${row.id}` : null,
    senderId: row.sender_id,
    ipHash: row.ip_hash,
    userAgent: row.user_agent,
    readAt: row.read_at,
  };
}

async function listSubmissions(url, env) {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(url.searchParams.get("limit")) || PAGE_SIZE),
  );

  // Keyset pagination on created_at: stable even as new submissions arrive
  // at the top while you are reading further down.
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;

  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(cursor, limit)
    .all();

  const unread = await unreadCount(env);

  return json({
    submissions: results.map(toSubmission),
    // Only offer a cursor when the page was full; anything less is the end.
    cursor: results.length === limit ? results.at(-1).created_at : null,
    unread,
  });
}

async function serveDrawing(env, id) {
  // The id is only ever used to look up a row, and the R2 key comes from that
  // row — a crafted id can never address an arbitrary object in the bucket.
  const row = await env.DB.prepare("SELECT drawing_key FROM submissions WHERE id = ?1")
    .bind(id)
    .first();

  if (!row?.drawing_key) return json({ error: "not found" }, 404);

  const object = await env.DRAWINGS.get(row.drawing_key);
  if (!object) return json({ error: "not found" }, 404);

  return new Response(object.body, {
    headers: {
      "content-type": "image/png",
      // The bytes are only known to start with a PNG header, so forbid
      // sniffing them into anything else.
      "x-content-type-options": "nosniff",
      ...PRIVATE_HEADERS,
    },
  });
}

async function block(request, env) {
  const body = await readJson(request);
  const kind = body?.kind;
  const value = typeof body?.value === "string" ? body.value.trim() : "";

  if (!BLOCK_KINDS.has(kind)) return json({ error: "kind must be 'sender' or 'ip'" }, 400);
  if (!value) return json({ error: "value is required" }, 400);

  await env.DB.prepare(
    `INSERT INTO blocks (kind, value, created_at, note) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (kind, value) DO UPDATE SET note = excluded.note`,
  )
    .bind(kind, value, Date.now(), typeof body.note === "string" ? body.note.slice(0, 200) : null)
    .run();

  return json({ ok: true });
}

async function unblock(request, env) {
  const body = await readJson(request);
  if (!BLOCK_KINDS.has(body?.kind) || typeof body?.value !== "string") {
    return json({ error: "kind and value are required" }, 400);
  }

  await env.DB.prepare("DELETE FROM blocks WHERE kind = ?1 AND value = ?2")
    .bind(body.kind, body.value)
    .run();

  return json({ ok: true });
}

const unreadCount = (env) =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE read_at IS NULL").first("n");

/**
 * Marks one message read, or puts it back to unread.
 *
 * Returns the resulting state and the new unread total so the admin page can
 * update the card in place instead of reloading the whole list and losing
 * your position in it.
 */
async function setRead(request, env, id) {
  const body = await readJson(request);
  // No body at all means "mark this read" — the common case from the UI.
  const read = body?.read ?? true;

  const readAt = read ? Date.now() : null;

  const { meta } = await env.DB.prepare("UPDATE submissions SET read_at = ?1 WHERE id = ?2")
    .bind(readAt, id)
    .run();

  if (!meta.changes) return json({ error: "not found" }, 404);

  return json({ ok: true, readAt, unread: await unreadCount(env) });
}

async function deleteSubmission(env, id) {
  const row = await env.DB.prepare("SELECT drawing_key FROM submissions WHERE id = ?1")
    .bind(id)
    .first();

  if (row?.drawing_key) await env.DRAWINGS.delete(row.drawing_key);
  await env.DB.prepare("DELETE FROM submissions WHERE id = ?1").bind(id).run();

  // Deleting something that is not there is the state the caller asked for.
  return json({ ok: true });
}

export async function handleAdmin(request, env, url) {
  // There is no Cloudflare Access in front of `wrangler dev`, so without an
  // escape hatch the admin page could never be worked on locally. It is
  // deliberately one explicit switch that lives only in .dev.vars — wrangler
  // never uploads that file, so the only way it reaches production is if
  // somebody goes well out of their way to put it there.
  if (env.ADMIN_DEV_BYPASS !== "true" && !(await authenticateAdmin(request, env))) {
    return json({ error: "not allowed" }, 403);
  }

  const path = url.pathname;
  const method = request.method;

  if (path === "/admin") {
    if (method !== "GET" && method !== "HEAD") return json({ error: "GET only" }, 405);

    const page = await env.ASSETS.fetch(new Request(new URL("/admin.html", url), { method: "GET" }));
    return new Response(method === "HEAD" ? null : page.body, {
      status: page.status,
      headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE_HEADERS },
    });
  }

  if (path === "/admin/api/submissions") {
    if (method !== "GET") return json({ error: "GET only" }, 405);
    return listSubmissions(url, env);
  }

  if (path === "/admin/api/seen") {
    if (method !== "POST") return json({ error: "POST only" }, 405);
    await env.DB.prepare("UPDATE submissions SET read_at = ?1 WHERE read_at IS NULL")
      .bind(Date.now())
      .run();
    return json({ ok: true });
  }

  if (path === "/admin/api/blocks") {
    if (method !== "GET") return json({ error: "GET only" }, 405);
    const { results } = await env.DB.prepare(
      "SELECT kind, value, created_at, note FROM blocks ORDER BY created_at DESC",
    ).all();
    return json({
      blocks: results.map((row) => ({
        kind: row.kind,
        value: row.value,
        createdAt: row.created_at,
        note: row.note,
      })),
    });
  }

  if (path === "/admin/api/block") {
    if (method !== "POST") return json({ error: "POST only" }, 405);
    return block(request, env);
  }

  if (path === "/admin/api/unblock") {
    if (method !== "POST") return json({ error: "POST only" }, 405);
    return unblock(request, env);
  }

  const readToggle = path.match(/^\/admin\/api\/submissions\/([^/]+)\/read$/);
  if (readToggle) {
    if (method !== "POST") return json({ error: "POST only" }, 405);
    const id = decodeId(readToggle[1]);
    return id === null ? json({ error: "not found" }, 404) : setRead(request, env, id);
  }

  const submission = path.match(/^\/admin\/api\/submissions\/([^/]+)$/);
  if (submission) {
    if (method !== "DELETE") return json({ error: "DELETE only" }, 405);
    const id = decodeId(submission[1]);
    return id === null ? json({ error: "not found" }, 404) : deleteSubmission(env, id);
  }

  const drawing = path.match(/^\/admin\/drawing\/([^/]+)$/);
  if (drawing) {
    if (method !== "GET") return json({ error: "GET only" }, 405);
    const id = decodeId(drawing[1]);
    return id === null ? json({ error: "not found" }, 404) : serveDrawing(env, id);
  }

  return json({ error: "not found" }, 404);
}
