// `edits` on a publish, applied as Claude Code's Artifact tool applies them.

import { describe, expect, test } from "bun:test";

import { applyEdits, editsOf, missMessage, savedMessage } from "../src/edits.ts";

describe("applyEdits", () => {
  test("applies exact pairs in order", () => {
    const result = applyEdits("<h1>Old</h1>\n<p>One</p>\n", [
      { old_str: "Old", new_str: "New" },
      { old_str: "<p>One</p>", new_str: "<p>One</p>\n<p>Two</p>" },
    ]);
    expect(result).toEqual({ ok: true, text: "<h1>New</h1>\n<p>One</p>\n<p>Two</p>\n" });
  });

  test("refuses an old_str that is missing, repeated, or empty, and a change that changes nothing", () => {
    expect(applyEdits("a b", [{ old_str: "c", new_str: "d" }])).toEqual({
      ok: false,
      miss: { reason: "not_found", edit: 0 },
    });
    expect(applyEdits("a a a", [{ old_str: "a", new_str: "b" }])).toEqual({
      ok: false,
      miss: { reason: "ambiguous", edit: 0, count: 3 },
    });
    expect(applyEdits("a", [{ old_str: "", new_str: "b" }])).toEqual({
      ok: false,
      miss: { reason: "empty_old_str", edit: 0 },
    });
    expect(applyEdits("a", [{ old_str: "a", new_str: "a" }])).toEqual({ ok: false, miss: { reason: "noop" } });
  });

  test("counts each edit against the text the earlier ones left", () => {
    expect(
      applyEdits("x", [
        { old_str: "x", new_str: "xx" },
        { old_str: "x", new_str: "y" },
      ]),
    ).toEqual({
      ok: false,
      miss: { reason: "ambiguous", edit: 1, count: 2 },
    });
  });

  test("edits a CRLF file with LF pairs and keeps its line endings", () => {
    expect(
      applyEdits("<p>a</p>\r\n<p>b</p>\r\n", [{ old_str: "<p>a</p>\n<p>b</p>", new_str: "<p>c</p>\n<p>d</p>" }]),
    ).toEqual({
      ok: true,
      text: "<p>c</p>\r\n<p>d</p>\r\n",
    });
  });
});

describe("messages", () => {
  test("shows the file back for an old_str that doesn't match, when it fits", () => {
    const edits = [{ old_str: "c", new_str: "d" }];
    const miss = { reason: "not_found" as const, edit: 0 };
    expect(missMessage(miss, edits, "a b", 1000)).toBe(
      "No edits were applied and nothing was published: edits[0] old_str does not occur in the file. The file's current text follows; copy old_str from it exactly and send the publish again.\n\na b",
    );
    expect(missMessage(miss, edits, "a b", 10)).toEndWith(
      "The file is too long to show here: Read the file at file_path, copy old_str from it exactly and send the publish again.",
    );
  });

  test("checks the shape of the edits", () => {
    expect(editsOf([])).toBeString();
    expect(editsOf([{ old_str: "a" }])).toBe("edits[0] must be {old_str, new_str}, both strings.");
    expect(editsOf([{ old_str: "a", new_str: "b" }])).toEqual([{ old_str: "a", new_str: "b" }]);
  });

  test("says whether the file got the edits", () => {
    expect(savedMessage(1)).toBe(
      "The edit was written to the file after it was published, so the file matches the published page.",
    );
    expect(savedMessage(2, "changed_during_publish")).toStartWith(
      "Published — the page now has the 2 edits, but the file at file_path does not (it changed on disk",
    );
    expect(savedMessage(1, "not_writable")).toBe(
      "Published — the page now has the edit, but the file at file_path does not (it can't be written, so it was " +
        "left as it is). Apply the same edit to that file with Edit before you publish it again; publishing it as " +
        "it is would revert it.",
    );
  });
});
