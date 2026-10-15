// Checks on a band's drawings that once took a round of looking at pictures to catch: a band whose
// height jumps, a row that runs to the edge or past it, glyphs a terminal may draw two cells wide,
// a frame clock that redraws too often, character art or space-aligned columns on the desktop, and
// elements a surface refuses.

import { terminalRows, type Shot, type Tree, type TreeElement } from "./paint.ts";

export type Finding = { level: "error" | "warn"; check: string; message: string };

export type LintOptions = {
  /** The most rows the band may take in the terminal. */
  maxRows: number;
  /** The fewest columns to leave free at the band's right edge. */
  slack: number;
  /** The most frame changes a second an animation may make. */
  maxChanges: number;
  /** Glyphs beyond the safe set that the mod has checked and allows. */
  allow: string;
};

// What each surface draws (from the API's element tables); a Client draws with the terminal's minus
// Client, Raster and Image.
const ELEMENTS: Record<string, Set<string>> = {
  terminal: new Set([
    "Box",
    "Text",
    "Button",
    "Input",
    "Select",
    "Link",
    "Code",
    "Markdown",
    "Client",
    "Raster",
    "Image",
  ]),
  desktop: new Set(["Box", "Text", "Button", "Input", "Select", "Svg", "Link", "Code", "Markdown", "Client"]),
  client: new Set(["Box", "Text", "Button", "Input", "Select", "Link", "Code", "Markdown"]),
};

// Claude Code's own glyphs, and block elements and box drawing, which every terminal draws one cell wide.
const SAFE = /^[\x20-\x7e─-▟·✢✳✶✻✽⎿]$/u;
const BLOCKS = /[▀-▟]/u;

const isElement = (node: Tree): node is TreeElement => typeof node === "object" && node !== null;

function walk(node: Tree, visit: (el: TreeElement, inClient: boolean) => void, inClient = false): void {
  if (!isElement(node)) return;
  visit(node, inClient);
  for (const child of node.children ?? []) walk(child, visit, inClient || node.type === "Client");
}

function textOf(node: Tree): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (!isElement(node)) return String(node);
  return (node.children ?? []).map(textOf).join("");
}

const where = (shot: Shot) => `${shot.style === null ? "" : `${shot.style} · `}${shot.scenario} @ ${shot.columns}`;

export function lint(shots: Shot[], options: LintOptions): Finding[] {
  const findings: Finding[] = [];
  const groups = new Map<string, { finding: Finding; more: number }>();
  // One line per kind of fault (`group`), with a count of the drawings it held for.
  const add = (finding: Finding, group = finding.message) => {
    const key = `${finding.check}|${group}`;
    const seen = groups.get(key);
    if (seen !== undefined) {
      if (seen.finding.message !== finding.message) seen.more++;
      return;
    }
    const entry = { finding: { ...finding }, more: 0 };
    groups.set(key, entry);
    findings.push(entry.finding);
  };

  // Elements the surface refuses, and faults the engine reported while drawing.
  for (const shot of shots) {
    walk(shot.tree, (el, inClient) => {
      if (el.type === "Fault") {
        add(
          {
            level: "error",
            check: "fault",
            message: `${shot.surface}, ${where(shot)}: ${String(el.props?.message)}`,
          },
          String(el.props?.message),
        );
        return;
      }
      const table = ELEMENTS[inClient ? "client" : shot.surface];
      if (table !== undefined && !table.has(el.type)) {
        const scope = inClient ? "a Client's module" : `the ${shot.surface}`;
        add(
          { level: "error", check: "element", message: `<${el.type}> is not drawn in ${scope} (${where(shot)})` },
          `${el.type}|${scope}`,
        );
      }
    });
  }

  // Terminal: rows, slack and glyphs as Ink lays them out, and a height that holds.
  const heights = new Map<string, Map<number, string[]>>();
  const strange = new Map<string, Set<string>>();
  for (const shot of shots.filter((s) => s.surface === "terminal")) {
    const rows = terminalRows(shot.tree, shot.columns);
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const group = `${shot.style ?? ""}@${shot.columns}`;
    const byHeight = heights.get(group) ?? new Map<number, string[]>();
    byHeight.set(rows.length, [...(byHeight.get(rows.length) ?? []), shot.scenario]);
    heights.set(group, byHeight);
    if (rows.length > options.maxRows) {
      add(
        {
          level: "error",
          check: "rows",
          message: `${where(shot)}: ${rows.length} rows, more than ${options.maxRows}`,
        },
        String(shot.style),
      );
    }
    rows.forEach((row, y) => {
      const width = Bun.stringWidth(row.trimEnd());
      if (width > shot.columns) {
        add(
          {
            level: "error",
            check: "width",
            message: `${where(shot)}: row ${y + 1} is ${width} cells wide, past the band's ${shot.columns}`,
          },
          `${shot.style}@${shot.columns}`,
        );
      } else if (width > shot.columns - options.slack) {
        const free = shot.columns - width;
        add(
          {
            level: "warn",
            check: "slack",
            message: `${where(shot)}: row ${y + 1} leaves ${free} of ${options.slack} free columns at the edge`,
          },
          `${shot.style}@${shot.columns}`,
        );
      }
      for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(row)) {
        if (SAFE.test(segment) || options.allow.includes(segment)) continue;
        const seen = strange.get(segment) ?? new Set<string>();
        seen.add(where(shot));
        strange.set(segment, seen);
      }
    });
  }
  for (const [group, byHeight] of heights) {
    if (byHeight.size < 2) continue;
    const [style, columns] = group.split("@");
    const parts = [...byHeight].map(([rows, scenarios]) => `${rows} rows in ${[...new Set(scenarios)].join(", ")}`);
    add({
      level: "error",
      check: "height",
      message: `${style === "" ? "" : `${style}: `}the band's height changes at ${columns} columns (${parts.join("; ")}), so the prompt jumps`,
    });
  }
  for (const [glyph, seen] of strange) {
    const code = [...glyph].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
    const emoji = /\p{Extended_Pictographic}/u.test(glyph) || Bun.stringWidth(glyph) !== 1;
    const first = [...seen][0];
    add({
      level: emoji ? "error" : "warn",
      check: "glyph",
      message: emoji
        ? `"${glyph}" (${code}) may draw two cells wide or as an emoji (${first})`
        : `"${glyph}" (${code}) is outside the safe set; a terminal may draw it two cells wide (${first}). Pass --allow "${glyph}" once checked.`,
    });
  }

  // Terminal animations: how often the drawing changes.
  const runs = new Map<string, Shot[]>();
  for (const shot of shots.filter((s) => s.surface === "terminal")) {
    const key = `${shot.style ?? ""}|${shot.scenario}|${shot.columns}`;
    runs.set(key, [...(runs.get(key) ?? []), shot]);
  }
  for (const frames of runs.values()) {
    if (frames.length < 3) continue;
    frames.sort((a, b) => a.frame - b.frame);
    let changes = 0;
    for (let i = 1; i < frames.length; i++) {
      if (JSON.stringify(frames[i]!.tree) !== JSON.stringify(frames[i - 1]!.tree)) changes++;
    }
    const span = (frames.at(-1)!.ms - frames[0]!.ms) / 1000;
    const rate = span > 0 ? changes / span : 0;
    if (rate > options.maxChanges) {
      add({
        level: "warn",
        check: "motion",
        message: `${where(frames[0]!)}: ${rate.toFixed(1)} frame changes a second, more than ${options.maxChanges}`,
      });
    }
  }

  // Desktop: character art shreds in a proportional font, and spaces align nothing.
  for (const shot of shots.filter((s) => s.surface === "desktop")) {
    walk(shot.tree, (el) => {
      if (el.type !== "Text") return;
      const text = textOf(el);
      if (BLOCKS.test(text)) {
        add(
          {
            level: "error",
            check: "desktop-art",
            message: `${where(shot)}: block characters in Text ("${text.trim().slice(0, 24)}") shred in the desktop's proportional font; draw with Svg`,
          },
          String(shot.style),
        );
      } else if (/\S {2,}\S| {3,}/.test(text)) {
        add(
          {
            level: "warn",
            check: "desktop-spaces",
            message: `${where(shot)}: Text aligns with spaces ("${text.slice(0, 32)}"), which drift in a proportional font; use Box gap or padding`,
          },
          String(shot.style),
        );
      }
    });
  }

  for (const { finding, more } of groups.values()) {
    if (more > 0) finding.message += ` (and ${more} more like it)`;
  }
  return findings.sort((a, b) => Number(a.level === "warn") - Number(b.level === "warn"));
}
