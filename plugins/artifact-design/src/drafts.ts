// Claude Code shows the model a scratchpad only when its own Artifact tool is on, so page files
// written for this plugin's tool would land in the person's project. They go to a private drafts
// folder instead, one per server process (one session), as a scratchpad is. The server makes the
// folder, and the allow-drafts hook lets Write and Edit into it without a prompt.

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uid = process.getuid?.();

export const DRAFTS_ROOT = join(tmpdir(), uid === undefined ? "artifact-drafts" : `artifact-drafts-${uid}`);

/** Whether DRAFTS_ROOT is a real folder this user owns, so nobody else can read the drafts or plant the folder. */
export function draftsRootIsOwn(): boolean {
  const info = lstatSync(DRAFTS_ROOT, { throwIfNoEntry: false });
  return !!info && info.isDirectory() && (uid === undefined || info.uid === uid);
}

/** The local time as 20261009-142530. */
export function localStamp(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

/** A private (0700) folder for this session under DRAFTS_ROOT; empty folders a day old go. */
export function makeDrafts(): string {
  try {
    try {
      mkdirSync(DRAFTS_ROOT, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!draftsRootIsOwn()) throw new Error(`${DRAFTS_ROOT} isn't a folder of this user's own`);
    for (const name of readdirSync(DRAFTS_ROOT)) {
      try {
        const old = join(DRAFTS_ROOT, name);
        if (statSync(old).isDirectory() && Date.now() - statSync(old).mtimeMs > 86_400_000) rmdirSync(old); // only empty ones
      } catch {
        // in use, not empty, or gone
      }
    }
    return mkdtempSync(join(DRAFTS_ROOT, `${localStamp()}-`));
  } catch {
    return mkdtempSync(join(tmpdir(), "artifact-drafts-"));
  }
}
