// Paired comparison of two `claude plugin eval` results (aggregate-result.json): the per-case score
// difference with its interval and a sign test, the guardrails (turns, cost, time), and errored runs.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type RunResult = {
  score: number;
  turns: number;
  costUsd: number;
  judgeCostUsd?: number;
  durationSeconds?: number;
  error: string | null;
  skippedPaidGraders?: boolean;
  aborted?: unknown;
  tracePath?: string;
};

export type CaseResult = {
  name: string;
  arms: { with: RunResult[]; without?: RunResult[] };
  aggregates: { score: number; scoreWithout?: number; delta?: number };
};

export type Result = {
  claudeVersion?: string;
  costUsd?: number;
  partial?: boolean;
  partialReason?: string;
  suite?: { ablation?: string; modelOverride?: string; judgeModel?: string };
  cases: CaseResult[];
};

export function loadResult(path: string): Result {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "aggregate-result.json") : path;
  return JSON.parse(readFileSync(file, "utf8")) as Result;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Two-sided 95% critical values of Student's t, by degrees of freedom.
const T95 = [
  NaN,
  12.71,
  4.303,
  3.182,
  2.776,
  2.571,
  2.447,
  2.365,
  2.306,
  2.262,
  2.228,
  2.201,
  2.179,
  2.16,
  2.145,
  2.131,
  2.12,
  2.11,
  2.101,
  2.093,
  2.086,
  2.08,
  2.074,
  2.069,
  2.064,
  2.06,
  2.056,
  2.052,
  2.048,
  2.045,
  2.042,
];

export function t95(df: number): number {
  return df < T95.length ? T95[df]! : df < 60 ? 2.0 : 1.96;
}

/** Two-sided exact sign test: the chance of a split at least this lopsided if neither side is better. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export type Paired = {
  n: number;
  meanA: number;
  meanB: number;
  delta: number;
  halfWidth: number;
  wins: number;
  losses: number;
  ties: number;
  pSign: number;
};

export function paired(a: number[], b: number[]): Paired {
  const d = a.map((x, i) => b[i]! - x);
  const n = d.length;
  const wins = d.filter((x) => x > 1e-9).length;
  const losses = d.filter((x) => x < -1e-9).length;
  return {
    n,
    meanA: mean(a),
    meanB: mean(b),
    delta: mean(d),
    halfWidth: n > 1 ? (t95(n - 1) * sd(d)) / Math.sqrt(n) : NaN,
    wins,
    losses,
    ties: n - wins - losses,
    pSign: signTest(wins, losses),
  };
}

export type Comparison = {
  cases: string[];
  missing: { onlyA: string[]; onlyB: string[] };
  score: Paired;
  turns: Paired;
  costUsd: Paired;
  durationSeconds?: Paired;
  /** The expected 95% half-width of a paired difference from run-to-run noise alone. */
  noiseHalfWidth: number;
  runsPerCase: { a: number; b: number };
  errored: { a: number; b: number };
  unjudged: { a: number; b: number };
  partial: { a: boolean; b: boolean };
  environment: { a: string; b: string };
  perCase: { name: string; a: number; b: number; delta: number }[];
  warnings: string[];
};

function runsOf(c: CaseResult, dropErrors: boolean): RunResult[] {
  return dropErrors ? c.arms.with.filter((r) => r.error === null && !r.aborted) : c.arms.with;
}

function env(r: Result): string {
  return [
    r.claudeVersion && `Claude Code ${r.claudeVersion}`,
    r.suite?.modelOverride && `model ${r.suite.modelOverride}`,
    r.suite?.judgeModel && `judge ${r.suite.judgeModel}`,
    r.suite?.ablation && `ablation ${r.suite.ablation}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Glob with * and ?, matched against case names. */
function globber(patterns: string[] | undefined): (name: string) => boolean {
  if (!patterns?.length) return () => true;
  const res = patterns.map(
    (p) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      ),
  );
  return (name) => res.some((re) => re.test(name));
}

export function compare(a: Result, b: Result, options: { cases?: string[]; dropErrors?: boolean } = {}): Comparison {
  const keep = globber(options.cases);
  const dropErrors = options.dropErrors ?? false;
  const mapA = new Map(a.cases.filter((c) => keep(c.name)).map((c) => [c.name, c]));
  const mapB = new Map(b.cases.filter((c) => keep(c.name)).map((c) => [c.name, c]));
  const names = [...mapA.keys()].filter((n) => mapB.has(n));
  const warnings: string[] = [];
  const pairs: { name: string; ra: RunResult[]; rb: RunResult[] }[] = [];
  for (const name of names) {
    const ra = runsOf(mapA.get(name)!, dropErrors);
    const rb = runsOf(mapB.get(name)!, dropErrors);
    if (!ra.length || !rb.length) {
      warnings.push(`${name}: no usable runs on one side; left out`);
      continue;
    }
    pairs.push({ name, ra, rb });
  }
  const m = (runs: RunResult[], f: (r: RunResult) => number | undefined) =>
    mean(runs.map(f).filter((x): x is number => typeof x === "number"));
  const side = (f: (r: RunResult) => number | undefined) =>
    [pairs.map((p) => m(p.ra, f)), pairs.map((p) => m(p.rb, f))] as const;
  const [sa, sb] = side((r) => r.score);
  const [ta, tb] = side((r) => r.turns);
  const [ca, cb] = side((r) => r.costUsd + (r.judgeCostUsd ?? 0));
  const [da, db] = side((r) => r.durationSeconds);

  // Noise: the within-case variance of single runs, pooled, carried to a paired mean of case means.
  const withinVar = (runs: RunResult[]) => (runs.length > 1 ? sd(runs.map((r) => r.score)) ** 2 : NaN);
  const pooled = (key: "ra" | "rb") => mean(pairs.map((p) => withinVar(p[key])).filter((v) => !Number.isNaN(v)));
  const ka = mean(pairs.map((p) => p.ra.length));
  const kb = mean(pairs.map((p) => p.rb.length));
  const n = pairs.length;
  const noiseVar = pooled("ra") / ka + pooled("rb") / kb;
  const noiseHalfWidth = n > 1 ? (t95(n - 1) * Math.sqrt(noiseVar)) / Math.sqrt(n) : NaN;

  const count = (r: Result, f: (x: RunResult) => boolean) =>
    r.cases.filter((c) => names.includes(c.name)).reduce((acc, c) => acc + c.arms.with.filter(f).length, 0);
  if (n < 20) warnings.push(`${n} paired cases: treat the result as directional`);
  if (a.partial || b.partial)
    warnings.push("a result is partial (cost ceiling or interruption); its missing runs make the comparison uneven");
  if (env(a) !== env(b)) warnings.push(`the two runs differ in setup: ${env(a) || "?"} vs ${env(b) || "?"}`);
  const onlyA = [...mapA.keys()].filter((x) => !mapB.has(x));
  const onlyB = [...mapB.keys()].filter((x) => !mapA.has(x));
  if (onlyA.length || onlyB.length)
    warnings.push("the runs don't hold the same cases; only cases in both are compared");

  return {
    cases: pairs.map((p) => p.name),
    missing: { onlyA, onlyB },
    score: paired(sa, sb),
    turns: paired(ta, tb),
    costUsd: paired(ca, cb),
    durationSeconds:
      da.every((x) => !Number.isNaN(x)) && db.every((x) => !Number.isNaN(x)) ? paired(da, db) : undefined,
    noiseHalfWidth,
    runsPerCase: { a: ka, b: kb },
    errored: {
      a: count(a, (r) => r.error !== null || Boolean(r.aborted)),
      b: count(b, (r) => r.error !== null || Boolean(r.aborted)),
    },
    unjudged: { a: count(a, (r) => Boolean(r.skippedPaidGraders)), b: count(b, (r) => Boolean(r.skippedPaidGraders)) },
    partial: { a: Boolean(a.partial), b: Boolean(b.partial) },
    environment: { a: env(a), b: env(b) },
    perCase: pairs.map((p, i) => ({ name: p.name, a: sa[i]!, b: sb[i]!, delta: sb[i]! - sa[i]! })),
    warnings,
  };
}

const f2 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(2));
const signed = (x: number, digits = 2) => (Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`);

function line(label: string, p: Paired, digits = 2): string {
  const ci = Number.isNaN(p.halfWidth) ? "" : ` ±${p.halfWidth.toFixed(digits)}`;
  return `${label.padEnd(10)} ${p.meanA.toFixed(digits).padStart(8)} → ${p.meanB.toFixed(digits).padEnd(8)} Δ ${signed(p.delta, digits)}${ci}`;
}

export function formatComparison(c: Comparison, minEffect?: number): string {
  const s = c.score;
  const out = [
    `${c.cases.length} paired cases, ${f2(c.runsPerCase.a)} vs ${f2(c.runsPerCase.b)} runs per case`,
    "",
    line("score", s),
    `           better ${s.wins} · same ${s.ties} · worse ${s.losses} (sign test p=${s.pSign.toFixed(3)})`,
    `           noise alone would give about ±${Number.isNaN(c.noiseHalfWidth) ? "?" : c.noiseHalfWidth.toFixed(2)}`,
    line("turns", c.turns, 1),
    line("cost $", c.costUsd, 3),
  ];
  if (c.durationSeconds) out.push(line("seconds", c.durationSeconds, 0));
  out.push(
    `errored or aborted runs: ${c.errored.a} vs ${c.errored.b}; unjudged (cost ceiling): ${c.unjudged.a} vs ${c.unjudged.b}`,
  );

  const excludesZero = !Number.isNaN(s.halfWidth) && Math.abs(s.delta) > s.halfWidth;
  const bigEnough = minEffect === undefined || Math.abs(s.delta) >= minEffect;
  let verdict: string;
  if (Number.isNaN(s.halfWidth)) verdict = "too few cases for an interval";
  else if (excludesZero && bigEnough && c.cases.length >= 20)
    verdict = `real: the interval excludes 0${minEffect !== undefined ? ` and |Δ| ≥ ${minEffect}` : ""}`;
  else if (excludesZero && bigEnough) verdict = "the interval excludes 0, but with under 20 cases call it directional";
  else if (excludesZero) verdict = `the interval excludes 0, but |Δ| is under the ${minEffect} worth acting on`;
  else verdict = "within noise: the interval includes 0";
  out.push("", `verdict: ${verdict}`);

  const moved = c.perCase.filter((x) => Math.abs(x.delta) > 1e-9).sort((x, y) => x.delta - y.delta);
  if (moved.length) {
    out.push("", "cases that moved:");
    for (const x of moved) out.push(`  ${signed(x.delta)}  ${x.name}  (${f2(x.a)} → ${f2(x.b)})`);
  }
  if (c.warnings.length) out.push("", ...c.warnings.map((w) => `warning: ${w}`));
  return out.join("\n");
}
