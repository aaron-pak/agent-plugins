// A self-contained HTML report of a result: per case, the scores by arm, and per run, each grader's
// verdict with the judge's votes and the evidence it saw.

import type { CaseRecord, Result, RunRecord } from "./runner.ts";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const pct = (x: number | undefined) => (x === undefined ? "—" : x.toFixed(2));

function run(r: RunRecord, i: number, arm: string): string {
  const status = r.aborted
    ? `aborted by mock ${esc(r.aborted.server)}/${esc(r.aborted.tool)}: ${esc(r.aborted.reason)}`
    : r.error
      ? `error: ${esc(r.error)}`
      : `score ${pct(r.score)}`;
  const graders = r.graders
    .map(
      (g) =>
        `<li class="${g.passed ? "pass" : "fail"}"><b>${g.passed ? "✓" : "✗"} ${esc(g.name)}</b>${g.withOnly ? " <i>with-only, not scored</i>" : ""}: ${esc(g.explanation)}${
          g.evidence ? `<details><summary>what the judge saw</summary><pre>${esc(g.evidence)}</pre></details>` : ""
        }</li>`,
    )
    .join("");
  return `<div class="run"><div class="meta">${esc(arm)} run ${i + 1} · ${status} · ${r.turns} turns · $${r.costUsd.toFixed(3)} · ${r.durationSeconds}s · <code>${esc(r.tracePath)}</code></div><ul>${graders}</ul></div>`;
}

function caseBlock(c: CaseRecord, threshold: number): string {
  const a = c.aggregates;
  const head =
    a.scoreWithout !== undefined
      ? `with ${pct(a.score)} · without ${pct(a.scoreWithout)} · Δ ${a.delta === undefined ? "—" : (a.delta >= 0 ? "+" : "") + a.delta.toFixed(2)}`
      : `score ${pct(a.score)}`;
  const runs = [
    ...c.arms.with.map((r, i) => run(r, i, "with")),
    ...(c.arms.without ?? []).map((r, i) => run(r, i, "without")),
  ].join("");
  const advisories = c.advisories.length
    ? `<ul class="adv">${c.advisories.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "";
  return `<section><h2 class="${a.score >= threshold ? "pass" : "fail"}">${esc(c.name)} <small>${head}</small></h2><details><summary>prompt</summary><pre>${esc(c.promptMarkdown)}</pre></details>${advisories}${runs}</section>`;
}

export function renderReport(result: Result): string {
  const ag = result.aggregates;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eval report</title><style>
:root{--bg:#fbfaf7;--fg:#1d1b18;--muted:#6b665e;--line:#e4e0d8;--pass:#2f7d4f;--fail:#b2402f;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#ece8e1;--muted:#a19b91;--line:#34312c;--pass:#6cc58d;--fail:#ee8a78;--card:#1f1e1b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 8px}h2 small{color:var(--muted);font-weight:400}.pass{color:var(--pass)}.fail{color:var(--fail)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}.run{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}
.meta,.sub{color:var(--muted);font-size:13px}pre{white-space:pre-wrap;word-break:break-word;font-size:12.5px;background:var(--bg);padding:8px;border-radius:6px;max-height:320px;overflow:auto}
ul{padding-left:18px;margin:6px 0}li{margin:2px 0}code{font-size:12px;word-break:break-all}.adv{color:var(--muted);font-size:13px}
</style></head><body><main><h1>Eval report</h1><div class="sub">${esc(result.harness)} ${esc(result.harnessVersion)} · ${esc(result.suite.root)} · ablation ${esc(result.suite.ablation)} · model ${esc(result.suite.modelOverride ?? "case default")} · judge ${esc(result.suite.judgeModel ?? "default")} · $${result.costUsd.toFixed(2)} · ${result.durationSeconds}s${result.partial ? ` · <b class="fail">partial (${esc(result.partialReason)})</b>` : ""}</div>
<p>${ag.casesPassed} of ${ag.casesTotal} cases at or above ${result.suite.threshold} · overall score ${pct(ag.overallScore)} · every run passed in ${pct(ag.allRunsPassRate ?? 0)} of cases · mean Δ ${ag.meanDelta === null ? "—" : ag.meanDelta.toFixed(2)}</p>
${result.errors.map((e) => `<section><h2 class="fail">${esc(e.case)} <small>did not load</small></h2><pre>${esc(e.error)}</pre></section>`).join("")}
${result.cases.map((c) => caseBlock(c, result.suite.threshold)).join("")}
</main></body></html>`;
}
