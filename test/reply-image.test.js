import { describe, expect, test } from "vitest";

import adminHtml from "../public/admin.html?raw";

// wrapText is browser-only code living inline in the admin page, so the test
// lifts the real function straight out of the HTML that ships.
const source = adminHtml
  .replace(/\r\n/g, "\n")
  .match(/\n {4}function wrapText[\s\S]*?\n {4}\}\n/);
if (!source) throw new Error("wrapText was not found in public/admin.html");
const wrapText = new Function(`${source[0]}\nreturn wrapText;`)();

// Stands in for the canvas: every character measures ten units wide.
const context = { measureText: (text) => ({ width: text.length * 10 }) };
const wrap = (text, maxWidth) => wrapText(context, text, maxWidth);

describe("wrapText", () => {
  test("packs as many words onto a line as fit", () => {
    expect(wrap("a b c d e", 50)).toEqual(["a b c", "d e"]);
  });

  test("moves a whole word down instead of splitting it across lines", () => {
    expect(wrap("hello enormous", 100)).toEqual(["hello", "enormous"]);
  });

  test("still breaks a word too long to fit a line of its own", () => {
    expect(wrap("supercalifragilistic", 50)).toEqual(["super", "calif", "ragil", "istic"]);
  });

  test("breaks an over-long word only after moving it to its own line", () => {
    expect(wrap("hi supercalifragilistic", 50)).toEqual(["hi", "super", "calif", "ragil", "istic"]);
  });

  test("keeps the sender's own line breaks, blank lines included", () => {
    expect(wrap("one\n\ntwo", 100)).toEqual(["one", "", "two"]);
  });
});

// The reply image is drawn on a canvas, so the only thing a worker test can
// check is the source: every fillText in it must be set up with one font.
const replyImageSource = adminHtml
  .replace(/\r\n/g, "\n")
  .match(/\n {4}async function replyImage[\s\S]*?\n {4}\}\n/)?.[0];
if (!replyImageSource) throw new Error("replyImage was not found in public/admin.html");

describe("reply image typography", () => {
  test("every piece of text is drawn in the same font", () => {
    const fonts = [...replyImageSource.matchAll(/\.font\s*=\s*(.+);/g)].map((m) => m[1]);
    expect(fonts.length).toBeGreaterThan(1);
    expect(new Set(fonts).size).toBe(1);
  });

  test("only one size and weight is spelled out anywhere in the drawing", () => {
    const sizes = [...replyImageSource.matchAll(/\d+00 \$?\{?\w*\d*\}?px/g)].map((m) => m[0]);
    expect(sizes.length).toBe(1);
  });
});
