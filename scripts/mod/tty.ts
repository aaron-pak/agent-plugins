// `bun run mod tty`: Claude Code itself, with the mod loaded, in a real terminal (tmux), captured.
//
// The preview draws a mod's trees through Ink, which is close to the terminal but not the terminal:
// the host's own lines around the band, its reply prefixes, its color depth and the timing of real
// turns are only seen in a real session. This starts one in a detached tmux pane of a set size,
// types what --send gives (each followed by Enter), and records the pane every --every ms whenever
// it changes, to frames.txt (text, with when each frame appeared) and frames.jsonl (with colors).
// --png paints the frames to a sheet. It needs tmux and a Claude Code that is signed in; it runs
// where an interactive session may start, such as a Mac, not a cloud container's auto mode.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TTY_HELP = `bun run mod tty [<dir>] [options]

Starts \`claude --plugin-dir <dir>\` in a detached tmux pane, types each --send (then Enter), and
records the pane whenever it changes, to --out: frames.txt (text) and frames.jsonl (with colors).

  --send <text>       type this and press Enter; repeat for more (a "/band hearth", a prompt)
  --wait <s>          how long to record after a send (default 8; give one per --send, in order,
                      or one for all), and --boot <s> after start (6)
  --cols 100 --rows 30  the pane's size
  --colors truecolor  or 256, to see the colors a 256-color terminal rounds to
  --cmd "<command>"   run this in place of claude --plugin-dir <dir>
  --cwd <dir>         where the session starts (default: the current folder; it must be trusted)
  --every <ms>        how often to look at the pane (default 200)
  --out <dir>         where to write (default: <tmp>/mod-tty)
  --png               paint the distinct frames to sheet.png`;

function tmux(...args: string[]): string {
  const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

// An OSC sequence, such as a hyperlink (OSC 8), which a capture keeps around its text.
export const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function ttyCapture(words: string[], flags: Map<string, string[]>): Promise<number> {
  const one = (name: string) => flags.get(name)?.at(-1);
  const dir = words[0] === undefined ? undefined : resolve(words[0]);
  const command = one("cmd") ?? (dir === undefined ? undefined : `claude --plugin-dir ${quote(dir)}`);
  if (command === undefined) throw new Error("name the mod's folder, or give --cmd");
  const cols = Number(one("cols") ?? 100);
  const rows = Number(one("rows") ?? 30);
  const every = Number(one("every") ?? 200);
  const out = resolve(one("out") ?? join(tmpdir(), "mod-tty"));
  mkdirSync(out, { recursive: true });

  const session = `mod-tty-${process.pid}`;
  const env = one("colors") === "256" ? ["-e", "COLORTERM="] : ["-e", "COLORTERM=truecolor"];
  tmux(
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    String(cols),
    "-y",
    String(rows),
    ...env,
    "-c",
    resolve(one("cwd") ?? "."),
    command,
  );
  const started = performance.now();
  const frames: { ms: number; after: string; ansi: string }[] = [];
  let last = "";
  const record = async (after: string, seconds: number) => {
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
      let ansi: string;
      try {
        ansi = tmux("capture-pane", "-p", "-e", "-t", session);
      } catch {
        return false; // the pane closed
      }
      if (ansi !== last) {
        frames.push({ ms: Math.round(performance.now() - started), after, ansi });
        last = ansi;
      }
      await Bun.sleep(every);
    }
    return true;
  };

  try {
    let open = await record("start", Number(one("boot") ?? 6));
    const waits = flags.get("wait") ?? [];
    for (const [i, text] of (flags.get("send") ?? []).entries()) {
      if (!open) break;
      tmux("send-keys", "-t", session, "-l", text);
      tmux("send-keys", "-t", session, "Enter");
      open = await record(text, Number(waits[i] ?? waits.at(-1) ?? 8));
    }
  } finally {
    try {
      tmux("kill-session", "-t", session);
    } catch {
      // Already gone.
    }
  }

  const plain = (ansi: string) =>
    ansi
      .replace(OSC, "")
      .replace(/\x1b\[[0-9;:]*m/g, "")
      .replace(/\s+$/gm, "");
  writeFileSync(join(out, "frames.jsonl"), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  writeFileSync(
    join(out, "frames.txt"),
    frames.map((f) => `── +${f.ms} ms, after ${JSON.stringify(f.after)}\n${plain(f.ansi)}`).join("\n\n") + "\n",
  );
  console.log(`${frames.length} distinct frames of a ${cols}×${rows} pane in ${join(out, "frames.txt")}`);

  if (flags.has("png") && frames.length > 0) {
    const { ansiBlock, esc, page } = await import("./preview/paint.ts");
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
    try {
      const pg = await browser.newPage();
      const body = frames
        .map((f) => `<div class="label">+${f.ms} ms, after ${esc(f.after)}</div>${ansiBlock(f.ansi, "dark")}`)
        .join("");
      await pg.setContent(page(body), { waitUntil: "load" });
      await pg.screenshot({ path: join(out, "sheet.png"), fullPage: true });
      console.log(`wrote ${join(out, "sheet.png")}`);
    } finally {
      await browser.close();
    }
  }
  return 0;
}
