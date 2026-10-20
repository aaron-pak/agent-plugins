// `bun run mod preview <dir>`: a band mod drawn through a session, checked, and painted.
//
// It runs the mod on a copy, through `claude plugin test`, with a test that plays a session's moments
// (fresh, idle, cheer, working, reading, thinking, oops, high, nap, pet), one file per moment so they
// run side by side, and dumps every tree the AbovePrompt hook draws on each surface at each width.
// Then, with no browser and no pictures:
// - report.txt: the layout checks in preview/lint.ts, which fail the command on an error;
// - frames.txt: the terminal band as text at each width, and each distinct frame of an animation.
// With --png it also paints contact sheets (sheet-<style>.png) of both surfaces on dark and light,
// and with --gifs animated GIFs of the terminal and the desktop.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyMod, modName, seconds, stream, testFiles } from "./common.ts";
import type { Shot } from "./preview/paint.ts";

const SCENARIOS = ["fresh", "idle", "cheer", "working", "reading", "thinking", "oops", "high", "nap", "pet"];

export const PREVIEW_SWITCHES = new Set(["png", "gifs", "strips"]);

export const PREVIEW_HELP = `bun run mod preview <dir> [options]

Plays a session through a band mod (its AbovePrompt hook), checks the layout, and writes what it drew
to --out: report.txt, frames.txt (the terminal band as text), shots.jsonl (every tree), and with
--png or --gifs, pictures. Exits 1 when a check finds an error. Read frames.txt and report.txt first;
paint only once they look right.

  --out <dir>            where to write (default: <tmp>/mod-preview/<mod>)
  --styles a,b           run /<command> <style> as each session starts (default: as installed)
  --command <name>       the command that switches styles (default: band)
  --scenarios a,b        the moments to play (default: ${SCENARIOS.join(",")})
  --widths 64,100,140    band widths in columns; --animate-at 100 is the one animated
  --frames 24            how many frames the animated width films, 125 ms apart
  --surfaces terminal,desktop
  --shots <file>         check and paint an earlier shots.jsonl instead of running the mod
  --png                  paint contact sheets (needs Chromium: Playwright's, or Chrome)
  --gifs                 also animated GIFs (needs Python with Pillow)
  --strips               a sheet per style and moment at the animated width, at 2x: the band alone in
                         each distinct terminal frame, and on the desktop seeked every --step seconds
                         (default 0.25) for --span seconds (default 6), dark and light
  --max-rows 3 --slack 2 --max-changes 4 --allow "…"   the checks' limits`;

const list = (flags: Map<string, string[]>, name: string, fallback: string[]) =>
  flags.get(name)?.at(-1)?.split(",").filter(Boolean) ?? fallback;
const one = (flags: Map<string, string[]>, name: string) => flags.get(name)?.at(-1);

async function collect(
  dir: string,
  config: { styles: (string | null)[] },
  scenarios: string[],
  out: string,
): Promise<Shot[]> {
  const copy = copyMod(dir);
  try {
    for (const file of testFiles(copy.path)) rmSync(file);
    mkdirSync(join(copy.path, "tests"), { recursive: true });
    const template = readFileSync(join(import.meta.dir, "preview", "shots.test.tmpl"), "utf8");
    for (const scenario of scenarios) {
      for (const style of config.styles) {
        const source = template.replace(
          "__CONFIG__",
          JSON.stringify({ ...config, styles: [style], scenarios: [scenario] }),
        );
        const name = style === null ? scenario : `${scenario}-${style}`;
        writeFileSync(join(copy.path, "tests", `zz-preview-${name}.test.ts`), source);
      }
    }
    const shots: Shot[] = [];
    const log: string[] = [];
    await stream(["claude", "plugin", "test", "."], copy.path, (line) => {
      if (!line.startsWith("@@SHOT ")) {
        log.push(line);
        return;
      }
      try {
        shots.push(JSON.parse(line.slice(7)) as Shot);
      } catch {
        log.push(`(a drawing that did not parse: ${line.slice(0, 120)}… ${line.length} chars)`);
      }
    });
    writeFileSync(join(out, "test-log.txt"), log.join("\n"));
    if (log.some((line) => line.startsWith("(fail)")) || shots.length === 0) {
      console.log(log.slice(-30).join("\n"));
    }
    return shots;
  } finally {
    copy.dispose();
  }
}

function framesText(shots: Shot[], terminalRows: (tree: Shot["tree"], columns: number) => string[]): string {
  const blocks: string[] = [];
  const draw = (shot: Shot) => {
    const rows = terminalRows(shot.tree, shot.columns);
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    // ┊ marks the band's right edge; anything past it overflows.
    return rows.map((row) => {
      const width = Bun.stringWidth(row.trimEnd());
      return width <= shot.columns ? row.trimEnd() + " ".repeat(shot.columns - width) + "┊" : row.trimEnd();
    });
  };
  const terminal = shots.filter((s) => s.surface === "terminal");
  const groups = new Map<string, Shot[]>();
  for (const shot of terminal) {
    const key = `${shot.style ?? ""}|${shot.scenario}|${shot.columns}`;
    groups.set(key, [...(groups.get(key) ?? []), shot]);
  }
  const styles = [...new Set(terminal.map((s) => s.style))];
  const order = (frames: Shot[]) => {
    const s = frames[0]!;
    return [styles.indexOf(s.style), SCENARIOS.indexOf(s.scenario), s.columns];
  };
  const sorted = [...groups.values()].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  for (const frames of sorted) {
    frames.sort((a, b) => a.frame - b.frame);
    const first = frames[0]!;
    const label = `${first.style === null ? "" : `${first.style} · `}${first.scenario} @ ${first.columns} columns`;
    let last = "";
    const distinct: string[] = [];
    for (const shot of frames) {
      const text = draw(shot).join("\n");
      if (text === last) continue;
      last = text;
      distinct.push(frames.length > 1 ? `+${shot.ms} ms\n${text}` : text);
    }
    const span = frames.length > 1 ? `, ${distinct.length} distinct frames in ${frames.at(-1)!.ms} ms` : "";
    blocks.push(`── ${label}${span}\n${distinct.join("\n")}`);
  }
  return blocks.join("\n\n") + "\n";
}

async function launch() {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch();
  } catch (first) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw new Error(
        `No Chromium to paint with: ${(first as Error).message.split("\n")[0]}\n` +
          "Install Google Chrome, or Playwright's Chromium with `bunx playwright-core install chromium`.",
      );
    }
  }
}

async function paint(shots: Shot[], out: string, gifs: boolean, animateAt: number): Promise<void> {
  const { desktopScreen, esc, page, termBlock } = await import("./preview/paint.ts");
  const browser = await launch();
  try {
    const pg = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
    const pick = (q: Partial<Shot>) => shots.find((s) => Object.entries(q).every(([k, v]) => s[k as keyof Shot] === v));
    const styles = [...new Set(shots.map((s) => s.style))];
    const scenarios = SCENARIOS.filter((name) => shots.some((s) => s.scenario === name));
    const widths = [...new Set(shots.map((s) => s.columns))].filter((c) => c !== animateAt);

    for (const style of styles) {
      const tag = style ?? "default";
      let body = `<div style="font-size:18px;font-weight:600;margin-bottom:6px">${esc(tag)}</div>`;
      for (const scenario of scenarios) {
        const t = pick({ style, scenario, surface: "terminal", columns: animateAt, frame: 0 });
        const d = pick({ style, scenario, surface: "desktop", columns: animateAt, frame: 0 });
        body += `<div class="label"><b>${esc(scenario)}</b> @ ${animateAt} columns</div>`;
        if (t)
          body += `<div class="cell">${termBlock(t, "dark")}</div><div class="cell">${termBlock(t, "light")}</div>`;
        if (d)
          body += `<div class="cell">${desktopScreen(d, "dark")}</div><div class="cell">${desktopScreen(d, "light")}</div>`;
      }
      for (const columns of widths) {
        for (const scenario of scenarios.filter((s) => s === "working" || s === "idle")) {
          const t = pick({ style, scenario, surface: "terminal", columns, frame: 0 });
          const d = pick({ style, scenario, surface: "desktop", columns, frame: 0 });
          body += `<div class="label"><b>${esc(scenario)}</b> @ ${columns} columns</div>`;
          if (t) body += `<div class="cell">${termBlock(t, "dark")}</div>`;
          if (d) body += `<div class="cell">${desktopScreen(d, "light")}</div>`;
        }
      }
      // Offscreen sandboxed frames are throttled and never paint: make the viewport as tall as the page.
      await pg.setViewportSize({ width: 1400, height: 800 });
      await pg.setContent(page(body), { waitUntil: "load" });
      const height = await pg.evaluate<number>("document.documentElement.scrollHeight");
      await pg.setViewportSize({ width: 1400, height: Math.min(Math.max(800, height), 16000) });
      await pg.waitForTimeout(600);
      const file = join(out, `sheet-${tag}.png`);
      await pg.screenshot({ path: file, fullPage: true });
      console.log(`wrote ${file}`);
    }

    if (!gifs) return;
    const jobs: [string, string, number][] = [];
    for (const style of styles) {
      const tag = style ?? "default";
      for (const scenario of scenarios) {
        const frames = shots
          .filter(
            (s) => s.style === style && s.scenario === scenario && s.surface === "terminal" && s.columns === animateAt,
          )
          .sort((a, b) => a.frame - b.frame);
        if (frames.length < 2) continue;
        const dir = join(out, "frames", `${tag}-${scenario}`);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const blocks = frames
          .map(
            (f) =>
              `<div class="f" style="display:block;width:max-content;margin:0 0 4px 0">${termBlock(f, "dark")}</div>`,
          )
          .join("");
        await pg.setContent(page(blocks), { waitUntil: "load" });
        await pg.screenshot({ path: join(dir, "all.png"), fullPage: true });
        const boxes = await pg.$$eval(".f", (els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        );
        writeFileSync(join(dir, "boxes.json"), JSON.stringify(boxes));
        jobs.push([dir, join(out, `term-${tag}-${scenario}.gif`), (frames[1]?.ms ?? 125) - (frames[0]?.ms ?? 0)]);
      }
      // The desktop animates by itself (SVG and CSS): record the page live.
      for (const scenario of scenarios) {
        const d = pick({ style, scenario, surface: "desktop", columns: animateAt, frame: 0 });
        if (!d) continue;
        const dir = join(out, "frames", `desk-${tag}-${scenario}`);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        await pg.setContent(page(`<div id="t" style="display:inline-block">${desktopScreen(d, "light")}</div>`), {
          waitUntil: "load",
        });
        for (let i = 0; i < 24; i++) {
          await pg.locator("#t").screenshot({ path: join(dir, `${String(i).padStart(3, "0")}.png`) });
          await pg.waitForTimeout(80);
        }
        jobs.push([dir, join(out, `desk-${tag}-${scenario}.gif`), 100]);
      }
    }
    writeFileSync(join(out, "gifs.json"), JSON.stringify(jobs));
    const python = Bun.spawnSync(["python3", join(import.meta.dir, "preview", "gif.py"), join(out, "gifs.json")], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (python.exitCode !== 0) console.log("(GIFs need python3 with Pillow: python3 -m pip install pillow)");
  } finally {
    await browser.close();
  }
}

/**
 * A sheet per style and moment at the animated width, at twice the pixels: the band alone in each
 * distinct terminal frame, then the desktop's band seeked every `step` seconds for `span`. A desktop
 * drawing's pictures restart whenever its tree changes, so each moment is seeked from when the tree
 * it shows first came up.
 */
async function strips(shots: Shot[], out: string, animateAt: number, step: number, span: number): Promise<void> {
  const { desktopBand, esc, page, seekScript, svgSources, terminalBand } = await import("./preview/paint.ts");
  const browser = await launch();
  try {
    const pg = await (await browser.newContext({ deviceScaleFactor: 2 })).newPage();
    const styles = [...new Set(shots.map((s) => s.style))];
    const scenarios = SCENARIOS.filter((name) => shots.some((s) => s.scenario === name));
    const row = (label: string, cells: string[]) =>
      `<div style="display:flex;align-items:center;gap:10px;margin:0 0 6px"><div style="width:64px;font:11px monospace;color:#444;text-align:right">${esc(label)}</div>${cells.join("")}</div>`;
    for (const style of styles) {
      for (const scenario of scenarios) {
        const of = (surface: Shot["surface"]) =>
          shots
            .filter(
              (s) => s.style === style && s.scenario === scenario && s.surface === surface && s.columns === animateAt,
            )
            .sort((a, b) => a.frame - b.frame);
        let body = `<div style="font-size:16px;font-weight:600;margin-bottom:8px">${esc(style ?? "default")} · ${esc(scenario)} @ ${animateAt} columns</div>`;
        let last = "";
        for (const shot of of("terminal")) {
          const tree = JSON.stringify(shot.tree);
          if (tree === last) continue;
          last = tree;
          body += row(`+${shot.ms} ms`, [terminalBand(shot, "dark"), terminalBand(shot, "light")]);
        }
        const desk = of("desktop");
        // When each picture's source first came up in the drawings before this one: it plays from there.
        const since = new Map<Shot, Map<string, number>>();
        desk.forEach((shot, i) => {
          const before = since.get(desk[i - 1]!) ?? new Map<string, number>();
          since.set(shot, new Map(svgSources(shot.tree).map((source) => [source, before.get(source) ?? shot.ms])));
        });
        for (let t = 0; desk.length > 0 && t <= span + 1e-9; t += step) {
          const ms = Math.round(t * 1000);
          const shot = desk.filter((s) => s.ms <= ms).at(-1) ?? desk[0]!;
          const seek = (source: string) => (ms - (since.get(shot)?.get(source) ?? shot.ms)) / 1000;
          body += row(`${t.toFixed(2)} s`, [desktopBand(shot, "dark", seek), desktopBand(shot, "light", seek)]);
        }
        await pg.setViewportSize({ width: 1400, height: 800 });
        await pg.setContent(page(body), { waitUntil: "load" });
        await pg.evaluate(seekScript);
        await pg.waitForTimeout(100);
        const file = join(out, `strip-${style ?? "default"}-${scenario}.png`);
        await pg.screenshot({ path: file, fullPage: true });
        console.log(`wrote ${file}`);
      }
    }
  } finally {
    await browser.close();
  }
}

export async function previewMod(dir: string, flags: Map<string, string[]>): Promise<number> {
  const started = performance.now();
  const name = modName(dir);
  const out = resolve(one(flags, "out") ?? join(tmpdir(), "mod-preview", name));
  mkdirSync(out, { recursive: true });
  const styles = list(flags, "styles", []);
  const scenarios = list(flags, "scenarios", SCENARIOS);
  const unknown = scenarios.filter((s) => !SCENARIOS.includes(s));
  if (unknown.length > 0) throw new Error(`no scenario ${unknown.join(", ")}; there are ${SCENARIOS.join(", ")}`);
  const widths = list(flags, "widths", ["64", "100", "140"]).map(Number);
  const animateAt = Number(one(flags, "animate-at") ?? (widths.includes(100) ? 100 : widths[0]));

  let shots: Shot[];
  const given = one(flags, "shots");
  if (given !== undefined) {
    shots = readFileSync(given, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Shot);
  } else {
    const config = {
      plugin: name,
      command: one(flags, "command") ?? "band",
      styles: styles.length > 0 ? styles : [null],
      widths,
      animateAt,
      frames: Number(one(flags, "frames") ?? 24),
      surfaces: list(flags, "surfaces", ["terminal", "desktop"]),
    };
    console.log(`Playing ${scenarios.length} moments through ${name}…`);
    shots = await collect(dir, config, scenarios, out);
    writeFileSync(join(out, "shots.jsonl"), shots.map((s) => JSON.stringify(s)).join("\n") + "\n");
    console.log(
      `${shots.length} drawings in ${seconds(started)}; the test's output is in ${join(out, "test-log.txt")}`,
    );
  }
  if (shots.length === 0) return 1;

  const { terminalRows } = await import("./preview/paint.ts");
  const { lint } = await import("./preview/lint.ts");
  writeFileSync(join(out, "frames.txt"), framesText(shots, terminalRows));
  const findings = lint(shots, {
    maxRows: Number(one(flags, "max-rows") ?? 3),
    slack: Number(one(flags, "slack") ?? 2),
    maxChanges: Number(one(flags, "max-changes") ?? 4),
    allow: one(flags, "allow") ?? "",
  });
  const errors = findings.filter((f) => f.level === "error");
  const report =
    findings.length === 0
      ? "No layout problems found.\n"
      : findings
          .map((f) => `${f.level === "error" ? "ERROR" : "warn "}  ${f.check.padEnd(14)} ${f.message}`)
          .join("\n") + "\n";
  writeFileSync(join(out, "report.txt"), report);
  console.log(`\n${report}`);
  console.log(`Wrote ${join(out, "frames.txt")} and ${join(out, "report.txt")}.`);

  if (flags.has("png") || flags.has("gifs")) await paint(shots, out, flags.has("gifs"), animateAt);
  if (flags.has("strips")) {
    await strips(shots, out, animateAt, Number(one(flags, "step") ?? 0.25), Number(one(flags, "span") ?? 6));
  }
  console.log(`Took ${seconds(started)}.`);
  return errors.length === 0 ? 0 : 1;
}
