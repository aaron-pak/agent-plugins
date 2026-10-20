// Paints the trees a mod drew the way each surface would. The terminal goes through Ink (the
// terminal surface is Ink), its ANSI read back into cells, block elements drawn as pixels the way
// Ghostty and iTerm2 draw them. The desktop is approximated as Claude Code Desktop lays it out: Box
// as a flex div, Text as a styled span in a proportional font, Svg in a sandboxed frame. Both on
// dark and light themes. Fonts and exact sizes are approximations; layout faults are not.

process.env.FORCE_COLOR = "3"; // Ink's colors are fixed when chalk loads, so before Ink does.
const React = await import("react");
const { Box, Text, renderToString } = await import("ink");

export type Tree = string | number | boolean | null | undefined | TreeElement;
/** A drawn element; `hover`, a Box's styles while a pointer rests on it, sits beside its props. */
export type TreeElement = {
  type: string;
  props?: Record<string, unknown>;
  hover?: Record<string, unknown>;
  children?: Tree[];
};
export type Shot = {
  scenario: string;
  style: string | null;
  surface: "terminal" | "desktop";
  columns: number;
  frame: number;
  ms: number;
  tree: Tree;
};

type Theme = Record<string, string>;

// Claude Code's dark and light themes, as rgb() strings keyed by theme key.
const CC_DARK: Theme = {
  autoAccept: "rgb(175,135,255)",
  bashBorder: "rgb(253,93,177)",
  claude: "rgb(215,119,87)",
  claudeShimmer: "rgb(235,159,127)",
  permission: "rgb(177,185,249)",
  planMode: "rgb(72,150,140)",
  ide: "rgb(71,130,200)",
  promptBorder: "rgb(136,136,136)",
  text: "rgb(255,255,255)",
  inverseText: "rgb(0,0,0)",
  inactive: "rgb(153,153,153)",
  subtle: "rgb(80,80,80)",
  suggestion: "rgb(177,185,249)",
  remember: "rgb(177,185,249)",
  background: "rgb(0,204,204)",
  success: "rgb(78,186,101)",
  error: "rgb(255,107,128)",
  warning: "rgb(255,193,7)",
  merged: "rgb(175,135,255)",
  diffAdded: "rgb(34,92,43)",
  diffRemoved: "rgb(122,41,54)",
  diffAddedDimmed: "rgb(71,88,74)",
  diffRemovedDimmed: "rgb(105,72,77)",
  diffAddedWord: "rgb(56,166,96)",
  diffRemovedWord: "rgb(179,89,107)",
  professionalBlue: "rgb(106,155,204)",
  clawd_body: "rgb(215,119,87)",
  clawd_background: "rgb(0,0,0)",
  userMessageBackground: "rgb(55,55,55)",
  rate_limit_fill: "rgb(177,185,249)",
  rate_limit_empty: "rgb(80,83,112)",
  briefLabelClaude: "rgb(215,119,87)",
  rainbow_red: "rgb(235,95,87)",
  rainbow_orange: "rgb(245,139,87)",
  rainbow_yellow: "rgb(250,195,95)",
  rainbow_green: "rgb(145,200,130)",
  rainbow_blue: "rgb(130,170,220)",
  rainbow_indigo: "rgb(155,130,200)",
  rainbow_violet: "rgb(200,130,180)",
};
const CC_LIGHT: Theme = {
  ...CC_DARK,
  autoAccept: "rgb(135,0,255)",
  bashBorder: "rgb(255,0,135)",
  claudeShimmer: "rgb(245,149,117)",
  permission: "rgb(87,105,247)",
  planMode: "rgb(0,102,102)",
  promptBorder: "rgb(138,138,138)",
  text: "rgb(0,0,0)",
  inverseText: "rgb(255,255,255)",
  inactive: "rgb(102,102,102)",
  subtle: "rgb(175,175,175)",
  suggestion: "rgb(87,105,247)",
  remember: "rgb(0,0,255)",
  background: "rgb(0,153,153)",
  success: "rgb(44,122,57)",
  error: "rgb(171,43,63)",
  warning: "rgb(150,108,30)",
  merged: "rgb(135,0,255)",
  diffAdded: "rgb(105,219,124)",
  diffRemoved: "rgb(255,168,180)",
  diffAddedDimmed: "rgb(199,225,203)",
  diffRemovedDimmed: "rgb(253,210,216)",
  diffAddedWord: "rgb(47,157,68)",
  diffRemovedWord: "rgb(209,69,75)",
  userMessageBackground: "rgb(240,240,240)",
  rate_limit_fill: "rgb(87,105,247)",
  rate_limit_empty: "rgb(39,47,111)",
};

export type Scheme = "dark" | "light";
const TERM: Record<Scheme, { theme: Theme; bg: string; fg: string }> = {
  dark: { theme: CC_DARK, bg: "#17171a", fg: "#e8e8e8" },
  light: { theme: CC_LIGHT, bg: "#fbfbf8", fg: "#1b1b1b" },
};
// claude.ai's palette, which the desktop app's Code tab wears: approximations of its page.
// Claude Code Desktop's Code tab: the page (`bg`), the card it draws the AbovePrompt band in (`band`),
// the composer (`card`, `border`) and the footer under it (`foot`). Dark is measured from the app on
// a Retina screen; light is estimated from the same layout.
type Desk = {
  theme: Theme;
  bg: string;
  band: string;
  card: string;
  border: string;
  fg: string;
  dim: string;
  foot: string;
  claude: string;
};
const DESK: Record<Scheme, Desk> = {
  dark: {
    theme: CC_DARK,
    bg: "#151515",
    band: "#212121",
    card: "#20201f",
    border: "#4d4d4c",
    fg: "#f0efec",
    dim: "#898782",
    foot: "#c3c2b8",
    claude: "#d97757",
  },
  light: {
    theme: CC_LIGHT,
    bg: "#faf9f5",
    band: "#f0eee6",
    card: "#ffffff",
    border: "#dedcd1",
    fg: "#141413",
    dim: "#73726c",
    foot: "#3d3d3a",
    claude: "#d97757",
  },
};
const NAMED: Record<string, string> = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  gray: "#808080",
  grey: "#808080",
};
const ANSI_ORDER = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

/** An xterm 256-color index as hex: the 16 named colors, the 6×6×6 cube, then the grays. */
function xterm256(n: number): string {
  if (n < 8) return NAMED[ANSI_ORDER[n]!]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    const i = n - 16;
    return "#" + [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((v) => hex(level(v))).join("");
  }
  return "#" + hex(8 + (n - 232) * 10).repeat(3);
}

const hex = (n: number) => n.toString(16).padStart(2, "0");
const rgb = (s: string) =>
  "#" +
  (s.match(/\d+/g) ?? [])
    .slice(0, 3)
    .map((n) => hex(Number(n)))
    .join("");

function color(c: unknown, theme: Theme): string | undefined {
  if (typeof c !== "string") return undefined;
  if (theme[c] !== undefined) return rgb(theme[c]);
  if (c.startsWith("rgb")) return rgb(c);
  if (c.startsWith("#"))
    return c.length === 4
      ? "#" +
          c
            .slice(1)
            .split("")
            .map((x) => x + x)
            .join("")
      : c;
  if (NAMED[c] !== undefined) return NAMED[c];
  if (c.startsWith("ansi")) return NAMED[c.split(":")[1] ?? ""] ?? "#888888";
  return undefined;
}

const isElement = (node: Tree): node is TreeElement => typeof node === "object" && node !== null;
const kids = (node: TreeElement): Tree[] => node.children ?? [];

// ── Terminal: tree → Ink → ANSI → cells ──────────────────────────────────

const BOX_PROPS = [
  "flexDirection",
  "flexGrow",
  "flexShrink",
  "flexWrap",
  "flexBasis",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "gap",
  "columnGap",
  "rowGap",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "margin",
  "marginX",
  "marginY",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "borderStyle",
  "borderDimColor",
  "overflow",
  "display",
];
const TEXT_PROPS = ["dimColor", "bold", "italic", "underline", "strikethrough", "inverse", "wrap"];

type InkNode = ReturnType<typeof React.createElement> | string | null;
const h = (type: Parameters<typeof React.createElement>[0], props: object | null, ...children: unknown[]) =>
  React.createElement(type, props, ...(children as InkNode[]));

function inkTree(node: Tree, theme: Theme, key = 0): InkNode {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (!isElement(node)) return String(node);
  const p = node.props ?? {};
  const children = kids(node).map((c, i) => inkTree(c, theme, i));
  const pick = (names: string[]) => Object.fromEntries(names.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  switch (node.type) {
    case "Box":
      if (p.position === "absolute") return null;
      return h(Box, { key, ...pick(BOX_PROPS), borderColor: color(p.borderColor, theme) }, ...children);
    case "Text":
      return h(
        Text,
        {
          key,
          ...pick(TEXT_PROPS),
          color: color(p.color, theme),
          backgroundColor: color(p.backgroundColor, theme),
        },
        ...children,
      );
    case "Button": {
      const inner = typeof p.label === "string" ? [p.label] : children;
      return h(
        Text,
        { key, dimColor: p.dimColor, color: p.variant === "primary" ? color("claude", theme) : undefined },
        ...(p.plain === true ? inner : ["[ ", ...inner, " ]"]),
      );
    }
    case "Client":
      return h(
        Box,
        { key, width: p.width, height: p.height, flexGrow: p.flexGrow, overflow: "hidden", flexDirection: "column" },
        ...children,
      );
    case "Link":
      return h(Text, { key, underline: true }, ...(children.length > 0 ? children : [String(p.url ?? "")]));
    case "Markdown":
      return h(Text, { key }, String(p.source ?? p.text ?? ""));
    case "Code":
      return h(Text, { key }, String(p.source ?? ""));
    case "Fault":
      return h(Text, { key, color: "#ff5555" }, `⚠ ${String(p.message ?? "fault")}`);
    default:
      return h(Text, { key, color: "#ff5555" }, `⚠ <${node.type}> is not drawn on the terminal`);
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * The band alone as the terminal lays it out at `columns`, one string per row, without color. The
 * room beyond `columns` is left open, so a child wider than the band shows past its edge.
 */
export function terminalRows(tree: Tree, columns: number): string[] {
  const band = inkTree(tree, CC_DARK) ?? "";
  const out = renderToString(h(Box, { width: columns, flexDirection: "column" }, band), { columns: columns + 40 });
  return out.replace(ANSI, "").split("\n");
}

type Cell = {
  ch: string;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  ul: boolean;
  inv: boolean;
  wide?: boolean;
  cont?: boolean;
};

function cellWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (/\p{Extended_Pictographic}/u.test(g) && (g.includes("️") || cp >= 0x1f000)) return 2;
  return Bun.stringWidth(g) === 2 ? 2 : 1;
}

function parseAnsi(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  const plain = { fg: null, bg: null, bold: false, dim: false, ul: false, inv: false };
  let st: Omit<Cell, "ch"> = { ...plain };
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const re = /\x1b\[([0-9;]*)m|\n|([^\x1b\n]+)/g;
  for (const m of text.matchAll(re)) {
    if (m[0] === "\n") {
      rows.push(row);
      row = [];
      continue;
    }
    if (m[1] !== undefined) {
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i]!;
        const truecolor = () =>
          "#" +
          codes
            .slice(i + 2, i + 5)
            .map(hex)
            .join("");
        if (c === 0) st = { ...plain };
        else if (c === 1) st = { ...st, bold: true };
        else if (c === 2) st = { ...st, dim: true };
        else if (c === 22) st = { ...st, bold: false, dim: false };
        else if (c === 4) st = { ...st, ul: true };
        else if (c === 24) st = { ...st, ul: false };
        else if (c === 7) st = { ...st, inv: true };
        else if (c === 27) st = { ...st, inv: false };
        else if (c === 39) st = { ...st, fg: null };
        else if (c === 49) st = { ...st, bg: null };
        else if (c === 38 && codes[i + 1] === 2) {
          st = { ...st, fg: truecolor() };
          i += 4;
        } else if (c === 48 && codes[i + 1] === 2) {
          st = { ...st, bg: truecolor() };
          i += 4;
        } else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
          st = c === 38 ? { ...st, fg: xterm256(codes[i + 2] ?? 7) } : { ...st, bg: xterm256(codes[i + 2] ?? 0) };
          i += 2;
        } else if (c >= 30 && c <= 37) st = { ...st, fg: xterm256(c - 30) };
        else if (c >= 40 && c <= 47) st = { ...st, bg: xterm256(c - 40) };
        else if (c >= 90 && c <= 97) st = { ...st, fg: xterm256(c - 82) };
        else if (c >= 100 && c <= 107) st = { ...st, bg: xterm256(c - 92) };
      }
      continue;
    }
    for (const { segment } of segmenter.segment(m[2] ?? "")) {
      const wide = cellWidth(segment) === 2;
      row.push({ ch: segment, ...st, wide });
      if (wide) row.push({ ch: "", ...st, cont: true });
    }
  }
  rows.push(row);
  return rows;
}

// Block elements as pixel quadrants [tl, tr, bl, br], and the lower eighths.
const QUAD: Record<string, number[]> = {
  "▘": [1, 0, 0, 0],
  "▝": [0, 1, 0, 0],
  "▖": [0, 0, 1, 0],
  "▗": [0, 0, 0, 1],
  "▀": [1, 1, 0, 0],
  "▄": [0, 0, 1, 1],
  "▌": [1, 0, 1, 0],
  "▐": [0, 1, 0, 1],
  "▚": [1, 0, 0, 1],
  "▞": [0, 1, 1, 0],
  "▙": [1, 0, 1, 1],
  "▛": [1, 1, 1, 0],
  "▜": [1, 1, 0, 1],
  "▟": [0, 1, 1, 1],
  "█": [1, 1, 1, 1],
};
const LOWER: Record<string, number> = { "▁": 1 / 8, "▂": 2 / 8, "▃": 3 / 8, "▅": 5 / 8, "▆": 6 / 8, "▇": 7 / 8 };
const CW = 9;
const CH = 19;

function mix(a: string, b: string, t: number): string {
  const pa = (a.match(/\w\w/g) ?? []).map((x) => parseInt(x, 16));
  const pb = (b.match(/\w\w/g) ?? []).map((x) => parseInt(x, 16));
  return "#" + pa.map((v, i) => hex(Math.round(v * (1 - t) + (pb[i] ?? 0) * t))).join("");
}

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cellsHtml(rows: Cell[][], scheme: { bg: string; fg: string }): { html: string; w: number; h: number } {
  let html = "";
  const at = (left: number, top: number, w: number, hgt: number, css: string, inner = "") =>
    `<div style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${hgt}px;${css}">${inner}</div>`;
  rows.forEach((row, y) => {
    row.forEach((c, x) => {
      if (c.cont === true) return;
      let fg = c.fg ?? scheme.fg;
      let bg = c.bg;
      if (c.inv) [fg, bg] = [bg ?? scheme.bg, fg];
      if (c.dim) fg = mix(fg, bg ?? scheme.bg, 0.45);
      const left = x * CW;
      const top = y * CH;
      const w = (c.wide === true ? 2 : 1) * CW;
      if (bg !== null) html += at(left, top, w, CH, `background:${bg}`);
      if (c.ch === " " || c.ch === "") return;
      const quad = QUAD[c.ch];
      if (quad !== undefined) {
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].forEach(([qx, qy], i) => {
          if (quad[i] === 1)
            html += at(left + qx! * (CW / 2), top + qy! * (CH / 2), CW / 2, CH / 2, `background:${fg}`);
        });
        return;
      }
      const lower = LOWER[c.ch];
      if (lower !== undefined) {
        const hgt = Math.round(CH * lower);
        html += at(left, top + CH - hgt, CW, hgt, `background:${fg}`);
        return;
      }
      const style = `line-height:${CH}px;text-align:center;color:${fg};font-weight:${c.bold ? 700 : 400};${c.ul ? "text-decoration:underline;" : ""}`;
      html += at(left, top, w, CH, style, esc(c.ch));
    });
  });
  const width = Math.max(...rows.map((r) => r.length));
  return { html, w: width * CW, h: rows.length * CH };
}

const WORKING = new Set(["working", "thinking", "reading", "oops"]);

/** The band alone as a terminal draws it, as cells in HTML on the theme's background. */
export function terminalBand(shot: Shot, schemeName: Scheme): string {
  const scheme = TERM[schemeName];
  const band = inkTree(shot.tree, scheme.theme) ?? h(Text, null, "");
  const el = h(Box, { width: shot.columns, flexDirection: "column", overflow: "hidden" }, band);
  const { html, w, h: hgt } = cellsHtml(parseAnsi(renderToString(el, { columns: shot.columns })), scheme);
  return `<div style="position:relative;width:${w + 16}px;height:${hgt + 12}px;background:${scheme.bg};font-family:'DejaVu Sans Mono',Menlo,monospace;font-size:15px;border-radius:6px"><div style="position:absolute;left:8px;top:6px">${html}</div></div>`;
}

/** The band in a terminal, between the last output and the prompt box, as cells in HTML. */
function terminalScreen(shot: Shot, schemeName: Scheme) {
  const scheme = TERM[schemeName];
  const theme = scheme.theme;
  const total = shot.columns + 5;
  const band = inkTree(shot.tree, theme);
  const el = h(
    Box,
    { flexDirection: "column", width: total },
    h(Text, { dimColor: true }, "  ⎿  Updated hooks/band.tsx with 12 additions and 4 removals"),
    h(Text, null, " "),
    WORKING.has(shot.scenario)
      ? h(
          Text,
          { color: color("claude", theme) },
          "✶ Pondering… ",
          h(Text, { dimColor: true }, "(12s · esc to interrupt)"),
        )
      : h(Text, null, " "),
    h(
      Box,
      { flexDirection: "row" },
      h(Box, { width: shot.columns, flexDirection: "column", overflow: "hidden" }, band ?? h(Text, null, "")),
      h(Box, { width: 5, justifyContent: "flex-end" }, h(Text, { dimColor: true }, "[-]")),
    ),
    h(
      Box,
      { borderStyle: "round", borderColor: color("promptBorder", theme), width: total, paddingX: 1 },
      h(Text, null, "> ", h(Text, { dimColor: true }, 'Try "refactor the retry logic"')),
    ),
    h(Text, { dimColor: true }, "  ? for shortcuts"),
  );
  return cellsHtml(parseAnsi(renderToString(el, { columns: total })), scheme);
}

export function termBlock(shot: Shot, schemeName: Scheme): string {
  const { html, w, h: hgt } = terminalScreen(shot, schemeName);
  const scheme = TERM[schemeName];
  return `<div style="position:relative;width:${w + 24}px;height:${hgt + 16}px;background:${scheme.bg};font-family:'DejaVu Sans Mono',Menlo,monospace;font-size:15px;border-radius:8px"><div style="position:absolute;left:12px;top:8px">${html}</div></div>`;
}

// ── Desktop: tree → flex divs and spans ───────────────────────────────────

const CELL = 7.8; // the desktop's monospace metric, approximated
const ROW = 20;
const size = (v: unknown, axis: "x" | "y") =>
  typeof v === "string" ? v : `${Number(v) * (axis === "y" ? ROW : CELL)}px`;

/**
 * How a desktop drawing is painted: `isHovered`, with a pointer resting on the band (each Box's
 * `hover` styles applied); `seek`, with each Svg inlined in a frame of its own, `data-t` naming the
 * second its animations are to be seeked to (see seekScript), rather than as a running image. A
 * picture's animations start over only when its source changes, so each is seeked by its source.
 */
type DeskPaint = { isHovered?: boolean; seek?: (source: string) => number };

function deskTree(node: Tree, scheme: Desk, paint: DeskPaint = {}): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (!isElement(node)) return esc(node);
  const hover = paint.isHovered === true && node.type === "Box" ? node.hover : undefined;
  const p = { ...node.props, ...hover };
  const theme = scheme.theme;
  const inner = () =>
    kids(node)
      .map((c) => deskTree(c, scheme, paint))
      .join("");
  switch (node.type) {
    case "Box": {
      const dir = String(p.flexDirection ?? "row");
      const css = [`display:${p.display === "none" ? "none" : "flex"}`, `flex-direction:${dir}`];
      const map: Record<string, string> = {
        flexGrow: "flex-grow",
        flexShrink: "flex-shrink",
        flexWrap: "flex-wrap",
        alignItems: "align-items",
        alignSelf: "align-self",
        justifyContent: "justify-content",
        overflow: "overflow",
      };
      for (const [k, v] of Object.entries(map)) if (p[k] !== undefined) css.push(`${v}:${String(p[k])}`);
      if (p.gap !== undefined) css.push(`gap:${size(p.gap, dir.startsWith("column") ? "y" : "x")}`);
      if (p.columnGap !== undefined) css.push(`column-gap:${size(p.columnGap, "x")}`);
      if (p.rowGap !== undefined) css.push(`row-gap:${size(p.rowGap, "y")}`);
      for (const [k, prop, axis] of [
        ["width", "width", "x"],
        ["height", "height", "y"],
        ["minWidth", "min-width", "x"],
        ["minHeight", "min-height", "y"],
      ] as const)
        if (p[k] !== undefined) css.push(`${prop}:${size(p[k], axis)}`);
      for (const base of ["padding", "margin"] as const) {
        const all = p[base];
        const vx = p[`${base}X`] ?? all;
        const vy = p[`${base}Y`] ?? all;
        const sides = { Top: [vy, "y"], Bottom: [vy, "y"], Left: [vx, "x"], Right: [vx, "x"] } as const;
        for (const [side, [fallback, axis]] of Object.entries(sides)) {
          const v = p[`${base}${side}`] ?? fallback;
          if (v !== undefined) css.push(`${base}-${side.toLowerCase()}:${size(v, axis)}`);
        }
      }
      if (p.borderStyle !== undefined)
        css.push(
          `border:1px ${p.borderStyle === "dashed" ? "dashed" : "solid"} ${color(p.borderColor, theme) ?? scheme.border}`,
          `border-radius:${p.borderStyle === "round" ? 8 : 0}px`,
        );
      if (p.backgroundColor !== undefined) css.push(`background:${color(p.backgroundColor, theme)}`);
      if (p.position === "absolute") {
        css.push("position:absolute");
        for (const k of ["top", "left", "right", "bottom"])
          if (p[k] !== undefined) css.push(`${k}:${size(p[k], k === "top" || k === "bottom" ? "y" : "x")}`);
      }
      return `<div style="${css.join(";")}">${inner()}</div>`;
    }
    case "Text": {
      const css = ["white-space:pre"];
      if (p.color !== undefined) css.push(`color:${color(p.color, theme)}`);
      if (p.backgroundColor !== undefined) css.push(`background:${color(p.backgroundColor, theme)}`);
      if (p.dimColor === true) css.push(`color:${scheme.dim}`);
      if (p.bold === true) css.push("font-weight:600");
      if (p.italic === true) css.push("font-style:italic");
      if (p.underline === true) css.push("text-decoration:underline");
      if (p.strikethrough === true) css.push("text-decoration:line-through");
      if (typeof p.wrap === "string" && p.wrap.startsWith("truncate"))
        css.push("overflow:hidden;text-overflow:ellipsis;min-width:0");
      return `<span style="${css.join(";")}">${inner()}</span>`;
    }
    case "Svg": {
      const w = p.width !== undefined ? `width:${String(p.width)}px;` : "";
      const hgt = p.height !== undefined ? `height:${String(p.height)}px;` : "";
      const source = String(p.source ?? "");
      if (paint.seek !== undefined) {
        const doc = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;${w}${hgt}}</style></head><body>${source}</body></html>`;
        return `<iframe data-t="${paint.seek(source)}" title="${esc(p.alt)}" style="border:0;${w}${hgt}flex-shrink:0;background:transparent" srcdoc="${esc(doc).replace(/"/g, "&quot;")}"></iframe>`;
      }
      if (p.isInteractive === true) {
        const doc = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;${w}${hgt}}</style></head><body>${source}</body></html>`;
        return `<iframe sandbox="" title="${esc(p.alt)}" style="border:0;${w}${hgt}flex-shrink:0;background:transparent" srcdoc="${esc(doc).replace(/"/g, "&quot;")}"></iframe>`;
      }
      return `<img alt="${esc(p.alt)}" style="${w}${hgt}flex-shrink:0;display:block" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}">`;
    }
    case "Button": {
      const label = typeof p.label === "string" ? esc(p.label) : inner();
      if (p.plain === true) return `<button style="all:unset;cursor:pointer;color:inherit">${label}</button>`;
      const primary = p.variant === "primary";
      return `<button style="font:inherit;font-size:12px;padding:2px 10px;border-radius:7px;border:1px solid ${scheme.border};background:${primary ? scheme.claude : "transparent"};color:${primary ? "#fff" : scheme.fg}">${label}</button>`;
    }
    case "Client": {
      const css = ["display:flex", "flex-direction:column", "overflow:hidden"];
      if (p.width !== undefined) css.push(`width:${size(p.width, "x")}`);
      if (p.height !== undefined) css.push(`height:${size(p.height, "y")}`);
      return `<div style="${css.join(";")}">${inner()}</div>`;
    }
    case "Link":
      return `<a style="color:${scheme.claude}">${inner() || esc(p.url ?? "")}</a>`;
    case "Markdown":
      return `<span>${esc(p.source ?? p.text ?? "")}</span>`;
    case "Fault":
      return `<span style="color:#e5484d">⚠ ${esc(p.message ?? "fault")}</span>`;
    default:
      return `<span style="color:#e5484d">⚠ ${esc(node.type)}</span>`;
  }
}

/**
 * The band as the desktop app draws it: its own box, which clips what is parked across its edges
 * (a picture a hover moves in), with the pointer resting on it in the pet scenario.
 */
function deskBand(shot: Shot, s: Desk, seek?: (source: string) => number): string {
  const width = Math.round(shot.columns * CELL);
  const paint: DeskPaint = { isHovered: shot.scenario === "pet", ...(seek === undefined ? {} : { seek }) };
  return `<div style="position:relative;overflow:hidden;width:${width}px;display:flex;flex-direction:column">${deskTree(shot.tree, s, paint)}</div>`;
}

/**
 * The band alone, in the card the desktop draws it in, each picture seeked to the second `seek`
 * gives its source (see seekScript).
 */
export function desktopBand(shot: Shot, schemeName: Scheme, seek: (source: string) => number): string {
  const s = DESK[schemeName];
  return `<div style="display:inline-block;background:${s.band};color:${s.fg};font-family:system-ui,'DejaVu Sans',sans-serif;font-size:14px;line-height:${ROW}px;padding:10px 8px;border-radius:10px">${deskBand(shot, s, seek)}</div>`;
}

/**
 * Run in the page once it has loaded: pauses every animation in each seekable picture (desktopBand)
 * at the second its frame names, so a page shows one exact moment of the motion.
 */
/** The source of every Svg a drawing holds. */
export function svgSources(tree: Tree): string[] {
  if (!isElement(tree)) return [];
  const own = tree.type === "Svg" ? [String(tree.props?.source ?? "")] : [];
  return [...own, ...kids(tree).flatMap(svgSources)];
}

export const seekScript = `for (const frame of document.querySelectorAll("iframe[data-t]")) {
  const t = Number(frame.dataset.t) * 1000;
  for (const animation of frame.contentDocument?.getAnimations() ?? []) {
    animation.pause();
    animation.currentTime = t;
  }
}`;

/**
 * The band in the desktop app's Code tab as it draws it (measured on a Retina screen): the band in
 * its own card, the composer 6 px under it, the footer under that, on the page. With `seek`, each
 * picture is seekable, as desktopBand's are.
 */
export function desktopScreen(shot: Shot, schemeName: Scheme, seek?: (source: string) => number): string {
  const s = DESK[schemeName];
  const width = Math.round(shot.columns * CELL) + 16;
  const spinner = WORKING.has(shot.scenario)
    ? `<div style="color:${s.claude};font-size:13px;margin:0 0 8px 4px">✶ Pondering… <span style="color:${s.dim}">12s</span></div>`
    : "";
  return `<div style="width:${width + 40}px;background:${s.bg};color:${s.fg};font-family:system-ui,'DejaVu Sans',sans-serif;font-size:14px;line-height:${ROW}px;padding:16px 20px 12px;box-sizing:border-box">
    ${spinner}
    <div style="width:${width}px;box-sizing:border-box;background:${s.band};border-radius:10px;padding:10px 8px">${deskBand(shot, s, seek)}</div>
    <div style="width:${width}px;box-sizing:border-box;margin-top:6px;border:1px solid ${s.border};background:${s.card};border-radius:16px;padding:11px 16px;display:flex;justify-content:space-between;align-items:center">
      <span style="color:${s.dim};font-size:15px"><span style="color:${s.fg};margin-right:12px">＋</span>Type / for commands</span><svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="${s.dim}" stroke-width="1.4"><rect x="3" y="1" width="6" height="9" rx="3"/><path d="M1 7.5a5 5 0 0 0 10 0M6 12.5V15"/></svg>
    </div>
    <div style="width:${width}px;display:flex;justify-content:space-between;margin-top:10px;padding:0 16px;box-sizing:border-box;font-size:13px;color:${s.foot}"><span>Auto</span><span>Opus 5.5 <span style="color:${s.dim}">High</span></span></div>
  </div>`;
}

export function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#d8d6cf;font-family:system-ui,'DejaVu Sans',sans-serif}.label{font-size:12px;color:#444;margin:10px 0 4px}.cell{display:inline-block;vertical-align:top;margin:0 14px 14px 0}</style></head><body><div style="padding:16px">${body}</div></body></html>`;
}

export { esc };
