// Minimal JWT issuer used only by the tests, so the Access verifier can be
// exercised against tokens we control — including the malformed and malicious
// ones Cloudflare would never send.

const encoder = new TextEncoder();

export function base64url(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

export async function publicJwk(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

/** Signs a real RS256 token. */
export async function signJwt(payload, privateKey, { kid = "test-key", header = {} } = {}) {
  const signingInput = [
    base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header })),
    base64url(JSON.stringify(payload)),
  ].join(".");

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64url(signature)}`;
}

/** Builds an unsigned token with an arbitrary header — for the attack cases. */
export function forgeJwt(header, payload, signature = "") {
  return [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload)), signature].join(
    ".",
  );
}
