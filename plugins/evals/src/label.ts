// Checking a judge against the user. `evals label` writes a sheet of what each judged grader saw,
// with the criteria and no verdicts; the user fills in pass or fail; `evals agree` counts how often
// the judge said the same. A judged score means little until this number is known.

import { loadResult } from "./compare.ts";

type JudgedGrader = { name: string; passed: boolean; judgeVotes?: boolean[]; criteria?: string; evidence?: string };
type Run = { graders?: JudgedGrader[] };
type Case = { name: string; arms: { with: Run[]; without?: Run[] } };

export type Item = { id: string; criteria: string; evidence: string; judge: boolean };

/** Every judged grader result in a result, in a stable order. */
export function judgedItems(path: string): Item[] {
  const result = loadResult(path) as unknown as { cases: Case[] };
  const items: Item[] = [];
  for (const c of result.cases) {
    for (const [arm, runs] of [
      ["with", c.arms.with],
      ["without", c.arms.without ?? []],
    ] as const) {
      runs.forEach((r, i) => {
        for (const g of r.graders ?? []) {
          if (!g.judgeVotes) continue;
          items.push({
            id: `${c.name} · ${arm}-${i + 1} · ${g.name}`,
            criteria: g.criteria ?? "(criteria not recorded; see the case's grader file)",
            evidence: g.evidence ?? "",
            judge: g.passed,
          });
        }
      });
    }
  }
  return items;
}

/** The sheet to fill in: one section per judged result, blind to the judge's verdict. */
export function labelSheet(items: Item[]): string {
  const head =
    "# Label these before you look at the grades\n\nFor each one, write `pass` or `fail` after `verdict:`. Leave it blank to skip. Judge only by the criteria.\n";
  const sections = items.map(
    (it) =>
      `## ${it.id}\n\n**Criteria:** ${it.criteria.trim()}\n\n**What the judge saw:**\n\n~~~~\n${it.evidence.trim()}\n~~~~\n\nverdict: \n`,
  );
  return [head, ...sections].join("\n");
}

export function readLabels(sheet: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  let id: string | undefined;
  let fenced = false;
  for (const line of sheet.split("\n")) {
    if (line.startsWith("~~~~")) fenced = !fenced;
    if (fenced) continue;
    const heading = /^## (.+)$/.exec(line);
    if (heading) id = heading[1]!.trim();
    const verdict = /^verdict:\s*(\S+)/i.exec(line);
    if (id && verdict) {
      const v = verdict[1]!.toLowerCase();
      if (["pass", "yes", "y", "p", "1", "true"].includes(v)) labels.set(id, true);
      else if (["fail", "no", "n", "f", "0", "false"].includes(v)) labels.set(id, false);
    }
  }
  return labels;
}

export type Agreement = {
  labeled: number;
  agreed: number;
  /** The judge passed what the user failed. */
  tooLenient: string[];
  /** The judge failed what the user passed. */
  tooStrict: string[];
  unknown: string[];
};

export function agreement(items: Item[], labels: Map<string, boolean>): Agreement {
  const byId = new Map(items.map((it) => [it.id, it]));
  const out: Agreement = { labeled: 0, agreed: 0, tooLenient: [], tooStrict: [], unknown: [] };
  for (const [id, human] of labels) {
    const it = byId.get(id);
    if (!it) {
      out.unknown.push(id);
      continue;
    }
    out.labeled++;
    if (it.judge === human) out.agreed++;
    else (it.judge ? out.tooLenient : out.tooStrict).push(id);
  }
  return out;
}

export function formatAgreement(a: Agreement): string {
  if (a.labeled === 0) return "no labels found: fill in `verdict: pass` or `verdict: fail` in the sheet";
  const pct = Math.round((100 * a.agreed) / a.labeled);
  const lines = [`judge agreed with you on ${a.agreed} of ${a.labeled} (${pct}%)`];
  if (a.tooLenient.length) lines.push(`passed what you failed (too lenient):`, ...a.tooLenient.map((id) => `  ${id}`));
  if (a.tooStrict.length) lines.push(`failed what you passed (too strict):`, ...a.tooStrict.map((id) => `  ${id}`));
  if (a.unknown.length) lines.push(`not in this result:`, ...a.unknown.map((id) => `  ${id}`));
  lines.push(
    a.labeled < 20
      ? "fewer than 20 labels: read this as a hint, not a number"
      : pct >= 90
        ? "good enough to trust the judged scores on cases like these"
        : "below 9 in 10: sharpen the criteria where it disagreed, then label again",
  );
  return lines.join("\n");
}
