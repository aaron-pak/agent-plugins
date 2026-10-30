// The Artifact tool as the server lists it: its description, input schema and the parameters it refuses.

import type { JSONObject, Tool } from "@modelcontextprotocol/server";

import { MAX_EDITS } from "./edits.ts";

import NATIVE_DESCRIPTION from "./text/native/description.md" with { type: "text" };
import NATIVE_SCHEMA from "./text/native/input-schema.json";
import LOCAL from "./text/local.md" with { type: "text" };
import CODEX_LEAD_TEXT from "./text/codex-lead.md" with { type: "text" };
import CODEX_REST_TEXT from "./text/codex-rest.md" with { type: "text" };

// For Claude Code the tool is Claude Code's own Artifact tool, word for word: text/native/ holds its
// description and input schema as `bun run capture` copies them from a session with claude.ai
// artifacts. text/local.md goes before them; it says what differs on this machine and wins where the
// two disagree. Its {placeholders} are filled in by describe().
const text = (file: string) => file.replace(/\n$/, "");

// Claude Code's ArtifactCheck tool (2.1.300) with its preview on: an add-on to the Artifact tool that
// Claude Code defers behind tool search. Its verify action reads what claude.ai viewers' browsers
// reported, so only preview is here, and the description leaves out the preview sentence on runtime
// capabilities, which a page here doesn't have.
const CHECK_DESCRIPTION =
  "Check a page before publishing it with the `Artifact` tool.\n\n" +
  '**Preview**: `action: "preview"` with a `file_path` renders that one page file locally the way publish wraps it, ' +
  "in light and dark themes at desktop and phone widths, and returns the screenshots with a mechanical checklist of " +
  "layout and load problems, so you can see the page and fix what they show before publishing. It uploads nothing " +
  "and needs no artifact URL.";
// Claude Code's text for the preview action, with this preview's two further checks.
const PREVIEW_ACTION =
  "'preview' renders a local page file before you publish it \u2014 pass `file_path` (one .html file; files " +
  "published beside it are not loaded), optionally `widths` (viewport widths in px, default 1280 and 390) and " +
  "`themes` ('light', 'dark', default both) \u2014 and returns a screenshot per width and theme (each shows at most " +
  "the top 1568 px of the page) plus a checklist of layout and load problems (horizontal overflow, clipped content, " +
  "text split by a grid or flex parent, SVG text too small for a phone, theme-only color variables, blocked or " +
  "local-only loads, diagram and console errors). Nothing is uploaded.";

// Codex drops every description from an input schema over 5,000 bytes (tools/src/json_schema/compaction.rs),
// and cuts an Agent Plugins server's tool descriptions at 1,000 bytes (tools/src/mcp_tool.rs), so a
// Codex client gets this shorter text: the lead, the first-call rule, the Calls list and the
// contract essentials. quickstart returns the full guidance. The plugin's Codex manifest isn't in the
// Agent Plugins format, so the 1,000-byte cut doesn't apply to it, but the text stays within it.
const CODEX_LEAD = text(CODEX_LEAD_TEXT);
const CODEX_REST = text(CODEX_REST_TEXT);

// Claude Code cuts an MCP tool's description at 4,096 characters (2,048 before 2.1.296;
// CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH) but passes its input schema whole, so the description keeps
// the paragraphs that fit and the rest follows, in order, as the input schema's description. The local
// paragraph comes first, with the first-call rule, so that it fits within 2,048 characters too. Claude
// Code also defers MCP tools behind tool search unless they ask to load up front; its own Artifact
// tool is always loaded.
const DESCRIPTION_ROOM = 4096;

/** What the tool's text says about this machine. */
export type Setting = {
  store: string;
  drafts: string;
  /** Whether a first publish opens the page in the browser. */
  opens: boolean;
};

/** The tool's description: the local paragraph, filled in for this machine, and Claude Code's. */
export function describe(setting: Setting): string {
  const local = text(LOCAL)
    .replaceAll("{opened}", () => (setting.opens ? ", which a first publish opens in the browser" : ""))
    .replaceAll("{drafts}", () => setting.drafts)
    .replaceAll("{store}", () => setting.store);
  return `${local}\n\n${text(NATIVE_DESCRIPTION)}`;
}

type Schema = JSONObject;
type ObjectSchema = { type: "object"; properties: Record<string, Schema>; additionalProperties: false };

/** Claude Code's Artifact tool's input schema, as it is. */
export function schema(): ObjectSchema {
  return structuredClone(NATIVE_SCHEMA) as unknown as ObjectSchema;
}

/** Codex's compact schema: the parameters a page here uses, with short descriptions. The server
 * still takes every parameter of Claude Code's schema. */
function compactSchema(): ObjectSchema {
  const string = (description: string): Schema => ({ type: "string", description });
  const pathOrFrom: Schema[] = [
    { type: "string" },
    { type: "object", properties: { from: { type: "string" }, contentType: { type: "string" } }, required: ["from"] },
    { type: "null" },
  ];
  const listed: Schema = {
    type: "array",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { path: { type: "string" }, contentType: { type: "string" } },
          required: ["path"],
        },
      ],
    },
  };
  const pair = { old_str: { type: "string" }, new_str: { type: "string" } };
  const properties: Record<string, Schema> = {
    action: {
      type: "string",
      enum: ["publish", "quickstart", "read", "list", "open", "delete"],
      description: "Publish when omitted.",
    },
    file_path: string("Absolute path of the page file."),
    description: string("One sentence explaining the page."),
    title: string("Fallback name when the page has no <title>."),
    icon: string("One generic word for the tab icon, on a first publish."),
    files: {
      anyOf: [{ type: "object", additionalProperties: { anyOf: pathOrFrom } }, listed],
      description: '{"published/path": "/absolute/source"}; null removes one.',
    },
    edits: {
      type: "array",
      minItems: 1,
      maxItems: MAX_EDITS,
      items: { type: "object", properties: pair, required: ["old_str", "new_str"], additionalProperties: false },
      description: "Exact old_str/new_str pairs applied to file_path, then published and saved.",
    },
    url: string("An artifact's link (from list)."),
    intent: { type: "string", enum: ["document", "slides", "design", "other"], description: "What is being made." },
  };
  return { type: "object", properties, additionalProperties: false };
}

/** The tool for this client: a compact one for Codex, and for anything else the full text, split
 * between the description and the input schema's description. */
export function tool(client: string | undefined, setting: Setting): Tool {
  if (isCodex(client)) {
    const fill = (codex: string) =>
      codex
        .replaceAll("{opened}", () => (setting.opens ? " and opened in the browser" : ""))
        .replaceAll("{open_note}", () => (setting.opens ? " A first publish opens the page." : ""))
        .replaceAll("{drafts}", () => setting.drafts)
        .replaceAll("{store}", () => setting.store);
    return {
      name: "Artifact",
      description: fill(CODEX_LEAD),
      inputSchema: { description: fill(CODEX_REST), ...compactSchema() },
    };
  }
  const paragraphs = describe(setting).split("\n\n");
  let count = 1;
  while (count < paragraphs.length && upFront(paragraphs.slice(0, count + 1)).length <= DESCRIPTION_ROOM) count++;
  return {
    name: "Artifact",
    description: upFront(paragraphs.slice(0, count)),
    inputSchema: { description: paragraphs.slice(count).join("\n\n"), ...schema() },
    _meta: { "anthropic/alwaysLoad": true },
  };
}

const upFront = (paragraphs: string[]) =>
  paragraphs.join("\n\n") + "\n\nThe rest of this description is the `description` of the tool's input schema.";

export const isCodex = (client: string | undefined) => (client ?? "").toLowerCase().includes("codex");

/** The ArtifactCheck tool's input schema. */
export function checkSchema(): ObjectSchema {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["preview"], description: `Omitting it means 'preview'. ${PREVIEW_ACTION}` },
      file_path: { type: "string", description: "preview: the absolute path of the .html page file." },
      widths: {
        type: "array",
        items: { type: "integer", minimum: 320, maximum: 2560 },
        minItems: 1,
        maxItems: 3,
        description: "preview only: viewport widths to render at, in CSS pixels (default 1280 and 390; at most 3).",
      },
      themes: {
        type: "array",
        items: { type: "string", enum: ["light", "dark"] },
        minItems: 1,
        maxItems: 2,
        description:
          "preview only: color themes to render, 'light' and/or 'dark' (default both) \u2014 each sets the page's " +
          "data-theme attribute and the emulated prefers-color-scheme together.",
      },
    },
    additionalProperties: false,
  };
}

/** ArtifactCheck, listed only where preview can run. Claude Code defers its own ArtifactCheck, but
 * its released build has no local preview to offer; deferred, this one went unused even where the
 * skill says to take the look (a dashboard: 0 of 4 runs, against 3 of 3 up front), so it asks to load
 * up front. Codex loads every tool of this server up front (omit_tools_from in the manifest). */
export function checkTool(): Tool {
  return {
    name: "ArtifactCheck",
    description: CHECK_DESCRIPTION,
    inputSchema: checkSchema(),
    _meta: { "anthropic/alwaysLoad": true },
  };
}

/** A short error for a parameter this tool doesn't take, or null. The Artifact tool takes every
 * parameter of Claude Code's; the server answers the ones only claude.ai can act on. */
export function unknownParameter(args: Record<string, unknown>, check = false): string | null {
  const known = Object.keys((check ? checkSchema() : schema()).properties);
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    const takes = known.map((name) => `\`${name}\``).join(", ");
    return `Unknown parameter \`${key}\`. This tool takes ${takes}. Nothing was done.`;
  }
  return null;
}
