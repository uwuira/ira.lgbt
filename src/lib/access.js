// Cloudflare Access guards /admin. Access authenticates the visitor at the
// edge and forwards a signed JWT; this module is the second lock — it checks
// that signature itself rather than trusting that the request reached the
// Worker through Access at all. Without it, anything that could talk to the
// Worker route directly would be admin.

const encoder = new TextEncoder();

const JWKS_CACHE_KEY = "access:jwks";
const JWKS_TTL_SECONDS = 3600;

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));
}

/**
 * Verifies an Access JWT against a JWKS and returns its claims, or null.
 *
 * `now` is injectable so expiry has a testable clock.
 */
export async function verifyAccessToken(token, { jwks, issuer, audience, now = Date.now() }) {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [rawHeader, rawPayload, rawSignature] = parts;

  try {
    const header = decodeJson(rawHeader);

    // Only RS256 is ever accepted. Reading the algorithm out of the token and
    // trusting it is the classic JWT break: "none" skips verification, and
    // HS256 invites the verifier to HMAC with the public key, which an
    // attacker also has.
    if (header.alg !== "RS256") return null;

    const jwk = jwks?.keys?.find((key) => key.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64Url(rawSignature),
      encoder.encode(`${rawHeader}.${rawPayload}`),
    );
    if (!verified) return null;

    const payload = decodeJson(rawPayload);
    const seconds = Math.floor(now / 1000);

    // An Access token without an expiry is a permanent key. Refuse it.
    if (typeof payload.exp !== "number" || seconds >= payload.exp) return null;
    if (typeof payload.nbf === "number" && seconds < payload.nbf) return null;
    if (payload.iss !== issuer) return null;

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(audience)) return null;

    return payload;
  } catch {
    // Malformed base64, malformed JSON, unusable key — all mean "not a token
    // we can trust", which is the same answer as a bad signature.
    return null;
  }
}

/** Cloudflare rotates these keys every six weeks, so cache but do not pin. */
async function loadJwks(env) {
  const cached = await env.CACHE.get(JWKS_CACHE_KEY, "json");
  if (cached) return cached;

  const res = await fetch(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);

  const jwks = await res.json();
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify(jwks), {
    expirationTtl: JWKS_TTL_SECONDS,
  });
  return jwks;
}

/**
 * The identity behind an admin request, or null if there isn't a valid one.
 * Access sends the token in a header; the CF_Authorization cookie is not
 * guaranteed to be forwarded, so the header is what we read.
 */
export async function authenticateAdmin(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;

  try {
    return await verifyAccessToken(token, {
      jwks: await loadJwks(env),
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
  } catch {
    // If the JWKS is unreachable we cannot verify anyone. Fail closed.
    return null;
  }
}
