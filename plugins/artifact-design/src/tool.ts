// The Artifact tool as the server lists it: its description, input schema and the parameters it refuses.

import type { JSONObject, Tool } from "@modelcontextprotocol/server";

import DESCRIPTION from "./text/description.md" with { type: "text" };
import CODEX_LEAD_TEXT from "./text/codex-lead.md" with { type: "text" };
import CODEX_REST_TEXT from "./text/codex-rest.md" with { type: "text" };

export const INSTRUCTIONS =
  "This server's Artifact tool publishes HTML pages (reports, explainers, plans, dashboards, " +
  "tools, mockups) as local files, the way claude.ai's Artifact tool publishes them. " +
  "It stands in for Claude Code's own Artifact tool where that tool is off or absent: its full name " +
  "carries a server prefix (mcp__plugin_artifact-design_artifact__Artifact in Claude Code, " +
  "mcp__artifact__Artifact in Codex), and " +
  '"Artifact" in its description, in quickstart\'s result and in the skills means this tool. ' +
  'Before writing a new artifact, call Artifact with action "quickstart"; then write the page ' +
  "to a file and publish it with Artifact in the same message, which wraps it in the page " +
  "skeleton. Give the user the published link. " +
  "Where a built-in Artifact tool that publishes to claude.ai is also available, use that one " +
  "instead; this server is for harnesses without it.";

// text/description.md is Claude Code's Artifact tool description (2.1.293), less what only claude.ai
// can do: runtime capabilities, the shared database, watching, pinning, the asset store, and Artifact
// types beyond the rule that a new artifact starts with quickstart. Its {placeholders} are filled in
// by describe().
const text = (file: string) => file.replace(/\n$/, "");

// Claude Code's ArtifactCheck wording (2.1.294) for its preview, where it applies here.
const PREVIEW_BULLET =
  "\n- **preview**: takes `file_path` (one .html page, before or after publishing) and renders that one page file " +
  "locally the way publish wraps it, in light and dark themes at desktop and phone widths (1280 and 390px), and " +
  "returns the screenshots (each shows at most the top 1568px of the page) with a mechanical checklist of layout " +
  "and load problems (horizontal overflow, clipped content, text split by a grid or flex parent, SVG text too small " +
  "for a phone, theme-only color variables, blocked or local-only loads, diagram and console errors), so Claude can " +
  "see the page and fix what they show before publishing. Files published beside it are not loaded. Nothing is published.";

// Codex shows at most 1,000 bytes of an MCP tool's description (codex-rs/tools/src/mcp_tool.rs)
// and drops every description from an input schema over 5,000 bytes (tools/src/json_schema/
// compaction.rs), so a Codex client gets this shorter text: the lead, the first-call rule, the
// Calls list and the contract essentials. quickstart returns the full guidance.
const CODEX_LEAD = text(CODEX_LEAD_TEXT);
const CODEX_REST = text(CODEX_REST_TEXT);
const CODEX_PREVIEW =
  "\n- preview: file_path (one .html page); renders it at 1280 and 390px in light and dark and returns the " +
  "screenshots with a checklist of layout and load problems, to fix before publishing.";

// Claude Code cuts an MCP tool's description at 2048 characters (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH)
// but passes its input schema whole, so the description keeps its first paragraph and the rest follows,
// in order, as the input schema's description. Claude Code also defers MCP tools behind tool search
// unless they ask to load up front; its own Artifact tool is always loaded.
const FIRST_CALL =
  ' When the person wants something new made, Claude\'s first call is `action: "quickstart"`, before' +
  " loading a skill or writing a file (see **Artifact types**).";

// Parameters of claude.ai's Artifact tool that this one doesn't have, and why.
const CLAUDE_AI_ONLY: Record<string, string> = {
  capabilities: "runtime capabilities exist only on claude.ai",
  type_url: "Artifact types exist only on claude.ai",
  asset: "the asset store exists only on claude.ai",
  asset_ids: "the asset store exists only on claude.ai",
  from_url: "the asset store exists only on claude.ai",
  file_paths: "the asset store exists only on claude.ai",
};
const CLAUDE_AI_PARAMS = new Set([
  "after",
  "auto_open",
  "contract",
  "design_systems",
  "favicon",
  "force",
  "label",
  "limit",
  "out_dir",
  "overwrite_unread",
  "page",
  "path",
  "paths",
  "pin",
  "prompt",
  "root",
  "scope",
  "type",
  "type_query",
]);

/** What the tool's text says about this machine. */
export type Setting = {
  store: string;
  drafts: string;
  /** Whether a first publish opens the page in the browser. */
  opens: boolean;
};

/** The tool's description, with the preview bullet only when preview is offered. */
export function describe(preview: boolean, setting: Setting): string {
  return text(DESCRIPTION)
    .replaceAll("{opened}", () => (setting.opens ? ", and opened in the browser" : ""))
    .replaceAll("{open_note}", () => (setting.opens ? " A first publish opens the page in the browser." : ""))
    .replaceAll("{preview}", () => (preview ? PREVIEW_BULLET : ""))
    .replaceAll("{drafts}", () => setting.drafts)
    .replaceAll("{store}", () => setting.store);
}

type Schema = JSONObject;
type ObjectSchema = { type: "object"; properties: Record<string, Schema>; additionalProperties: false };

export function schema(preview: boolean, compact = false): ObjectSchema {
  const actions = ["publish", "quickstart", ...(preview ? ["preview"] : []), "read", "list", "open", "delete"];
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
        "publish" +
        (preview ? " and preview" : "") +
        ": the absolute path of the page file (.html, or .md only when a skill says so). A short, distinctive basename also serves as the title when nothing else gives one.",
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
    url: {
      type: "string",
      description: "publish: an existing artifact's link to update. read, open and delete: the artifact's link.",
    },
    intent: {
      type: "string",
      enum: ["document", "slides", "design", "other"],
      description:
        "quickstart: what is being made: 'document' (text to read or edit together), 'slides' (a deck or one slide), 'design' (a visual design or prototype on a canvas), 'other' (anything else, or unsure). Only plain pages are made here.",
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
      url: "An artifact's link (from list).",
      intent: "What is being made.",
    };
    for (const [name, description] of Object.entries(short)) properties[name]!.description = description;
    mapItems[0] = { type: "string" };
    fromSource.properties = { from: { type: "string" }, contentType: { type: "string" } };
  }
  return { type: "object", properties, additionalProperties: false };
}

/** The tool for this client: a compact one for Codex, and for anything else the full text, split
 * between the description and the input schema's description. */
export function tool(preview: boolean, client: string | undefined, setting: Setting): Tool {
  if ((client ?? "").toLowerCase().includes("codex")) {
    const fill = (codex: string) =>
      codex
        .replaceAll("{opened}", () => (setting.opens ? " and opened in the browser" : ""))
        .replaceAll("{open_note}", () => (setting.opens ? " A first publish opens the page." : ""))
        .replaceAll("{preview}", () => (preview ? CODEX_PREVIEW : ""))
        .replaceAll("{drafts}", () => setting.drafts)
        .replaceAll("{store}", () => setting.store);
    return {
      name: "Artifact",
      description: fill(CODEX_LEAD),
      inputSchema: { description: fill(CODEX_REST), ...schema(preview, true) },
    };
  }
  const full = describe(preview, setting);
  const split = full.indexOf("\n\n");
  const lead = split === -1 ? full : full.slice(0, split);
  const rest = split === -1 ? "" : full.slice(split + 2);
  return {
    name: "Artifact",
    description: lead + FIRST_CALL + " The rest of this description is the `description` of the tool's input schema.",
    inputSchema: { description: rest, ...schema(preview) },
    _meta: { "anthropic/alwaysLoad": true },
  };
}

/** A short error for a parameter this tool doesn't take, or null. */
export function unknownParameter(args: Record<string, unknown>, preview: boolean): string | null {
  const known = Object.keys(schema(true).properties);
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    const why = CLAUDE_AI_ONLY[key] ?? (CLAUDE_AI_PARAMS.has(key) ? "it belongs to claude.ai's Artifact tool" : null);
    const takes = Object.keys(schema(preview).properties)
      .map((name) => `\`${name}\``)
      .join(", ");
    return `Unknown parameter \`${key}\`` + (why ? `: ${why}` : "") + `. This tool takes ${takes}. Nothing was done.`;
  }
  return null;
}
