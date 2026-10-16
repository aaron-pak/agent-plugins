---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes ~/.config/pstack/models, which every pstack skill reads when it spawns a subagent. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the pstack model config, a plain text file that sets pstack's model per role. `pstack models path` prints its location, `~/.config/pstack/models` unless the `PSTACK_MODELS` environment variable points elsewhere. Every harness on this machine reads the same file.

`pstack` below means `<pstack>/scripts/pstack`. The [harness reference](../../references/harness.md) maps each neutral term here (structured question, spawn, seat) to the harness you are in.

## Steps

### 1. Detect available models

Build the detected set from two sources:

- The harness's own list. In Cursor, the model slugs you can pass to a `Task` subagent. In Claude Code, the Agent tool's model aliases, which the harness reference maps to `claude-*` slugs. In T3 Code, the models `orchestrator_capabilities` reports for each provider.
- `pstack models detect`, which lists the GPT models the local `codex` CLI can reach and the efforts each supports, from `codex debug models`. Add `--json` for a parseable copy. It lists no Claude models, because the `claude` CLI has no model list.

A slug neither source lists has to pass `pstack models probe <slug>...` before it counts. Outside Cursor that includes every `claude-*` id. Probe several slugs in one call. Each probe sends one short prompt through the slug's CLI, so it takes a few seconds per slug. If you still cannot detect any models, ask the user to paste the slugs they have access to, and probe those.

Never write a real slug you have not confirmed. The aliases `inherit-parent` and `auto` are always valid even though no source lists them.

Record the supported efforts per model too. For GPT models, `detect` gives the list. For Claude models, the `claude` CLI accepts `low`, `medium`, `high`, `xhigh`, and `max`, so use that list unless the harness's own list shows fewer.

### 2. Load current state

Run `pstack models show --json`. It reports the config path, the recorded budget, every role with its value and source (`config` or `default`), and `retired`, the config lines whose role pstack no longer has. Treat the recorded budget and the `config` values as the current choices, and the rest as defaults. Drop each retired line, such as `how critics`.

If the config file is absent and `~/.cursor/rules/pstack-models.mdc` exists, that file is the Cursor-only rule upstream pstack wrote. Offer to import it. Below its frontmatter, its `# budget` line and role lines use the same format as the new config. Imported values are choices like any other, so step 4 still validates each one. Upstream's defaults name `grok-*` slugs, which only Cursor runs.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Use the harness's structured question, per the harness reference. Offer these four options with these exact labels, and name the current budget when the config records one. With no config, say that `large` matches the defaults.

- `unlimited, max reasoning`
- `large, xhigh reasoning`
- `medium, high reasoning`
- `small, medium reasoning`

**(b) Apply it.** Build the working table from the defaults in step 5, and on a rerun keep any role the user changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited`, `large`, `medium`, and `small` set the effort token of every real slug, panel entries included, to `max`, `xhigh`, `high`, or `medium`. The effort token is the last token, or the one before a trailing `-fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. `inherit-parent` and `auto` do not change.

Some models top out below `max`, and the effort list from step 1 says which. When a model lacks the target effort, use its highest supported effort at or below the target. If the result is still not a confirmed slug, mark the role as needing a choice.

With this fork's defaults:

- `unlimited` turns `gpt-6.1-sol-xhigh` into `gpt-6.1-sol-max` and `claude-opus-5-5-xhigh` into `claude-opus-5-5-max`.
- `large` keeps both defaults.
- `small` turns them into `gpt-6.1-sol-medium` and `claude-opus-5-5-medium`.
- A model whose efforts end at `xhigh` stays at `xhigh` under `unlimited`.

Some GPT models also offer `ultra`, which sits above `max`. No budget selects it. A user who wants it sets that role by hand in (c).

**(c) Show the roles and confirm.** Show every role with its model, and mark any real slug not in the detected set as needing a choice. Also list each line step 2 dropped. Ask, with a structured question, whether to accept the table as it is or change specific roles. Offer the detected models plus `inherit-parent` and `auto` as the options. Both aliases mean the role runs on the parent chat's model, which is how Auto users stay on Auto.

For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list. One subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena picks one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

The config applies in every harness on this machine. A slug only one harness can run, such as a `grok-*` slug that only Cursor reaches, falls back to the role's default everywhere else. Say so when the user picks one.

### 4. Validate

Every real slug written must be in the detected set or have passed `pstack models probe`. `inherit-parent` and `auto` always pass. If a chosen slug fails, stop and ask again.

### 5. Write the config

Create the parent directory of `pstack models path` if it is missing, then write the file. It has no frontmatter. It has a `# budget` line with the chosen label and its target effort, then one `role label: value` line per role. The labels must match `DEFAULTS` in `<pstack>/scripts/pstack` exactly, since `pstack models get` matches on them. Overwrite the whole file so reruns stay idempotent. The defaults, with `large`, look like this:

```
# pstack model configuration. One line per role. Delete a line to fall back to the default.
# A value of `inherit-parent` or `auto` runs the role on the parent chat model. Alias entries in a panel list still count toward its fan-out.
# budget: large (xhigh)
feature, refactoring: gpt-6.1-sol-xhigh
bug-fix: gpt-6.1-sol-xhigh
perf-issue: gpt-6.1-sol-xhigh
hillclimb: gpt-6.1-sol-xhigh
judgment and prose: claude-opus-5-5-xhigh
hardest tasks: claude-opus-5-5-xhigh
how explorer: gpt-6.1-sol-xhigh
how explainer: claude-opus-5-5-xhigh
why investigators: gpt-6.1-sol-xhigh
why synthesizer: claude-opus-5-5-xhigh
reflect tooling: gpt-6.1-sol-xhigh
reflect judgment, divergent, synthesizer: claude-opus-5-5-xhigh
arena runners: claude-opus-5-5-xhigh, gpt-6.1-sol-xhigh
arena cross-judge pool: claude-opus-5-5-xhigh, gpt-6.1-sol-xhigh
swarm workers: gpt-6.1-sol-xhigh
architect runners: claude-opus-5-5-xhigh, gpt-6.1-sol-xhigh
interrogate reviewers: claude-opus-5-5-xhigh, gpt-6.1-sol-xhigh
```

Then run `pstack models show` and check that every role reads `[config]` with the value you wrote and that no retired line remains.

If `~/.cursor/rules/pstack-models.mdc` exists, ask whether Cursor still runs upstream pstack. Upstream reads that rule, so keep it if so. If Cursor now runs this fork, offer to delete it. Cursor applies it to every chat, so its values would contradict the new config there. Delete it only on yes.

### 6. Confirm

Tell the user where the config was written. `pstack models get` reads it each time a skill spawns a subagent, so the new choices apply from the next spawn, in this chat and in every harness, with no restart. Rerunning this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with create-verification-skill." On yes, read `<pstack>/skills/create-verification-skill/SKILL.md` and follow it. On no, move on without pushing.
