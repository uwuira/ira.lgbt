// Visitor identity for the inbox.
//
// Submissions are anonymous in the sense that nothing here asks who you are —
// no name, no login, no email. But every submission is stamped with two
// pseudonyms so a spammer can be shut off without shutting off everyone:
//
//   sender id — a random value the site hands the browser in a signed cookie.
//               Stable across visits, cleared by clearing cookies.
//   ip hash   — a salted SHA-256 of the address. Survives a cookie wipe, and
//               cannot be turned back into an address without the salt.
//
// Neither identifies a person. Both are enough to block one.

export const COOKIE_NAME = "sid";

const YEAR_SECONDS = 60 * 60 * 24 * 365;

const encoder = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** `<id>.<signature>` — the id is readable, the signature makes it unforgeable. */
export async function signSenderId(id, secret) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(id));
  return `${id}.${toBase64Url(signature)}`;
}

/** Returns the id a token vouches for, or null if it vouches for nothing. */
export async function verifySenderToken(token, secret) {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [id, signature] = parts;
  if (!id || !signature) return null;

  try {
    // crypto.subtle.verify compares in constant time, so a wrong signature
    // leaks nothing about how nearly right it was.
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64Url(signature),
      encoder.encode(id),
    );
    return ok ? id : null;
  } catch {
    // Signature wasn't valid base64url. Same answer as a bad signature.
    return null;
  }
}

/**
 * The sender behind a request: their existing identity if the cookie checks
 * out, otherwise a freshly minted one. `isNew` tells the caller whether the
 * response still needs to set the cookie.
 */
export async function readSender(request, env) {
  const cookies = request.headers.get("cookie") ?? "";
  const existing = cookies
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  if (existing) {
    const id = await verifySenderToken(existing, env.SENDER_SECRET);
    if (id) return { id, token: existing, isNew: false };
  }

  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return { id, token: await signSenderId(id, env.SENDER_SECRET), isNew: true };
}

export function senderCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${YEAR_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Salted so the stored hashes are useless to anyone without the salt. */
export async function hashIp(ip, salt) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${ip ?? ""}`));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
