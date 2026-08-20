import { beforeAll, describe, expect, test } from "vitest";

import { verifyAccessToken } from "../src/lib/access.js";
import { base64url, forgeJwt, generateKeyPair, publicJwk, signJwt } from "./helpers/jwt.js";

const ISSUER = "https://ira.cloudflareaccess.com";
const AUDIENCE = "aud-tag-for-the-admin-app";
const NOW = 1_700_000_000_000; // fixed clock, so expiry tests are not flaky

let keys;
let otherKeys;
let jwks;

beforeAll(async () => {
  keys = await generateKeyPair();
  otherKeys = await generateKeyPair();
  jwks = { keys: [await publicJwk(keys.publicKey, "test-key")] };
});

const claims = (overrides = {}) => ({
  iss: ISSUER,
  aud: [AUDIENCE],
  email: "ira@uwuu.moe",
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000) - 10,
  nbf: Math.floor(NOW / 1000) - 10,
  ...overrides,
});

const verify = (token) =>
  verifyAccessToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, now: NOW });

describe("a token Cloudflare Access would actually issue", () => {
  test("verifies and returns its claims", async () => {
    const payload = await verify(await signJwt(claims(), keys.privateKey));
    expect(payload).toMatchObject({ email: "ira@uwuu.moe", iss: ISSUER });
  });

  test("accepts aud as a bare string as well as an array", async () => {
    const payload = await verify(await signJwt(claims({ aud: AUDIENCE }), keys.privateKey));
    expect(payload).toBeTruthy();
  });

  test("accepts an aud array that also contains other apps", async () => {
    const payload = await verify(
      await signJwt(claims({ aud: ["some-other-app", AUDIENCE] }), keys.privateKey),
    );
    expect(payload).toBeTruthy();
  });
});

describe("tokens that must be rejected", () => {
  test("issued for a different Access application", async () => {
    expect(await verify(await signJwt(claims({ aud: ["someone-elses-app"] }), keys.privateKey))).toBe(
      null,
    );
  });

  test("issued by a different Access team", async () => {
    expect(
      await verify(await signJwt(claims({ iss: "https://attacker.cloudflareaccess.com" }), keys.privateKey)),
    ).toBe(null);
  });

  test("expired", async () => {
    expect(
      await verify(await signJwt(claims({ exp: Math.floor(NOW / 1000) - 60 }), keys.privateKey)),
    ).toBe(null);
  });

  test("not valid yet", async () => {
    expect(
      await verify(await signJwt(claims({ nbf: Math.floor(NOW / 1000) + 600 }), keys.privateKey)),
    ).toBe(null);
  });

  test("missing an expiry entirely", async () => {
    const { exp, ...rest } = claims();
    expect(await verify(await signJwt(rest, keys.privateKey))).toBe(null);
  });

  test("signed by a key that is not in the JWKS", async () => {
    expect(await verify(await signJwt(claims(), otherKeys.privateKey))).toBe(null);
  });

  test("referencing a kid that is not in the JWKS", async () => {
    expect(await verify(await signJwt(claims(), keys.privateKey, { kid: "unknown-key" }))).toBe(null);
  });

  test("with a tampered payload but the original signature", async () => {
    const token = await signJwt(claims(), keys.privateKey);
    const [header, , signature] = token.split(".");
    const swapped = base64url(JSON.stringify(claims({ email: "attacker@evil.example" })));
    expect(await verify(`${header}.${swapped}.${signature}`)).toBe(null);
  });

  test("with a tampered signature", async () => {
    const token = await signJwt(claims(), keys.privateKey);
    const [header, payload, signature] = token.split(".");
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expect(await verify(`${header}.${payload}.${flipped}`)).toBe(null);
  });

  test('using alg "none" to skip the signature', async () => {
    expect(await verify(forgeJwt({ alg: "none", kid: "test-key" }, claims()))).toBe(null);
  });

  test("using HS256 to trick the verifier into treating the public key as a shared secret", async () => {
    expect(await verify(forgeJwt({ alg: "HS256", kid: "test-key" }, claims(), "anything"))).toBe(
      null,
    );
  });

  test("malformed, empty, or missing — without throwing", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "...", "not.a.jwt", null, undefined]) {
      expect(await verify(bad), `expected null for ${JSON.stringify(bad)}`).toBe(null);
    }
  });

  test("carrying a payload that is not JSON", async () => {
    expect(await verify(`${base64url('{"alg":"RS256","kid":"test-key"}')}.${base64url("nope")}.x`)).toBe(
      null,
    );
  });
});
