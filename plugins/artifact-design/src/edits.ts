// `edits` on a publish, as Claude Code's Artifact tool applies them (2.1.300): exact old_str/new_str
// pairs applied in order to the file's text, all or none, before it is published; the file is then
// saved with them, so it stays the source for later changes.

export type Edit = { old_str: string; new_str: string };

const MAX_CHARS = 65_536; // old_str and new_str together, over all the edits
const MAX_WORK = 268_435_456; // edits times file length
const MAX_COUNTED = 100; // occurrences counted for an ambiguous old_str
export const MAX_EDITS = 64;

type Miss =
  | { reason: "empty_old_str" | "malformed" | "not_found" | "ambiguous"; edit: number; count?: number }
  | { reason: "too_large" | "too_much_work" | "noop" };

/** The edits as the tool takes them, or a reason to refuse the call. */
export function editsOf(value: unknown): Edit[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITS) {
    return `\`edits\` is a list of 1 to ${MAX_EDITS} {old_str, new_str} pairs.`;
  }
  for (const [n, edit] of value.entries()) {
    const pair = edit as Record<string, unknown> | null;
    if (
      !pair ||
      typeof pair !== "object" ||
      typeof pair.old_str !== "string" ||
      typeof pair.new_str !== "string" ||
      Object.keys(pair).some((key) => key !== "old_str" && key !== "new_str")
    ) {
      return `edits[${n}] must be {old_str, new_str}, both strings.`;
    }
  }
  return value as Edit[];
}

const wellFormed = (text: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

function count(text: string, find: string): number {
  let n = 0;
  for (let at = text.indexOf(find); at !== -1 && n < MAX_COUNTED; at = text.indexOf(find, at + 1)) n++;
  return n;
}

/** The text with the edits applied in order, or why they don't apply. A CRLF file is edited with
 * LF line endings and keeps CRLF. */
export function applyEdits(text: string, edits: Edit[]): { ok: true; text: string } | { ok: false; miss: Miss } {
  let size = 0;
  for (const [n, { old_str, new_str }] of edits.entries()) {
    if (old_str === "") return { ok: false, miss: { reason: "empty_old_str", edit: n } };
    if (new_str.includes("\0")) return { ok: false, miss: { reason: "malformed", edit: n } };
    size += old_str.length + new_str.length;
    if (size > MAX_CHARS) return { ok: false, miss: { reason: "too_large" } };
  }
  if (edits.length * text.length > MAX_WORK) return { ok: false, miss: { reason: "too_much_work" } };
  const crlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
  const lf = (part: string) => (crlf ? part.replaceAll("\r\n", "\n") : part);
  const before = lf(text);
  let after = before;
  for (const [n, edit] of edits.entries()) {
    const find = lf(edit.old_str);
    const replace = lf(edit.new_str);
    if (!wellFormed(find) || !wellFormed(replace)) return { ok: false, miss: { reason: "malformed", edit: n } };
    const at = after.indexOf(find);
    if (at === -1) return { ok: false, miss: { reason: "not_found", edit: n } };
    if (after.indexOf(find, at + 1) !== -1) {
      return { ok: false, miss: { reason: "ambiguous", edit: n, count: count(after, find) } };
    }
    after = after.slice(0, at) + replace + after.slice(at + find.length);
  }
  if (after === before) return { ok: false, miss: { reason: "noop" } };
  return { ok: true, text: crlf ? after.replaceAll("\n", "\r\n") : after };
}

function why(miss: Miss, edits: number, chars: number): string {
  switch (miss.reason) {
    case "empty_old_str":
      return `edits[${miss.edit}] old_str is empty`;
    case "malformed":
      return `edits[${miss.edit}] has a NUL character in new_str, or a broken character (an unpaired surrogate) in old_str or new_str`;
    case "too_large":
      return `old_str and new_str add up to more than ${MAX_CHARS} characters over all the edits; make a change that large by editing the file, and publish without edits`;
    case "too_much_work":
      return `${edits} edits on a file of ${chars} characters is more than one publish call will apply; send at most ${Math.max(1, Math.floor(MAX_WORK / Math.max(1, chars)))} edits per call for a file this size, over as many calls as the change needs`;
    case "not_found":
      return `edits[${miss.edit}] old_str does not occur in the file`;
    case "ambiguous":
      return `edits[${miss.edit}] old_str occurs ${(miss.count ?? 0) >= MAX_COUNTED ? "at least " : ""}${miss.count} times in the file; include more of the surrounding text so that it occurs once`;
    case "noop":
      return "the edits leave the file unchanged (it already reads that way); publish the file without edits if it should go out as it is";
  }
}

/** The tool's answer when the edits don't apply: nothing was published, and for an old_str that
 * doesn't match, the file's text when it fits. */
export function missMessage(miss: Miss, edits: Edit[], text: string, room: number): string {
  const head = `No edits were applied and nothing was published: ${why(miss, edits.length, text.length)}.`;
  if (miss.reason !== "not_found" && miss.reason !== "ambiguous") return head;
  const withText = `${head} The file's current text follows; copy old_str from it exactly and send the publish again.\n\n${text}`;
  if (withText.length <= room) return withText;
  return `${head} The file is too long to show here: read the file at file_path, copy old_str from it exactly and send the publish again.`;
}

/** The line a publish with edits adds once it has saved them to the file, or says why it couldn't. */
export function savedMessage(
  edits: number,
  failure?: "write_failed" | "not_writable" | "changed_during_publish" | "hard_linked",
): string {
  const one = edits === 1;
  if (failure === undefined) {
    return one
      ? "The edit was written to the file after it was published, so the file matches the published page."
      : `The ${edits} edits were written to the file after it was published, so the file matches the published page.`;
  }
  const lead = `Published — the page now has ${one ? "the edit" : `the ${edits} edits`}, but the file at file_path does not`;
  if (failure === "write_failed") {
    return (
      `${lead}: writing it back failed, and the file may be partly written. read it before anything else, restore it ` +
      `to the published text (the published page, ${one ? "the edit" : "the edits"} included), and only then publish it ` +
      "again; publishing it as it is could put damaged content on the page."
    );
  }
  return (
    `${lead} (${{ changed_during_publish: "it changed on disk while the publish ran", hard_linked: "it has other names on disk (a hard link)", not_writable: "it can't be written" }[failure]}, so it was left as it is). ` +
    `Apply the same ${one ? "edit" : "edits"} to that file before you publish it again` +
    `${failure === "hard_linked" ? ", and publish it without `edits` while it has other names" : ""}; publishing it as it is would revert ${one ? "it" : "them"}.`
  );
}
