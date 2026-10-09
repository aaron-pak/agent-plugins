// PreToolUse hook: let Write and Edit into the artifact server's drafts folder through without a
// permission prompt, as Claude Code lets them into its own scratchpad.
//
// Claude Code lists a scratchpad only when its own Artifact tool is on, so the `artifact` server sends
// page files to a private folder per session under <temp>/artifact-drafts-<uid> instead (see
// drafts.ts). That folder is outside the project, so Claude Code would ask before each session's
// first page. This answers "allow" only for a path inside that folder, when the folder is a real
// directory this user owns; for anything else it says nothing and the usual permission check runs.
//
// scripts/build.ts bundles it into hooks/allow-drafts.mjs, which runs on Node.

import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { DRAFTS_ROOT, draftsRootIsOwn } from "./drafts.ts";
import { partsBelow, resolvePath } from "./paths.ts";

type Event = { tool_name?: unknown; tool_input?: { file_path?: unknown } | null };

function draftsTarget(event: Event): boolean {
  // Codex runs plugin hooks too and matches apply_patch as Write and Edit, but it rejects "allow"
  // without a rewritten input, and its sandbox already lets writes into the temp folder.
  if (!["Write", "Edit", "MultiEdit"].includes(event.tool_name as string)) return false;
  const path = event.tool_input?.file_path;
  if (typeof path !== "string" || !isAbsolute(path) || !draftsRootIsOwn()) return false;
  const target = join(resolvePath(dirname(path)), basename(path));
  return (
    partsBelow(resolvePath(DRAFTS_ROOT), target) !== null &&
    !lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
  );
}

let allowed = false;
try {
  allowed = draftsTarget(JSON.parse(readFileSync(0, "utf8")) as Event);
} catch {
  allowed = false;
}
if (allowed) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "a page draft in the artifact server's private drafts folder",
      },
    }),
  );
}
