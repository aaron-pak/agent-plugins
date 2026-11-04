// Finding Claude Code sessions on this machine and the moments in them.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  type Rec,
  type Response,
  type Turn,
  chainTo,
  clip,
  isHuman,
  mainChain,
  readTranscript,
  textOf,
  turnsOf,
  usedIn,
} from "./transcript.ts";

export function projectsDir(): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(config, "projects");
}

export type SessionFile = { id: string; path: string; project: string; mtimeMs: number };

export function listSessions(root = projectsDir()): SessionFile[] {
  if (!existsSync(root)) return [];
  const out: SessionFile[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      out.push({ id: basename(name, ".jsonl"), path, project, mtimeMs: statSync(path).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A session id, a unique id prefix, or a path to a transcript. */
export function findSession(ref: string, root = projectsDir()): SessionFile {
  if (ref.endsWith(".jsonl") || ref.includes("/")) {
    const path = resolve(ref);
    if (!existsSync(path)) throw new Error(`no transcript at ${path}`);
    return {
      id: basename(path, ".jsonl"),
      path,
      project: basename(resolve(path, "..")),
      mtimeMs: statSync(path).mtimeMs,
    };
  }
  const matches = listSessions(root).filter((s) => s.id === ref || s.id.startsWith(ref));
  const exact = matches.filter((s) => s.id === ref);
  const pick = exact.length ? exact : matches;
  if (pick.length === 0) throw new Error(`no session ${ref} under ${root}`);
  if (pick.length > 1) throw new Error(`${ref} matches ${pick.length} sessions: ${pick.map((s) => s.id).join(", ")}`);
  return pick[0]!;
}

/** "7d", "12h", "30m", or a date. */
export function parseSince(value: string): number {
  const rel = /^(\d+)([dhm])$/.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2] as "d" | "h" | "m"];
    return Date.now() - n * unit;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`--since takes 7d, 12h, 30m or a date, not ${value}`);
  return t;
}

export type Moment = {
  requestId: string;
  /** Last record of the response. */
  replyUuid: string;
  /** The person's message that started the response's turn. */
  turnUuid: string;
  /** The person's message that reacted to it, when the moment was given that way. */
  reactionUuid?: string;
  timestamp?: string;
};

export type Resolved = { moment: Moment; turn: Turn; response: Response; warnings: string[] };

function locate(turns: Turn[], requestId: string): { turn: Turn; response: Response } | undefined {
  for (const turn of turns) {
    const response = turn.responses.find((r) => r.requestId === requestId);
    if (response) return { turn, response };
  }
  return undefined;
}

/** The reply a person's message reacted to: the last response of the turn before it, or, when
 * notifications arrived in that turn, the last response before the first of them, since those
 * responses are what the person had in front of them. */
function reactedTo(turns: Turn[], reaction: Rec, warnings: string[]): { turn: Turn; response: Response } {
  const at = turns.findIndex((t) => t.user.uuid === reaction.uuid);
  const before = turns[at - 1];
  if (!before || before.responses.length === 0) throw new Error("that message has no reply before it");
  const first = before.interjections[0];
  if (first && first.after > 0 && first.after < before.responses.length) {
    warnings.push(
      `notifications arrived during the turn before that message; picked the reply before the first of them (${before.responses.length - first.after} later replies passed over). Re-point with --moment <request id> if that's wrong.`,
    );
    return { turn: before, response: before.responses[first.after - 1]! };
  }
  return { turn: before, response: before.responses[before.responses.length - 1]! };
}

/** A moment from a request id, a record uuid, words from the person's reaction, or nothing (the
 * reply the latest message reacted to, which is the usual case when saving the current session). */
export function resolveMoment(records: Rec[], ref: string | undefined): Resolved {
  const chain = mainChain(records);
  const turns = turnsOf(chain);
  const warnings: string[] = [];
  let found: { turn: Turn; response: Response } | undefined;
  let reaction: Rec | undefined;

  if (ref === undefined) {
    const humans = chain.filter(isHuman);
    reaction = humans[humans.length - 1];
    if (!reaction) throw new Error("the session has no messages");
    found = reactedTo(turns, reaction, warnings);
  } else if (ref.startsWith("req_")) {
    found = locate(turns, ref);
    if (!found) {
      // The request may sit on a branch the session later left, or before a compaction.
      const rec = records.find((r) => r.requestId === ref && r.uuid);
      if (rec?.uuid) found = locate(turnsOf(chainTo(records, rec.uuid, true)), ref);
    }
    if (!found) throw new Error(`no response with request id ${ref}`);
  } else {
    const rec = records.find((r) => r.uuid === ref);
    if (rec?.type === "assistant" && rec.requestId) {
      found = locate(turnsOf(chainTo(records, rec.uuid!, true)), rec.requestId);
    } else if (rec && isHuman(rec)) {
      reaction = rec;
      found = reactedTo(turnsOf(chainTo(records, rec.uuid!, true)), rec, warnings);
    } else if (!rec) {
      const needle = ref.toLowerCase();
      const humans = chain.filter((r) => isHuman(r) && textOf(r).toLowerCase().includes(needle));
      if (humans.length === 0) throw new Error(`no message contains "${ref}"`);
      if (humans.length > 1) warnings.push(`${humans.length} messages contain "${ref}"; used the latest`);
      reaction = humans[humans.length - 1]!;
      found = reactedTo(turns, reaction, warnings);
    }
    if (!found) throw new Error(`${ref} is neither a reply, a message nor a request id`);
  }

  const { turn, response } = found;
  return {
    moment: {
      requestId: response.requestId,
      replyUuid: response.uuid,
      turnUuid: turn.user.uuid ?? "",
      reactionUuid: reaction?.uuid,
      timestamp: response.timestamp,
    },
    turn,
    response,
    warnings,
  };
}

export type Hit = {
  session: SessionFile;
  turn: number;
  requestId?: string;
  at?: string;
  user: string;
  why: string[];
};

export type SearchOptions = { since?: number; used?: string; userText?: string; project?: string; limit?: number };

export function searchSessions(options: SearchOptions, root = projectsDir()): Hit[] {
  const pattern = options.userText ? new RegExp(options.userText, "i") : undefined;
  const hits: Hit[] = [];
  for (const session of listSessions(root)) {
    if (options.since !== undefined && session.mtimeMs < options.since) continue;
    if (options.project && !session.project.includes(options.project)) continue;
    let turns: Turn[];
    try {
      turns = turnsOf(mainChain(readTranscript(session.path)));
    } catch {
      continue;
    }
    for (const turn of turns) {
      const at = Date.parse(turn.user.timestamp ?? "");
      if (options.since !== undefined && !Number.isNaN(at) && at < options.since) continue;
      const why: string[] = [];
      if (options.used) {
        const used = usedIn(turn);
        if (!used.includes(options.used)) continue;
        why.push(`used ${options.used}`);
      }
      if (pattern) {
        const text = textOf(turn.user);
        const m = pattern.exec(text);
        if (!m) continue;
        const start = Math.max(0, m.index - 60);
        why.push(`"${clip(text.slice(start, m.index + m[0].length + 60), 160)}"`);
      }
      if (!why.length) continue;
      const before = turns[turn.index - 2];
      const last = before?.responses[before.responses.length - 1];
      hits.push({
        session,
        turn: turn.index,
        requestId: pattern ? last?.requestId : turn.responses[0]?.requestId,
        at: turn.user.timestamp,
        user: clip(textOf(turn.user), 140),
        why,
      });
      if (options.limit && hits.length >= options.limit) return hits;
    }
  }
  return hits;
}
