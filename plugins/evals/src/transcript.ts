// Reading Claude Code session transcripts: the .jsonl files under ~/.claude/projects/. Each line is a
// record. Conversation records (user, assistant, attachment, system) carry a uuid and the uuid of the
// record before them (parentUuid), so a transcript is a tree: an edit or rewind starts a branch, and a
// compaction starts a new root that points back with logicalParentUuid. One API response is split
// into one assistant record per content block, all sharing a requestId.

import { readFileSync } from "node:fs";

export type Block = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
};

export type Rec = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  requestId?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  effort?: string;
  origin?: { kind?: string } | null;
  subtype?: string;
  message?: { id?: string; role?: string; model?: string; content?: string | Block[] };
  attachment?: { type?: string; files?: InstructionFile[]; [key: string]: unknown };
  rendered?: { content: string }[];
  [key: string]: unknown;
};

export type InstructionFile = { path: string; type?: string; content: string };

export function readTranscript(path: string): Rec[] {
  const records: Rec[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Rec);
    } catch {
      // A line cut off by a crash or a write in progress; the rest of the file is still good.
    }
  }
  return records;
}

export function blocks(rec: Rec): Block[] {
  const content = rec.message?.content;
  if (content === undefined) return [];
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function textOf(rec: Rec): string {
  return blocks(rec)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/** A message a person typed (or sent from an app), as opposed to tool results, notifications and
 * the text Claude Code inserts for skills, images and compaction. */
export function isHuman(rec: Rec): boolean {
  if (rec.type !== "user" || rec.isMeta || rec.isCompactSummary || rec.isSidechain) return false;
  if (blocks(rec).some((b) => b.type === "tool_result")) return false;
  if (rec.origin && rec.origin.kind !== undefined && rec.origin.kind !== "human") return false;
  const text = textOf(rec).trimStart();
  return !text.startsWith("<task-notification>") && !text.startsWith("<local-command-stdout>");
}

/** A user-role record that is neither a person's message nor a tool result: a task notification,
 * a message from another session, command output. Those arrive mid-turn. */
export function isInterjection(rec: Rec): boolean {
  if (rec.type !== "user" || rec.isSidechain || isHuman(rec)) return false;
  if (rec.isMeta || rec.isCompactSummary) return false;
  return !blocks(rec).some((b) => b.type === "tool_result");
}

export function byUuid(records: Rec[]): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const rec of records) if (rec.uuid) map.set(rec.uuid, rec);
  return map;
}

/** The records from the root to `uuid`, in order. With `acrossCompaction`, a compaction boundary is
 * followed back to the conversation before it (for reading); without, the chain stops there, which is
 * what a resumed session sees. */
export function chainTo(records: Rec[], uuid: string, acrossCompaction = false): Rec[] {
  const map = byUuid(records);
  const chain: Rec[] = [];
  const seen = new Set<string>();
  let current = map.get(uuid);
  while (current && current.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    const next = current.parentUuid ?? (acrossCompaction ? current.logicalParentUuid : null);
    current = next ? map.get(next) : undefined;
  }
  return chain.reverse();
}

/** The last conversation record on the main thread: where the session currently ends. */
export function leaf(records: Rec[]): Rec | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]!;
    if (rec.uuid && !rec.isSidechain && ["user", "assistant", "attachment", "system"].includes(rec.type)) return rec;
  }
  return undefined;
}

export function mainChain(records: Rec[], acrossCompaction = true): Rec[] {
  const end = leaf(records);
  return end?.uuid ? chainTo(records, end.uuid, acrossCompaction) : [];
}

export type ToolCall = { name: string; input: unknown };

export type Response = {
  requestId: string;
  /** uuid of the response's last record. */
  uuid: string;
  firstUuid: string;
  timestamp?: string;
  model?: string;
  text: string;
  tools: ToolCall[];
};

export type Turn = {
  index: number;
  /** The person's message that started the turn. */
  user: Rec;
  responses: Response[];
  /** Notifications and similar that arrived during the turn, each with the number of responses
   * that came before it. */
  interjections: { rec: Rec; after: number }[];
  /** Everything in the turn after the person's message, in order. */
  records: Rec[];
};

function responseOf(group: Rec[]): Response {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const all = group.flatMap(blocks);
  return {
    requestId: first.requestId ?? first.uuid ?? "",
    uuid: last.uuid ?? "",
    firstUuid: first.uuid ?? "",
    timestamp: first.timestamp,
    model: first.message?.model,
    text: all
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim(),
    tools: all.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name ?? "", input: b.input })),
  };
}

function responseKey(rec: Rec): string | undefined {
  return rec.requestId ?? rec.message?.id ?? rec.uuid;
}

export function turnsOf(chain: Rec[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  let group: Rec[] = [];
  const flush = () => {
    if (turn && group.length) turn.responses.push(responseOf(group));
    group = [];
  };
  for (const rec of chain) {
    if (isHuman(rec)) {
      flush();
      turn = { index: turns.length + 1, user: rec, responses: [], interjections: [], records: [] };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    turn.records.push(rec);
    if (rec.type === "assistant") {
      if (group[0] && responseKey(rec) !== responseKey(group[0])) flush();
      group.push(rec);
    } else if (isInterjection(rec)) {
      // Tool results arrive between the blocks of one response, so only a notification ends one.
      flush();
      turn.interjections.push({ rec, after: turn.responses.length });
    }
  }
  flush();
  return turns;
}

/** Names a turn used: tools, skills (Skill input), and MCP servers (mcp__<server>__<tool>). */
export function usedIn(turn: Turn): string[] {
  const used = new Set<string>();
  for (const response of turn.responses) {
    for (const call of response.tools) {
      used.add(call.name);
      const input = call.input as { skill?: unknown; command?: unknown } | undefined;
      if (call.name === "Skill" && typeof input?.skill === "string") {
        used.add(input.skill);
        const bare = input.skill.split(":").pop();
        if (bare) used.add(bare);
        if (input.skill.includes(":")) used.add(input.skill.split(":")[0]!);
      }
      const mcp = /^mcp__(.+?)__/.exec(call.name);
      if (mcp) used.add(mcp[1]!);
    }
  }
  const slash = /^\s*<command-name>\/?([\w:-]+)<\/command-name>/.exec(textOf(turn.user));
  if (slash) used.add(slash[1]!);
  return [...used];
}

export function instructionsIn(chain: Rec[]): InstructionFile[] {
  const files = new Map<string, InstructionFile>();
  for (const rec of chain) {
    if (rec.type !== "attachment" || rec.attachment?.type !== "instructions") continue;
    for (const file of rec.attachment.files ?? []) files.set(file.path, file);
  }
  return [...files.values()];
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
