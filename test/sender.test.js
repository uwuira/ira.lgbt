import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  COOKIE_NAME,
  hashIp,
  readSender,
  senderCookie,
  signSenderId,
  verifySenderToken,
} from "../src/lib/sender.js";

const SECRET = "test-sender-secret";

describe("sender tokens", () => {
  test("a signed token verifies back to the id it was minted for", async () => {
    const token = await signSenderId("abc123", SECRET);
    expect(await verifySenderToken(token, SECRET)).toBe("abc123");
  });

  test("the token carries the id in the clear, followed by a signature", async () => {
    const token = await signSenderId("abc123", SECRET);
    const [id, sig] = token.split(".");
    expect(id).toBe("abc123");
    expect(sig.length).toBeGreaterThan(20);
  });

  test("rejects a token whose id was tampered with", async () => {
    const token = await signSenderId("abc123", SECRET);
    const forged = `abc124.${token.split(".")[1]}`;
    expect(await verifySenderToken(forged, SECRET)).toBe(null);
  });

  test("rejects a token whose signature was tampered with", async () => {
    const token = await signSenderId("abc123", SECRET);
    const [id, sig] = token.split(".");
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(await verifySenderToken(`${id}.${flipped}`, SECRET)).toBe(null);
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await signSenderId("abc123", "some-other-secret");
    expect(await verifySenderToken(token, SECRET)).toBe(null);
  });

  test("rejects malformed tokens instead of throwing", async () => {
    for (const bad of ["", "nodot", "a.b.c", ".", "abc.", ".sig", "abc.!!!not-base64!!!"]) {
      expect(await verifySenderToken(bad, SECRET), `expected null for ${JSON.stringify(bad)}`).toBe(
        null,
      );
    }
  });

  test("the same id always signs to the same token, so the cookie is stable", async () => {
    expect(await signSenderId("abc123", SECRET)).toBe(await signSenderId("abc123", SECRET));
  });
});

describe("readSender", () => {
  const withCookie = (cookie) =>
    new Request("https://ira.lgbt/", { headers: cookie ? { cookie } : {} });

  test("mints a fresh identity when there is no cookie", async () => {
    const sender = await readSender(withCookie(null), env);
    expect(sender.isNew).toBe(true);
    expect(sender.id).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifySenderToken(sender.token, SECRET)).toBe(sender.id);
  });

  test("mints a different identity for each new visitor", async () => {
    const a = await readSender(withCookie(null), env);
    const b = await readSender(withCookie(null), env);
    expect(a.id).not.toBe(b.id);
  });

  test("reuses a valid cookie rather than minting", async () => {
    const first = await readSender(withCookie(null), env);
    const again = await readSender(withCookie(`${COOKIE_NAME}=${first.token}`), env);
    expect(again.id).toBe(first.id);
    expect(again.isNew).toBe(false);
  });

  test("finds the cookie among others", async () => {
    const first = await readSender(withCookie(null), env);
    const again = await readSender(
      withCookie(`theme=dark; ${COOKIE_NAME}=${first.token}; other=1`),
      env,
    );
    expect(again.id).toBe(first.id);
  });

  test("mints a fresh identity when the cookie is forged", async () => {
    const forged = await readSender(withCookie(`${COOKIE_NAME}=deadbeef.notasignature`), env);
    expect(forged.isNew).toBe(true);
    expect(forged.id).not.toBe("deadbeef");
  });
});

describe("senderCookie", () => {
  test("is locked down: HttpOnly, Secure, SameSite, site-wide, long-lived", () => {
    const header = senderCookie("tok");
    expect(header).toContain(`${COOKIE_NAME}=tok`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toMatch(/Max-Age=\d{7,}/);
  });
});

describe("hashIp", () => {
  test("is stable for the same address", async () => {
    expect(await hashIp("1.2.3.4", "salt")).toBe(await hashIp("1.2.3.4", "salt"));
  });

  test("differs between addresses", async () => {
    expect(await hashIp("1.2.3.4", "salt")).not.toBe(await hashIp("1.2.3.5", "salt"));
  });

  test("differs between salts, so the hashes are not globally reversible", async () => {
    expect(await hashIp("1.2.3.4", "salt-a")).not.toBe(await hashIp("1.2.3.4", "salt-b"));
  });

  test("never returns the address itself", async () => {
    expect(await hashIp("1.2.3.4", "salt")).not.toContain("1.2.3.4");
  });

  test("handles a missing address without throwing", async () => {
    expect(await hashIp(null, "salt")).toMatch(/^[0-9a-f]+$/);
  });
});
