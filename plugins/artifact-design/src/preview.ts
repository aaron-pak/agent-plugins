// ArtifactCheck's preview: whether it can run here (Playwright and a Chromium, found by preview.mjs
// --check), and rendering a page as publish wraps it, through preview.mjs.

import { createHash } from "node:crypto";

import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { McpSchema } from "effect/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "./config.ts";
import { Drafts } from "./drafts.ts";
import { ActionError, messageOf } from "./errors.ts";
import { decodeSource, unwrap, usesHighlight, wrapPage } from "./publish.ts";
import { Skill } from "./skill.ts";

// How long tools/list waits for the startup check when there is no earlier answer.
const PREVIEW_WAIT = Duration.seconds(10);
const CHECK_TIMEOUT = Duration.seconds(30);
const RUN_TIMEOUT = Duration.minutes(4);
const DAY = 86_400_000;

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

const lastLine = (text: string) => text.trim().split(/\r?\n/).at(-1) ?? "";

// What preview.mjs prints last: the check's answer, and a preview's report.
const CheckAnswer = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.optional(Schema.Unknown), reason: Schema.optional(Schema.Unknown) }),
);
const Report = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.String,
    shots: Schema.optional(Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String }))),
    failed: Schema.optional(Schema.Boolean),
  }),
);
// A cached answer, as this server writes it.
const Cached = Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean }));

const isCacheName = (name: string) => /^preview-[0-9a-f]{16}\.json$/.test(name);

export type Options = { readonly widths: unknown; readonly themes: unknown };

export class Preview extends Context.Service<
  Preview,
  {
    /** Whether the tools list ArtifactCheck: the last check's answer when there is one, so the list
     * comes back at once and stays the same all session, and otherwise this start's own. */
    readonly offered: Effect.Effect<boolean>;
    /** Render a page file and report on it, as ArtifactCheck's preview. A call always waits for this
     * start's own check, before it looks for the file. */
    run(
      source: Effect.Effect<string, ActionError>,
      options: Options,
    ): Effect.Effect<McpSchema.CallToolResult, ActionError>;
  }
>()("artifact-design/Preview") {
  static readonly layer = Layer.effect(
    Preview,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const config = yield* ServerConfig;
      const drafts = yield* Drafts;
      const skill = yield* Skill;
      const script = paths.join(skill.scripts, "preview.mjs");
      const started = yield* Clock.currentTimeMillis;
      const uid = process.getuid?.();

      /** Run a script with this runtime, as preview.mjs expects, and collect its output; None when it
       * ran past the timeout and was stopped. */
      const runScript = (args: ReadonlyArray<string>, timeout: Duration.Input) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, args, {
              stdin: "ignore",
              windowsHide: true,
              forceKillAfter: "2 seconds",
            }),
          );
          const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
            stream.pipe(
              Stream.decodeText,
              Stream.mkString,
              Effect.orElseSucceed(() => ""),
            );
          // A script killed by a signal has no exit code; it still failed, and its output says why.
          const [stdout, stderr, exit] = yield* Effect.all(
            [text(handle.stdout), text(handle.stderr), Effect.exit(handle.exitCode)],
            {
              concurrency: "unbounded",
            },
          );
          return { code: Exit.isSuccess(exit) ? Number(exit.value) : 1, stdout, stderr } satisfies Run;
        }).pipe(
          Effect.scoped, // stops the script, and anything it started, when it is done or out of time
          Effect.timeoutOption(timeout),
          Effect.catch((error) => Effect.succeed(Option.some({ code: 1, stdout: "", stderr: error.message }))),
        );

      // The last check's answer, kept in this user's own drafts folder so that tools/list can answer
      // at once instead of making Claude Code start its first turn without the tool. Each setup
      // (runtime, search path, Playwright's browser folder and preview.mjs) keeps its own answer; a
      // setup with none yet (after an update to the plugin, say) takes the newest one, and this
      // start's check adds its own for the next start.
      const cacheFile = yield* fs.stat(script).pipe(
        Effect.map((info) => {
          const key = JSON.stringify([
            process.execPath,
            config.path,
            config.browsersPath,
            Number(info.size),
            Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
          ]);
          const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
          return Option.some(paths.join(drafts.root, `preview-${hash}.json`));
        }),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

      /** A cached answer: a regular file of this user's in their own drafts folder. */
      const readCached = (path: string) =>
        Effect.gen(function* () {
          const info = yield* fs.lstat(path);
          if (info.type !== "File" || (uid !== undefined && Option.getOrUndefined(info.uid) !== uid)) {
            return Option.none();
          }
          const cached = yield* Schema.decodeEffect(Cached)(yield* fs.readFileString(path));
          return Option.some({ ok: cached.ok, mtime: Option.getOrElse(info.mtime, () => new Date(0)).getTime() });
        }).pipe(Effect.orElseSucceed(() => Option.none()));

      const cached: Option.Option<boolean> = yield* Effect.gen(function* () {
        if (!config.previewSwitch || Option.isNone(cacheFile) || !(yield* drafts.rootIsOwn)) return Option.none();
        const own = yield* readCached(cacheFile.value);
        if (Option.isSome(own)) return Option.some(own.value.ok);
        let newest: { ok: boolean; mtime: number } | undefined;
        for (const name of yield* fs.readDirectory(drafts.root)) {
          if (!isCacheName(name)) continue;
          const answer = Option.getOrUndefined(yield* readCached(paths.join(drafts.root, name)));
          if (answer && (!newest || answer.mtime > newest.mtime)) newest = answer;
        }
        return Option.fromUndefinedOr(newest?.ok);
      }).pipe(Effect.orElseSucceed(() => Option.none()));

      /** Keep this start's answer for the next start, written whole, and drop answers no start has
       * written for a month, and temp files a crash left. */
      const saveCached = (ok: boolean) =>
        Effect.gen(function* () {
          if (Option.isNone(cacheFile) || !(yield* drafts.rootIsOwn)) return;
          const temp = `${cacheFile.value}.${process.pid}.tmp`;
          yield* fs.writeFileString(temp, JSON.stringify({ ok }), { mode: 0o600 });
          yield* fs.rename(temp, cacheFile.value);
          const now = yield* Clock.currentTimeMillis;
          for (const name of yield* fs.readDirectory(drafts.root)) {
            const path = paths.join(drafts.root, name);
            const info = yield* fs.lstat(path);
            const age = now - Option.getOrElse(info.mtime, () => new Date(now)).getTime();
            const leftover = /^preview-[0-9a-f]{16}\.json\.\d+\.tmp$/.test(name) && age > DAY;
            if ((isCacheName(name) && age > 30 * DAY) || leftover) yield* fs.remove(path, { force: true });
          }
        }).pipe(Effect.ignore); // the next start checks again

      // This start's check: whether preview can run here, and why not.
      const check = yield* Deferred.make<{ readonly ok: boolean; readonly reason: string }>();
      yield* Effect.gen(function* () {
        if (!config.previewSwitch) return { ok: false, reason: "ARTIFACT_PREVIEW=0 turns preview off" };
        const run = yield* runScript([script, "--check"], CHECK_TIMEOUT);
        // A check that ran out of time says nothing about this setup, so it isn't kept for the next start.
        if (Option.isNone(run)) return { ok: false, reason: "the preview check timed out" };
        const found = yield* Schema.decodeEffect(CheckAnswer)(lastLine(run.value.stdout)).pipe(
          Effect.mapError(
            (error) => new ActionError({ message: `the preview check failed (${error.message.split("\n")[0]})` }),
          ),
        );
        const ok = found.ok === true;
        const reason = typeof found.reason === "string" ? found.reason : JSON.stringify(found.reason ?? null);
        if (!ok) yield* Effect.logWarning(`artifact: no preview here: ${reason}`);
        yield* saveCached(ok); // every start, so a setup still in use never ages out
        return { ok, reason };
      }).pipe(
        // Whatever went wrong, the check is answered, so no call waits on it.
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const error = Cause.squash(cause);
          const reason =
            error instanceof ActionError
              ? error.message
              : `the preview check failed (${error instanceof Error ? error.message : String(error)})`;
          return Effect.succeed({ ok: false, reason });
        }),
        Effect.flatMap((answer) => Deferred.succeed(check, answer)),
        Effect.forkScoped,
      );

      /** This start's own answer, waiting for it until PREVIEW_WAIT after the start. */
      const ready = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const wait = Math.max(0, started + Duration.toMillis(PREVIEW_WAIT) - now);
        const answer = yield* Deferred.await(check).pipe(Effect.timeoutOption(Duration.millis(wait)));
        return Option.getOrElse(answer, () => ({ ok: false, reason: "the preview check has not finished" }));
      });

      const offered = Option.isSome(cached) ? Effect.succeed(cached.value) : Effect.map(ready, (answer) => answer.ok);

      const run = (page: Effect.Effect<string, ActionError>, options: Options) =>
        Effect.gen(function* () {
          const answer = yield* ready;
          if (!answer.ok) {
            return yield* new ActionError({
              message: `preview isn't available here (${answer.reason}). Skip the look and publish.`,
            });
          }
          const source = yield* page;
          const failed = (error: { readonly message: string; readonly cause?: unknown }) =>
            new ActionError({ message: messageOf(error) });
          // Captures stay on disk, as Claude Code's do, in this session's private drafts folder.
          const previews = paths.join(drafts.folder, ".previews");
          yield* fs.makeDirectory(previews, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failed));
          const extension = paths.extname(source);
          const stem = paths.basename(source, extension);
          const out = yield* fs
            .makeTempDirectory({ directory: previews, prefix: `${stem.slice(0, 40)}-` })
            .pipe(Effect.mapError(failed));
          // preview.mjs renders the page as publish wraps it; it refuses anything but a non-empty .html
          // page before reading this copy.
          const wrapped = paths.join(out, "published.html");
          if ([".html", ".htm"].includes(extension.toLowerCase())) {
            const bytes = yield* fs.readFile(source).pipe(Effect.mapError(failed));
            const decoded = yield* Effect.result(decodeSource(bytes));
            if (decoded._tag === "Failure") {
              const why = decoded.failure.message.replace(
                "then publish again. Nothing was published.",
                "then preview again.",
              );
              return textResult(`Could not preview ${paths.basename(source)}: ${why}`, true);
            }
            const { content, lang, cover } = unwrap(decoded.success);
            const highlight = usesHighlight(content) ? yield* skill.highlightRuntime : "";
            yield* fs
              .writeFileString(wrapped, wrapPage(content, null, null, highlight, lang, cover))
              .pipe(Effect.mapError(failed));
          }
          return yield* report(source, wrapped, out, options);
        });

      const report = (source: string, wrapped: string, out: string, { widths, themes }: Options) =>
        Effect.gen(function* () {
          const args = [script, source, "--wrapped", wrapped, "--json", "--out", out];
          // preview.mjs clamps and filters these as Claude Code does.
          if (Array.isArray(widths)) args.push("--widths", widths.filter((w) => typeof w === "number").join(","));
          if (Array.isArray(themes)) args.push("--themes", themes.filter((t) => typeof t === "string").join(","));
          const ran = yield* runScript(args, RUN_TIMEOUT);
          if (Option.isNone(ran)) {
            return yield* new ActionError({
              message: "the preview ran for 4 minutes without finishing and was stopped; skip the look and publish",
            });
          }
          const { code, stdout, stderr } = ran.value;
          const parsed = Schema.decodeUnknownOption(Report)(lastLine(stdout));
          if (code !== 0 || Option.isNone(parsed)) {
            const output = (stdout + stderr).trim().slice(-2000);
            return textResult(`preview failed: ${output || "no output"}`, true);
          }
          // Like Claude Code's preview, the result carries each capture as an image after the report,
          // and a preview that captured nothing is an error.
          const content: Array<McpSchema.CallToolResult["content"][number]> = [
            { type: "text", text: parsed.value.text },
          ];
          for (const [n, shot] of (parsed.value.shots ?? []).entries()) {
            const bytes = yield* fs.readFile(shot.path).pipe(Effect.option);
            if (Option.isNone(bytes)) continue;
            const data = bytes.value;
            // A JPEG, at most 1,400,000 characters as base64.
            const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
            if (!jpeg || Math.ceil(data.length / 3) * 4 > 1_400_000) continue;
            content.push({ type: "text", text: `Capture ${n + 1} (${shot.label}):` });
            content.push({ type: "image", data, mimeType: "image/jpeg" });
          }
          return new McpSchema.CallToolResult({ content, isError: parsed.value.failed === true });
        });

      return Preview.of({ offered, run });
    }),
  );
}

/** A tool result of one text. */
export const textResult = (text: string, isError = false): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
