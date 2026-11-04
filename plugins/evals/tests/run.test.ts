// The runner: case loading, mocks, graders, the Claude stream parser, and whole suites run against
// a stand-in `claude` (tests/fake-claude.mjs) so no model is called.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CaseError, loadCase, pathGlob } from "../src/run/case.ts";
import { gradeRun, scoreOf } from "../src/run/graders.ts";
import { placeFor, prepareHistory, stripThinking } from "../src/run/history.ts";
import { claudeHarness, parseStream } from "../src/run/harness/claude.ts";
import type { Harness, RunOutput } from "../src/run/harness/types.ts";
import { readVote, renderTrace } from "../src/run/judge.ts";
import { checkCall, fillTemplate, loadMocks, planServers } from "../src/run/mocks.ts";
import { codexConfig, parseCodex } from "../src/run/harness/codex.ts";
import { type RunOptions, grantTools, runSuite } from "../src/run/runner.ts";

let root: string;
const FAKE = join(dirname(import.meta.path), "fake-claude.mjs");

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "evals-run-test-"));
  chmodSync(FAKE, 0o755);
  process.env.EVALS_CLAUDE_BIN = FAKE;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.EVALS_CLAUDE_BIN;
});

function output(over: Partial<RunOutput> = {}): RunOutput {
  return {
    messages: [{ type: "assistant", message: { content: [{ type: "text", text: "Hello there" }] } }],
    toolCalls: [{ id: "1", name: "Skill", input: { skill: "hello" }, inputText: '{"skill":"hello"}' }],
    lastAssistantText: "Hello there",
    numTurns: 1,
    costUsd: 0,
    error: null,
    timedOut: false,
    endedOnApiError: false,
    authRejected: null,
    tracePath: "",
    ...over,
  };
}

const fakeJudge = (answer: string): Harness => ({
  ...claudeHarness,
  ask: async () => ({ text: answer, costUsd: 0.01 }),
});

describe("cases", () => {
  test("prompt.md and graders/*.md merge over case.yaml", () => {
    const dir = join(root, "cases", "evals", "merge");
    write(
      join(dir, "case.yaml"),
      'schema_version: "1.1"\nname: merged\nexecution:\n  prompt: from yaml\n  max_turns: 4\n',
    );
    write(join(dir, "prompt.md"), "---\ntags: [a]\nmax_turns: 6\nenv:\n  EVAL_X: y\n---\nfrom prose\n");
    write(join(dir, "graders", "says.md"), "---\ntype: regex\nflags: i\n---\nhello\n");
    write(join(dir, "graders", "notes.md"), "no frontmatter, so not a grader\n");
    const c = loadCase(dir, join(root, "cases", "evals"))!;
    expect(c.name).toBe("merged");
    expect(c.execution.prompt).toBe("from prose");
    expect(c.execution.max_turns).toBe(6);
    expect(c.execution.env).toEqual({ EVAL_X: "y" });
    expect(c.tags).toEqual(["a"]);
    expect(c.source).toBe("mixed");
    expect(c.graders).toEqual([
      {
        name: "says",
        weight: 1,
        type: "regex",
        pattern: "hello",
        flags: "i",
        target: "last_message",
        match: "contains",
      },
    ]);
  });

  test("unknown keys, bad env names and a history without a prompt are refused", () => {
    const dir = join(root, "cases", "evals", "bad");
    write(join(dir, "prompt.md"), "---\nmodle: opus\n---\nhi\n");
    write(join(dir, "graders", "g.md"), "---\ntype: regex\n---\nx\n");
    expect(() => loadCase(dir, root)).toThrow(/unknown frontmatter key "modle"/);
    write(join(dir, "prompt.md"), "---\nenv:\n  HOME: /x\n---\nhi\n");
    expect(() => loadCase(dir, root)).toThrow(/EVAL_/);
    rmSync(join(dir, "prompt.md"));
    write(join(dir, "case.yaml"), 'schema_version: "1.1"\nname: h\ncontext:\n  history_file: h.jsonl\nexecution: {}\n');
    write(join(dir, "h.jsonl"), "");
    expect(() => loadCase(dir, root)).toThrow(CaseError);
    expect(() => loadCase(dir, root)).toThrow(/history_file requires execution.prompt/);
  });

  test("file_exists globs", () => {
    expect(pathGlob("**/*.md").test("a/b/c.md")).toBe(true);
    expect(pathGlob("**/*.md").test("c.md")).toBe(true);
    expect(pathGlob("*.md").test("a/c.md")).toBe(false);
  });
});

describe("mocks", () => {
  test("expect guards and templates", () => {
    expect(checkCall({ project: "ABC", n: 3 }, { project: ["ABC"], n: "number" })).toBeNull();
    expect(checkCall({ project: "XYZ" }, { project: ["ABC"] })).toContain("is not one of");
    expect(checkCall({ title: "Fix it" }, { title: "/^fix/i" })).toBeNull();
    expect(checkCall({ a: { b: 1 } }, { a: { b: "2" } })).toContain('a.b = 1 is not "2"');
    const dir = join(root, "tpl");
    write(join(dir, "fixtures", "x.json"), '{"ok":1}');
    expect(fillTemplate("id {{input.id}} {{file:fixtures/{input.name}.json}}", { id: 7, name: "x" }, dir)).toEqual({
      ok: true,
      text: 'id 7 {"ok":1}',
    });
    expect(fillTemplate("{{file:../secret}}", {}, dir).ok).toBe(false);
  });

  test("layers merge nearest last, and an unmocked plugin server is withheld", () => {
    const evals = join(root, "layers", "evals");
    write(join(evals, "mocks", "tracker", "list.md"), "suite answer");
    write(join(evals, "mocks", "tracker", "get.md"), "suite get");
    write(join(evals, "c1", "mocks", "tracker", "list.md"), "case answer");
    const { servers } = loadMocks(join(evals, "c1"), evals);
    const tracker = servers.get("tracker")!;
    expect((tracker.tools.get("list") as { body: string }).body).toBe("case answer");
    expect((tracker.tools.get("get") as { body: string }).body).toBe("suite get");
    const plugin = join(root, "layers", "plugin");
    write(join(plugin, ".mcp.json"), '{"mcpServers":{"tracker":{"command":"x"},"mail":{"command":"y"}}}');
    const plan = planServers(servers, [plugin], false);
    expect(plan.servers.map((s) => [s.dirName, s.kind, s.withheld ?? false])).toEqual([
      ["tracker", "shadow", false],
      ["mail", "shadow", true],
    ]);
  });
});

describe("graders", () => {
  test("free graders, with-only under ablation, and the judge", async () => {
    const dir = join(root, "grading", "evals", "g");
    write(join(dir, "prompt.md"), "hi\n");
    write(join(dir, "graders", "says.md"), "---\ntype: regex\nflags: i\n---\nhello\n");
    write(join(dir, "graders", "fired.md"), "---\ntype: tool_used\ntool: Skill\n---\n");
    write(join(dir, "graders", "made.md"), "---\ntype: file_exists\npath: out/*.txt\n---\n");
    write(join(dir, "graders", "warm.md"), "---\ntype: llm\n---\nIt greets warmly.\n");
    const c = loadCase(dir, join(root, "grading", "evals"))!;
    const ctx = {
      case_: c,
      run: output(),
      cwdDiff: "out/a.txt",
      sandboxCwd: root,
      harness: fakeJudge("PASS"),
      skipPaidGraders: false,
      mockCallsWithOnly: false,
      mocksActive: false,
    };
    const single = await gradeRun(ctx);
    expect(single.results.map((r) => [r.name, r.passed, r.scored])).toEqual([
      ["fired", true, true],
      ["made", true, true],
      ["says", true, true],
      ["warm", true, true],
    ]);
    expect(single.results.find((r) => r.name === "warm")!.judge_votes).toEqual([true, true, true]);
    expect(single.judgeCostUsd).toBeCloseTo(0.03);
    const without = await gradeRun({ ...ctx, arm: "without", harness: fakeJudge("FAIL") });
    expect(without.results.map((r) => r.name)).toEqual(["made", "says", "warm"]);
    const withArm = await gradeRun({ ...ctx, arm: "with", run: output({ toolCalls: [] }) });
    const fired = withArm.results.find((r) => r.name === "fired")!;
    expect([fired.passed, fired.with_only, fired.scored]).toEqual([false, true, false]);
    expect(scoreOf(withArm.results)).toBe(1);
    const capped = await gradeRun({ ...ctx, skipPaidGraders: true });
    expect(capped.results.find((r) => r.name === "warm")!.explanation).toBe("skipped: cost ceiling");
  });

  test("judge votes and trace rendering", () => {
    expect(readVote("PASS")).toBe(true);
    expect(readVote("PASS or FAIL")).toBe(false);
    const rendered = renderTrace(Array.from({ length: 30 }, (_, i) => i));
    expect(rendered).toContain("[…6 messages elided…]");
    expect(rendered.split("\n")).toHaveLength(25);
  });

  test("operator grants gate the case's tools", () => {
    expect(grantTools(["Read", "Bash(npm test:*)", "Write"], ["Bash"])).toEqual({
      allowed: ["Read", "Bash(npm test:*)"],
      denied: ["Write"],
    });
  });
});

describe("claude stream", () => {
  test("tool calls, last text, turns and cost", () => {
    const run = parseStream(
      [
        {
          type: "assistant",
          message: {
            id: "a",
            content: [
              { type: "text", text: "first" },
              { type: "tool_use", id: "t", name: "Read", input: { file_path: "x" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "body" }] }] },
        },
        { type: "assistant", message: { id: "b", content: [{ type: "text", text: "done" }] } },
        { type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0.5, is_error: false },
      ],
      { kind: "ok" },
      "/t",
      false,
    );
    expect(run.lastAssistantText).toBe("done");
    expect(run.toolCalls[0]).toMatchObject({
      name: "Read",
      inputText: '{"file_path":"x"}',
      output: "body",
      isError: false,
    });
    expect([run.numTurns, run.costUsd, run.error]).toEqual([2, 0.5, null]);
  });
});

describe("suites", () => {
  test("a suite runs both arms against the stand-in claude, with mocks relayed and expect enforced", async () => {
    const plugin = join(root, "suite", "plug");
    write(join(plugin, "plugin.json"), '{"name":"plug","description":"x"}');
    write(join(plugin, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: d\n---\nbody\n");
    write(join(plugin, ".mcp.json"), '{"mcpServers":{"tracker":{"command":"false"}}}');
    const evals = join(plugin, "evals");
    write(
      join(evals, "mocks", "tracker", "create.md"),
      '---\nexpect:\n  project: [ABC]\n---\n{"id":"{{input.project}}-1"}\n',
    );
    write(
      join(evals, "good", "prompt.md"),
      '---\nruns: 1\n---\ncall tracker create {"project":"ABC"} and write out.txt\n',
    );
    write(join(evals, "good", "graders", "answered.md"), "---\ntype: regex\ntarget: mock_calls\n---\nABC-1\n");
    write(join(evals, "good", "graders", "file.md"), "---\ntype: file_exists\npath: out.txt\n---\n");
    write(join(evals, "good", "graders", "said.md"), "---\ntype: regex\n---\nhello from fake\n");
    write(join(evals, "wrong", "prompt.md"), '---\nruns: 1\n---\ncall tracker create {"project":"XYZ"}\n');
    write(join(evals, "wrong", "graders", "said.md"), "---\ntype: regex\n---\nhello\n");
    const lines: string[] = [];
    const out = join(root, "suite", "out");
    const { result, exitCode } = await runSuite({
      target: plugin,
      ablation: "auto",
      threshold: 1,
      allowTools: [],
      disallowTools: [],
      caseGlobs: [],
      tags: [],
      scaffold: false,
      outputDir: out,
      concurrency: 2,
      keepTemp: false,
      mocks: true,
      allowRealServers: false,
      instructionsScope: "project",
      harness: claudeHarness,
      judgeHarness: claudeHarness,
      onLine: (l) => lines.push(l),
    });
    const good = result.cases.find((c) => c.name === "good")!;
    expect(result.suite.ablation).toBe("with-without");
    expect(good.arms.with[0]!.graders.map((g) => [g.name, g.passed, g.scored])).toEqual([
      ["answered", true, false],
      ["file", true, true],
      ["said", true, true],
    ]);
    expect(good.arms.with[0]!.mocks!.calls.total).toBe(1);
    // Without the plugin its server isn't there, so the call fails, but the file and reply still score.
    expect(good.arms.without![0]!.graders.map((g) => g.name)).toEqual(["file", "said"]);
    expect(good.aggregates).toMatchObject({ score: 1, scoreWithout: 1, delta: 0, allRunsPassed: true });
    const wrong = result.cases.find((c) => c.name === "wrong")!;
    expect(wrong.arms.with[0]!.aborted).toMatchObject({ server: "tracker", tool: "create" });
    expect(wrong.arms.with[0]!.score).toBe(0);
    expect(wrong.aggregates.allRunsPassed).toBe(false);
    expect(result.aggregates.allRunsPassRate).toBe(0.5);
    expect(exitCode).toBe(1);
    const saved = JSON.parse(readFileSync(join(out, "aggregate-result.json"), "utf8"));
    expect(saved.cases).toHaveLength(2);
    expect(readFileSync(good.arms.with[0]!.tracePath, "utf8")).toContain("hello from fake");
  }, 30_000);

  test("--max-cost-usd 0 loads every case and runs nothing", async () => {
    const plugin = join(root, "suite", "plug");
    const { result, exitCode } = await runSuite({
      target: plugin,
      ablation: "none",
      threshold: 1,
      maxCostUsd: 0,
      allowTools: [],
      disallowTools: [],
      caseGlobs: ["go*"],
      tags: [],
      scaffold: false,
      outputDir: join(root, "suite", "out0"),
      concurrency: 1,
      keepTemp: false,
      mocks: true,
      allowRealServers: false,
      instructionsScope: "project",
      harness: claudeHarness,
      judgeHarness: claudeHarness,
      onLine: () => {},
    });
    expect(result.cases.map((c) => c.name)).toEqual(["good"]);
    expect(result.partialReason).toBe("cost_ceiling");
    expect(result.costUsd).toBe(0);
    expect(exitCode).toBe(2);
  });

  test("instruction files load for real, and replace the recorded ones in a history", async () => {
    const suite = join(root, "instr");
    write(join(suite, "NEW.md"), "NEW RULES\nAsk first.\n");
    write(join(suite, "evals", "fresh", "prompt.md"), "---\nruns: 1\n---\nhi\n");
    write(
      join(suite, "evals", "fresh", "graders", "loaded.md"),
      "---\ntype: regex\n---\nclaude-md:NEW RULES mds-off:false history:none\n",
    );
    write(join(suite, "evals", "plain", "prompt.md"), "---\nruns: 1\n---\nhi\n");
    write(join(suite, "evals", "plain", "graders", "none.md"), "---\ntype: regex\n---\nclaude-md:none mds-off:true\n");
    const attachment = {
      type: "attachment",
      uuid: "a1",
      parentUuid: null,
      cwd: "/p",
      attachment: { type: "instructions", files: [{ path: "/p/CLAUDE.md", type: "Project", content: "OLD RULES" }] },
      rendered: [
        {
          content:
            "<system-reminder>\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\n\nOLD RULES\n</system-reminder>",
        },
      ],
    };
    const thought = {
      type: "assistant",
      uuid: "t1",
      parentUuid: "a1",
      message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
    };
    const said = {
      type: "assistant",
      uuid: "t2",
      parentUuid: "t1",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "done" }] },
    };
    write(
      join(suite, "evals", "recorded", "history.jsonl"),
      `${[attachment, thought, said].map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    write(
      join(suite, "evals", "recorded", "case.yaml"),
      'schema_version: "1.1"\nname: recorded\nruns: 1\ncontext:\n  history_file: history.jsonl\nexecution:\n  prompt: next\n',
    );
    write(
      join(suite, "evals", "recorded", "graders", "rewritten.md"),
      "---\ntype: regex\n---\nclaude-md:NEW RULES mds-off:false history:new thinking:false\n",
    );
    const base: RunOptions = {
      target: suite,
      ablation: "none",
      threshold: 1,
      allowTools: [],
      disallowTools: [],
      caseGlobs: ["fresh", "recorded"],
      tags: [],
      scaffold: false,
      outputDir: join(suite, "out"),
      concurrency: 1,
      keepTemp: false,
      mocks: true,
      allowRealServers: false,
      instructions: join(suite, "NEW.md"),
      instructionsScope: "project",
      harness: claudeHarness,
      judgeHarness: claudeHarness,
      onLine: () => {},
    };
    const { result } = await runSuite(base);
    expect(result.cases.map((c) => [c.name, c.aggregates.score])).toEqual([
      ["fresh", 1],
      ["recorded", 1],
    ]);
    expect(result.suite.instructions?.scope).toBe("project");
    const plain = await runSuite({
      ...base,
      caseGlobs: ["plain"],
      instructions: undefined,
      outputDir: join(suite, "out2"),
    });
    expect(plain.result.cases[0]!.aggregates.score).toBe(1);
  }, 30_000);

  test("a mocked tool answers to its plain mcp__server__tool name too", async () => {
    const plugin = join(root, "suite", "plug");
    write(join(plugin, "evals", "alias", "prompt.md"), '---\nruns: 1\n---\ncall tracker create {"project":"ABC"}\n');
    write(
      join(plugin, "evals", "alias", "graders", "plain.md"),
      "---\ntype: tool_used\ntool: mcp__tracker__create\n---\n",
    );
    const { result } = await runSuite({
      target: plugin,
      ablation: "none",
      threshold: 1,
      allowTools: [],
      disallowTools: [],
      caseGlobs: ["alias"],
      tags: [],
      scaffold: false,
      outputDir: join(root, "suite", "out-alias"),
      concurrency: 1,
      keepTemp: false,
      mocks: true,
      allowRealServers: false,
      instructionsScope: "project",
      harness: claudeHarness,
      judgeHarness: claudeHarness,
      onLine: () => {},
    });
    expect(result.cases[0]!.arms.with[0]!.graders[0]).toMatchObject({
      passed: true,
      explanation: "mcp__tracker__create called 1x (expected 1..∞)",
    });
  }, 30_000);
});

describe("recorded histories", () => {
  const to = { cwd: "/box/home/work", parents: ["/box/home", "/box"], configDir: "/box/config" };

  test("each recorded instruction file gets a place in the sandbox, or none", () => {
    expect(placeFor("/r/proj/CLAUDE.md", "Project", "/r/proj", to)).toBe("/box/home/work/CLAUDE.md");
    expect(placeFor("/r/proj/.claude/rules/a.md", "Project", "/r/proj", to)).toBe("/box/home/work/.claude/rules/a.md");
    expect(placeFor("/r/CLAUDE.md", "Project", "/r/proj", to)).toBe("/box/home/CLAUDE.md");
    expect(placeFor("/CLAUDE.md", "Project", "/r/proj", to)).toBe("/box/CLAUDE.md");
    expect(placeFor("/a/b/c/CLAUDE.md", "Project", "/a/b/c/d/e/f", to)).toBeNull();
    expect(placeFor("/Users/me/.claude/CLAUDE.md", "User", "/r/proj", to)).toBe("/box/config/CLAUDE.md");
    expect(placeFor("/Library/CLAUDE.md", "Managed", "/r/proj", to)).toBeNull();
  });

  test("thinking is stripped and an emptied record's children relinked to its parent", () => {
    const { records, removed } = stripThinking([
      { type: "user", uuid: "u", parentUuid: null },
      { type: "assistant", uuid: "t", parentUuid: "u", message: { content: [{ type: "thinking" }] } },
      {
        type: "assistant",
        uuid: "x",
        parentUuid: "t",
        message: { content: [{ type: "redacted_thinking" }, { type: "text", text: "hi" }] },
      },
    ]);
    expect(removed).toBe(2);
    expect(records.map((r) => [r.uuid, r.parentUuid])).toEqual([
      ["u", null],
      ["x", "u"],
    ]);
    expect(records[1]!.message!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("files are written where the history now says they are", () => {
    const box = mkdtempSync(join(tmpdir(), "evals-history-"));
    const placement = { cwd: join(box, "home", "work"), parents: [join(box, "home"), box], configDir: join(box, "c") };
    const out = prepareHistory(
      [
        {
          type: "attachment",
          cwd: "/r/p",
          attachment: { type: "instructions", files: [{ path: "/r/p/CLAUDE.md", type: "Project", content: "RULES" }] },
          rendered: [
            { content: "Contents of /r/p/CLAUDE.md (project instructions, checked into the codebase):\n\nRULES" },
          ],
        },
      ],
      placement,
    );
    const moved = join(placement.cwd, "CLAUDE.md");
    expect(out.placed).toBe(1);
    expect(readFileSync(moved, "utf8")).toBe("RULES");
    expect(out.records[0]!.attachment!.files![0]!.path).toBe(moved);
    expect(out.records[0]!.rendered![0]!.content).toContain(`Contents of ${moved} (`);
    rmSync(box, { recursive: true, force: true });
  });
});

describe("codex", () => {
  test("exec --json events become tool calls, with a skill read standing for the Skill tool", () => {
    const run = parseCodex(
      [
        { type: "thread.started" },
        {
          type: "item.completed",
          item: {
            id: "1",
            type: "command_execution",
            command: "cat ~/.codex/skills/hello/SKILL.md",
            aggregated_output: "body",
            exit_code: 0,
          },
        },
        {
          type: "item.completed",
          item: {
            id: "2",
            type: "mcp_tool_call",
            server: "tracker",
            tool: "create",
            arguments: { project: "ABC" },
            result: { content: [{ text: "ABC-1" }] },
            status: "completed",
          },
        },
        { type: "item.completed", item: { id: "3", type: "agent_message", text: "Done." } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ],
      { code: 0, timedOut: false, stderrTail: "", timeoutMs: 1000 },
      "/t",
    );
    expect(run.toolCalls.map((c) => c.name)).toEqual(["Bash", "Skill", "mcp__tracker__create"]);
    expect(run.toolCalls[2]!.output).toBe("ABC-1");
    expect([run.lastAssistantText, run.error, run.numTurns]).toEqual(["Done.", null, 3]);
  });

  test("config.toml carries no approvals and the run's MCP servers", () => {
    const text = codexConfig([{ name: "tracker", command: "node", args: ["/m.mjs", "/s.json"] }], "gpt-6.1");
    expect(text).toContain('approval_policy = "never"');
    expect(text).toContain('[mcp_servers."tracker"]');
    expect(text).toContain('args = ["/m.mjs", "/s.json"]');
    expect(text.startsWith('model = "gpt-6.1"')).toBe(true);
  });
});
