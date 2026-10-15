// The Artifact tool as the server lists it: its description, input schema and the parameters it refuses.

import type { JSONObject, Tool } from "@modelcontextprotocol/server";

import { MAX_EDITS } from "./edits.ts";

import DESCRIPTION from "./text/description.md" with { type: "text" };
import CODEX_LEAD_TEXT from "./text/codex-lead.md" with { type: "text" };
import CODEX_REST_TEXT from "./text/codex-rest.md" with { type: "text" };

export const INSTRUCTIONS =
  "This server's Artifact tool publishes HTML pages (reports, explainers, plans, dashboards, tools, " +
  'mockups) as local files; before writing a new one, call it with action "quickstart".';

// text/description.md is Claude Code's Artifact tool description (2.1.300), less what only claude.ai
// can do: runtime capabilities, the shared database, watching, pinning, the asset store, and Artifact
// types beyond the rule that a new artifact starts with quickstart. Its {placeholders} are filled in
// by describe().
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

// Codex drops every description from an input schema over 5,000 bytes (tools/src/json_schema.rs),
// and cuts an Agent Plugins server's tool descriptions at 1,000 bytes (tools/src/mcp_tool.rs), so a
// Codex client gets this shorter text: the lead, the first-call rule, the Calls list and the
// contract essentials. quickstart returns the full guidance. The plugin's Codex manifest isn't in the
// Agent Plugins format, so the 1,000-byte cut doesn't apply to it, but the text stays within it.
const CODEX_LEAD = text(CODEX_LEAD_TEXT);
const CODEX_REST = text(CODEX_REST_TEXT);

// Claude Code cuts an MCP tool's description at 4,096 characters (2,048 before 2.1.296;
// CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH) but passes its input schema whole, so the description keeps
// the paragraphs that fit and the rest follows, in order, as the input schema's description. Claude
// Code also defers MCP tools behind tool search unless they ask to load up front; its own Artifact
// tool is always loaded.
const DESCRIPTION_ROOM = 4096;
const FIRST_CALL =
  ' When the person wants something new made, Claude\'s first call is `action: "quickstart"`, before' +
  " loading a skill or writing a file (see **New artifacts**).";

// Parameters of Claude Code's Artifact tool that this one doesn't take, with what to do here instead.
// The rest get a bare "Unknown parameter", like any other.
const INSTEAD: Record<string, string> = {
  capabilities: "a page here is static HTML",
  type_url: 'every artifact here is a plain page: call action "quickstart", then publish an HTML file',
  asset: "pass images and other files with `files`",
  asset_ids: "pass images and other files with `files`",
  from_url: "pass images and other files with `files`",
  file_paths: "pass images and other files with `files`",
};

/** What the tool's text says about this machine. */
export type Setting = {
  store: string;
  drafts: string;
  /** Whether a first publish opens the page in the browser. */
  opens: boolean;
};

/** The tool's description, filled in for this machine. */
export function describe(setting: Setting): string {
  return text(DESCRIPTION)
    .replaceAll("{opened}", () => (setting.opens ? ", and opened in the browser" : ""))
    .replaceAll("{open_note}", () => (setting.opens ? " A first publish opens the page in the browser." : ""))
    .replaceAll("{drafts}", () => setting.drafts)
    .replaceAll("{store}", () => setting.store);
}

type Schema = JSONObject;
type ObjectSchema = { type: "object"; properties: Record<string, Schema>; additionalProperties: false };

export function schema(compact = false): ObjectSchema {
  const actions = ["publish", "quickstart", "read", "list", "open", "delete"];
  const listed = actions.map((action) => `'${action}'`).join(", ");
  const source: Schema = { type: "string", description: "An absolute path to the source file." };
  const fromSource: Schema = {
    type: "object",
    properties: { from: source, contentType: { type: "string" } },
    required: ["from"],
  };
  const mapItems: Schema[] = [source, fromSource, { type: "null" }];
  const filesMap: Schema = { type: "object", additionalProperties: { anyOf: mapItems } };
  const filesList: Schema = {
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
  const properties: Record<string, Schema> = {
    action: {
      type: "string",
      enum: actions,
      description: `One of ${listed}. Omitting it means 'publish'. **Calls** in the description says what each one does and takes, except as noted here.`,
    },
    file_path: {
      type: "string",
      description:
        "publish: the absolute path of the page file (.html, or .md only when a skill says so). A short, distinctive basename also serves as the title when nothing else gives one.",
    },
    description: { type: "string", description: "publish: one sentence explaining the page." },
    title: {
      type: "string",
      description:
        "publish: the fallback title for an HTML page whose file has no <title>. It is a name, not a summary, and Claude keeps it the same across redeploys.",
    },
    icon: {
      type: "string",
      description:
        "publish: one short generic word for the page's tab icon, such as chart, calendar, recipe, code or map: a plain signifier, never a product or brand name. Include it on every page's first publish and omit it on a redeploy so the artifact keeps its icon, passing a new one only when the person asks.",
    },
    files: {
      anyOf: [filesMap, filesList],
      description:
        'publish: supporting files, as {"published/path": "/absolute/source/path"} (or {"from": "/absolute/source/path", "contentType": "..."}); null removes one. A list of paths relative to the page\'s folder publishes each file at that same path.',
    },
    edits: {
      type: "array",
      minItems: 1,
      maxItems: MAX_EDITS,
      items: {
        type: "object",
        properties: {
          old_str: { type: "string", description: "Text copied exactly from the file; must occur once." },
          new_str: { type: "string", description: "Its replacement; empty deletes old_str." },
        },
        required: ["old_str", "new_str"],
        additionalProperties: false,
      },
      description:
        "publish: small changes Claude makes to the file at `file_path` in this same call, instead of editing the file with Edit and publishing after. Use it on a page (add `url` to update an artifact from another file or a later session). Not allowed with `files`. Each old_str is text copied exactly from the file as it now stands and must occur in it exactly once; new_str takes its place (empty deletes it). The edits apply in order, all or none: the file is published with them and then saved with them on disk, so it stays the source for later changes; on a miss nothing is changed or published, and the result says which edit failed and why.",
    },
    url: {
      type: "string",
      description: "publish: an existing artifact's link to update. read, open and delete: the artifact's link.",
    },
    intent: {
      type: "string",
      enum: ["document", "slides", "design", "other"],
      description:
        "quickstart: what is being made: 'document' (a report, memo or other text to read), 'slides' (a deck or one slide), 'design' (a visual design or prototype), 'other' (anything else, or unsure). Each is made as a plain page.",
    },
  };
  if (compact) {
    const short: Record<string, string> = {
      action: "Publish when omitted.",
      file_path: "Absolute path of the page file.",
      description: "One sentence explaining the page.",
      title: "Fallback name when the page has no <title>.",
      icon: "One generic word for the tab icon, on a first publish.",
      files: '{"published/path": "/absolute/source"}; null removes one.',
      edits: "Exact old_str/new_str pairs applied to file_path, then published and saved.",
      url: "An artifact's link (from list).",
      intent: "What is being made.",
    };
    for (const [name, description] of Object.entries(short)) properties[name]!.description = description;
    const pair = (properties.edits!.items as { properties: Record<string, Schema> }).properties;
    pair.old_str = { type: "string" };
    pair.new_str = { type: "string" };
    mapItems[0] = { type: "string" };
    fromSource.properties = { from: { type: "string" }, contentType: { type: "string" } };
  }
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
      inputSchema: { description: fill(CODEX_REST), ...schema(true) },
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
  paragraphs.join("\n\n") +
  FIRST_CALL +
  " The rest of this description is the `description` of the tool's input schema.";

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

/** ArtifactCheck, listed only where preview can run. Like Claude Code's, it isn't loaded up front in
 * Claude Code; Codex loads every tool of this server up front (omit_tools_from in the manifest). */
export function checkTool(): Tool {
  return { name: "ArtifactCheck", description: CHECK_DESCRIPTION, inputSchema: checkSchema() };
}

/** A short error for a parameter this tool doesn't take, or null. */
export function unknownParameter(args: Record<string, unknown>, check = false): string | null {
  const known = Object.keys((check ? checkSchema() : schema()).properties);
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    const instead = check ? undefined : INSTEAD[key];
    const takes = known.map((name) => `\`${name}\``).join(", ");
    return (
      `Unknown parameter \`${key}\`` + (instead ? `: ${instead}` : "") + `. This tool takes ${takes}. Nothing was done.`
    );
  }
  return null;
}
