// HTML escaping and entity decoding, as Python's html.escape and html.unescape do them, so pages
// publish the same as they did when the plugin's scripts were Python.

import { decodeHTML } from "entities";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

/** Escape &, <, > and both quotes. */
export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

// Python's html.unescape drops numeric references to these code points, where the HTML spec keeps them.
function dropped(code: number): boolean {
  return (
    (code >= 0x1 && code <= 0x8) ||
    code === 0xb ||
    (code >= 0xe && code <= 0x1f) ||
    code === 0x7f ||
    (code >= 0xfdd0 && code <= 0xfdef) ||
    (code <= 0x10ffff && (code & 0xfffe) === 0xfffe)
  );
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

/** Decode character references in one pass: named ones by the HTML spec's table, numeric ones as Python does. */
export function unescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF, (whole, ref: string) => {
    if (ref[0] === "#") {
      const digits = ref.replace(/;$/, "");
      const code =
        digits[1] === "x" || digits[1] === "X" ? parseInt(digits.slice(2), 16) : parseInt(digits.slice(1), 10);
      // 0x80-0x9F, 0 and 0x0D are remapped before the dropped range is checked, as in Python.
      if (dropped(code) && !(code >= 0x80 && code <= 0x9f)) return "";
    }
    return decodeHTML(whole);
  });
}
