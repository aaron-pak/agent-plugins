// HTML escaping and entity decoding, as Claude Code's Artifact tool does them (2.1.296).

/** Escape &, <, > and both quotes, ' as &apos;. */
export function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const REFERENCE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
// The named references the Artifact tool decodes in a page's <title>; any other stays as written.
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  minus: "−",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  lsaquo: "‹",
  rsaquo: "›",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  prime: "′",
  Prime: "″",
  trade: "™",
  copy: "©",
  reg: "®",
  deg: "°",
  times: "×",
};

/** Decode numeric references and the common named ones, as the Artifact tool reads a <title>. */
export function unescape(text: string): string {
  return text.replace(REFERENCE, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    if (Object.hasOwn(NAMED, ref)) return NAMED[ref]!;
    const lower = ref.toLowerCase();
    return Object.hasOwn(NAMED, lower) ? NAMED[lower]! : whole;
  });
}
