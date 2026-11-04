// The Artifact tool's actions: quickstart, publish, read, list, open and delete, and ArtifactCheck's
// preview, as the server answers a call to either tool.

import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Ref } from "effect";
import type { McpSchema } from "effect/ai";

import { Browser } from "./browser.ts";
import { ServerConfig } from "./config.ts";
import { Drafts } from "./drafts.ts";
import { applyEdits, editsOf, missMessage, savedMessage, type Edit } from "./edits.ts";
import { ActionError, messageOf, Refusal } from "./errors.ts";
import { escape } from "./html.ts";
import { partsBelow, resolvePath } from "./paths.ts";
import { Preview, textResult } from "./preview.ts";
import {
  FULL_DOCUMENT_NOTE,
  OWN_FILES_FETCH_NOTE,
  SIZE_LIMIT,
  decodeSource,
  fetchesOwnFiles,
  isFullDocument,
  markdownPage,
  pageDescription,
  pageTitle,
  unwrap,
  usesHighlight,
  wrapPage,
} from "./publish.ts";
import { Skill } from "./skill.ts";
import { Store, isoSeconds, repr, slugify, type Entry } from "./store.ts";
import { unknownParameter } from "./tool.ts";

type Args = Readonly<Record<string, unknown>>;
type Result = string | McpSchema.CallToolResult;

// How many sessions an artifact remembers, newest first, for when another one updates it with `url`.
const SESSIONS_KEPT = 8;
// The most of a file a refused publish with edits shows back, so that the result stays under what
// Claude Code passes on from an MCP tool.
const MISS_ROOM = 40_000;

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const pyStr = (value: string | number | null | undefined) =>
  value === null || value === undefined ? "None" : `${value}`;
/** An entry's session IDs, ignoring a value an older build or a hand edit left that isn't a list. */
const sessionsOf = (entry: Entry): Array<string> =>
  Array.isArray(entry.sessions) ? entry.sessions.filter((id) => typeof id === "string") : [];

/** A refusal for widths or themes outside what ArtifactCheck's schema allows, or null. */
function badPreviewOption(args: Args): string | null {
  const { widths, themes } = args;
  const ok = (list: unknown, max: number, item: (value: unknown) => boolean) =>
    list === undefined || (Array.isArray(list) && list.length >= 1 && list.length <= max && list.every(item));
  if (!ok(widths, 3, (w) => typeof w === "number" && Number.isInteger(w) && w >= 320 && w <= 2560)) {
    return "`widths` takes one to three whole numbers of CSS pixels from 320 to 2560. Nothing was rendered.";
  }
  if (!ok(themes, 2, (t) => t === "light" || t === "dark")) {
    return "`themes` takes 'light', 'dark' or both. Nothing was rendered.";
  }
  return null;
}

export class Artifacts extends Context.Service<
  Artifacts,
  {
    /** A call to the Artifact tool. */
    call(args: Args): Effect.Effect<McpSchema.CallToolResult>;
    /** A call to the ArtifactCheck tool. */
    check(args: Args): Effect.Effect<McpSchema.CallToolResult>;
  }
>()("artifact-design/Artifacts") {
  static readonly layer = Layer.effect(
    Artifacts,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const config = yield* ServerConfig;
      const store = yield* Store;
      const drafts = yield* Drafts;
      const skill = yield* Skill;
      const browser = yield* Browser;
      const preview = yield* Preview;
      const failed = (error: { readonly message: string; readonly cause?: unknown }) =>
        new ActionError({ message: messageOf(error) });
      const refuse = (message: string) => Effect.fail(new Refusal({ message }));
      const fail = (message: string) => Effect.fail(new ActionError({ message }));
      // The drafts root may sit under a symlink (macOS's /var/folders), and a source path is resolved.
      const draftsRoots = [drafts.root, yield* resolvePath(drafts.root)];

      // The source files this server process published, and their artifacts: like the Artifact
      // tool's per-session map, a path republished in this session updates its artifact. A session
      // goes on past its server, though: a resumed one starts a new server, and Claude Code can switch
      // sessions under a running one, so a republish also finds an artifact this session published
      // before (see `ours`).
      const sessionSources = yield* Ref.make<ReadonlyMap<string, { slug: string; created: string | null }>>(new Map());

      /** Whether a publish of `source` continues the session that published `entry` before: the entry
       * lists this session's ID, or the file is in a drafts folder. Each server start makes its own
       * drafts folder, so a later server meets a file in one only when the conversation that wrote it
       * goes on, which covers Codex, where no session ID reaches the server, and a session switched to
       * under a running Claude Code server, which keeps the ID it started with. */
      const ours = (source: string, entry: Entry): boolean =>
        (config.sessionId !== null && sessionsOf(entry).includes(config.sessionId)) ||
        draftsRoots.some((root) => (partsBelow(paths, root, source)?.length ?? 0) >= 2);

      /** The highlight.js runtime when the page needs it. */
      const highlightFor = (content: string) => (usesHighlight(content) ? skill.highlightRuntime : Effect.succeed(""));

      const quickstart = Effect.gen(function* () {
        // Claude Code's quickstart leaves the empty dataviz callout's blank lines before "## Process".
        let guidance = (yield* skill.guidance).replace("\n\n## Process", () => "\n\n\n\n## Process");
        // Name ArtifactCheck only where it is listed.
        if (!(config.previewSwitch && (yield* preview.offered))) {
          guidance = guidance.replace(
            "one `ArtifactCheck` preview, or else one screenshot of the local file; if the session offers none of these, " +
              "skip the look. The preview renders desktop and phone widths in light and dark and lists overflow, colors " +
              "that ignore the theme, blocked loads and console errors, including a script that fails to parse, so nothing " +
              "it covers needs a check of your own.",
            () => "one screenshot of the local file; if the session offers no way, skip the look.",
          );
        }
        return (
          "For a plain page, the page-design guidance follows. It is the `artifact-design` skill's own " +
          "text, so do not load that skill as well. Write the page to a file and publish it in the same " +
          "message: the two calls run in order. Unless the person named a location, the file goes in " +
          `${drafts.folder}, not in the project. In this text, Claude means you.\n\n` +
          guidance +
          "\n\nWhen the page includes a diagram, also load the `artifact-diagramming` skill" +
          (config.codex ? "" : " (`artifact-design:artifact-diagramming` in the Skill tool)") +
          " before writing it."
        );
      });

      /** Write a publish's edited text back to its file, unless the file changed while it was
       * published or has other names, and say how that went. */
      const saveEdits = (source: string, before: Uint8Array, text: string, count: number) =>
        Effect.gen(function* () {
          const now = yield* fs.readFile(source).pipe(Effect.option);
          if (Option.isNone(now) || Buffer.compare(now.value, before) !== 0) {
            return savedMessage(count, "changed_during_publish");
          }
          const links = yield* fs.stat(source).pipe(
            Effect.map((info) => Option.getOrElse(info.nlink, () => 1n)),
            Effect.option,
          );
          if (Option.isNone(links)) return savedMessage(count, "changed_during_publish");
          if (links.value > 1n) return savedMessage(count, "hard_linked");
          const bom = before[0] === 0xef && before[1] === 0xbb && before[2] === 0xbf ? "\uFEFF" : "";
          const data = new TextEncoder().encode(bom + text);
          // Opening doesn't truncate, so a file that can't be written stays whole.
          const file = yield* fs.open(source, { flag: "r+" }).pipe(Effect.option);
          if (Option.isNone(file)) return savedMessage(count, "not_writable");
          return yield* file.value.writeAll(data).pipe(
            Effect.andThen(file.value.truncate(data.length)),
            Effect.as(savedMessage(count)),
            Effect.orElseSucceed(() => savedMessage(count, "write_failed")),
          );
        }).pipe(Effect.scoped);

      const publish = (args: Args) =>
        Effect.gen(function* () {
          if (!args.file_path) return yield* fail("publish needs file_path: write the page to a file first");
          const source = yield* store.absolute(args.file_path, "file_path");
          if (!(yield* store.isFile(source))) return yield* fail(`${source} doesn't exist; write the page there first`);
          let edits: Array<Edit> | null = null;
          if (args.edits !== undefined) {
            const parsed = editsOf(args.edits);
            if (typeof parsed === "string") return yield* refuse(`${parsed} Nothing was published.`);
            if (args.files !== undefined) {
              return yield* refuse(
                "`edits` changes only the file at `file_path`: not with `files` (publish the other files in a call " +
                  "without edits). Nothing was published.",
              );
            }
            const below = partsBelow(paths, store.path, source);
            if (below && below.length >= 2 && (yield* store.load())[0].has(below[0]!)) {
              return yield* refuse(
                `No edits were applied and nothing was published: ${source} is a file inside the published artifact ` +
                  `${below[0]} in ${store.path}, and \`edits\` changes a page's source file. Publish the source file ` +
                  "with edits instead, or edit this file and publish it without edits.",
              );
            }
            edits = parsed;
          }
          const bytes = yield* fs.readFile(source).pipe(Effect.mapError(failed));
          const decoded = yield* Effect.result(decodeSource(bytes));
          if (decoded._tag === "Failure") {
            if (edits) return yield* refuse(`No edits were applied: ${decoded.failure.message}`);
            return yield* fail(`file_path: ${decoded.failure.message}`);
          }
          let raw = decoded.success;
          if (edits) {
            const applied = applyEdits(raw, edits);
            if (!applied.ok) return yield* refuse(missMessage(applied.miss, edits, raw, MISS_ROOM));
            raw = applied.text;
          }
          const [index, repaired] = yield* store.load(true);
          const notes = repaired ? [repaired] : [];
          let slug: string | null = null;
          let entry: Entry | null = null;
          if (args.url) {
            const found = yield* store.find(args.url, index);
            if (!found) {
              return yield* fail(
                `no published artifact has the link ${typeof args.url === "string" ? args.url : JSON.stringify(args.url)}; list them with action "list"`,
              );
            }
            [slug, entry] = found;
          } else {
            // A file inside an artifact's folder is that artifact's own page, edited in place: an update.
            const [inside, own] = store.pageOf(source, index);
            if (inside && !own) {
              return yield* fail(
                `${source} is a file inside the published artifact ${inside}; publish its source ` +
                  `(${index.get(inside)!.source || "unknown"}) or copy the file out of ${store.path} first`,
              );
            }
            const known = (yield* Ref.get(sessionSources)).get(source);
            if (inside) {
              slug = inside;
              entry = index.get(inside)!;
              if (entry.source && entry.source !== source) {
                notes.push(
                  "That file is the artifact's published page, so the artifact was updated in place; " +
                    `its source file ${entry.source} doesn't have this change.`,
                );
              }
            } else if (known !== undefined && index.get(known.slug)?.created === known.created) {
              // Like the Artifact tool's map, this session's keeps every path it published to an
              // artifact, even after a publish with `url` from another file made that one the artifact's
              // source; the creation time tells the artifact from a later one that took its folder
              // after a delete.
              slug = known.slug;
              entry = index.get(known.slug)!;
            } else {
              // The newest artifact from this path, and the newest of those this session published:
              // another session may have published the same file since.
              let earlier: readonly [string, Entry] | null = null;
              let mine: readonly [string, Entry] | null = null;
              for (const [other, otherEntry] of index) {
                if (otherEntry.source !== source) continue;
                const newer = (than: readonly [string, Entry] | null) =>
                  !than || (otherEntry.updated || "") > (than[1].updated || "");
                if (newer(earlier)) earlier = [other, otherEntry];
                if (newer(mine) && ours(source, otherEntry)) mine = [other, otherEntry];
              }
              if (mine) {
                [slug, entry] = mine;
              } else if (earlier) {
                notes.push(
                  `This path was published before as ${store.linkOf(...earlier)}, in an earlier session; ` +
                    "that artifact is unchanged. Pass `url` to update that one instead.",
                );
              }
            }
          }

          const name = paths.basename(source);
          const extension = paths.extname(name);
          const stem = paths.basename(name, extension);
          const isMarkdown = [".md", ".markdown"].includes(extension.toLowerCase());
          let content: string;
          let title: string | null;
          let oldDescription: string | null = null;
          let lang: string | null = null;
          let cover: boolean | null = null;
          if (isMarkdown) {
            // Rendered into the document template the Artifact tool uses for Markdown, whose tab shows
            // the file name; like the Artifact tool's, the artifact keeps its file's name, or the one
            // it has.
            [content] = markdownPage(raw, name);
            title = entry?.title || name;
          } else {
            ({ content, description: oldDescription, lang, cover } = unwrap(raw));
            if (cover === null && isFullDocument(content)) notes.push(FULL_DOCUMENT_NOTE);
            title = pageTitle(content);
            const asked = str(typeof args.title === "string" ? args.title.trim() : null);
            if (!title && asked) {
              title = asked;
              content = `<title>${escape(title)}</title>\n` + content;
            } else if (title && asked && title !== asked && title !== pageTitle(`<title>${asked}</title>`)) {
              const cut = (text: string) => {
                const chars = Array.from(text);
                return chars.length > 120 ? `${chars.slice(0, 120).join("")}\u2026` : text;
              };
              notes.push(
                `The document's own <title> ("${cut(title)}") names this artifact; the \`title\` parameter ("${cut(asked)}") ` +
                  "was not applied \u2014 the tag always wins. To rename, edit the <title> in the HTML.",
              );
            }
            if (!title) {
              notes.push(
                "The page has no <title> in its first 8KB (one after an <svg> doesn't count), so the " +
                  "artifact is named after the file: put a <title> at the top, or pass `title`.",
              );
            }
          }
          // A description passed now or before stays; otherwise, as the Artifact tool does, each
          // publish takes one from the page again.
          const given =
            str(args.description) ?? (entry && !entry.derived ? entry.description || null : null) ?? oldDescription;
          const description = given ?? (isMarkdown ? null : pageDescription(content, stem) || null);
          const icon = str(args.icon) ?? (entry?.icon || null);
          if (fetchesOwnFiles(content)) notes.push(OWN_FILES_FETCH_NOTE);
          const published = wrapPage(content, description, icon, yield* highlightFor(content), lang, cover);
          if (Buffer.byteLength(published) > SIZE_LIMIT) {
            return yield* fail("the page is over 16MB; shrink it or move data into supporting files");
          }

          const first = slug === null || entry === null;
          if (slug === null || entry === null) {
            // A new folder never reuses one already on disk, whether or not the index knows it.
            const base = slugify((isMarkdown ? null : title) || stem);
            slug = base;
            for (
              let n = 2;
              index.has(slug) ||
              (yield* fs.exists(paths.join(store.path, slug)).pipe(Effect.orElseSucceed(() => false)));
              n++
            ) {
              slug = `${base}-${n}`;
            }
            entry = { source, version: 0, created: null, page: "index.html" };
          }
          const folder = paths.join(store.path, slug);
          const plan = yield* store.planFiles(args.files, folder, paths.dirname(source), "index.html");

          const pageFile = paths.join(folder, "index.html");
          const version = (entry.version ?? 0) + 1;
          yield* Effect.gen(function* () {
            yield* fs.makeDirectory(folder, { recursive: true });
            yield* store.applyFiles(plan);
            // published before Markdown was rendered
            if (entry.page === "index.md") yield* fs.remove(paths.join(folder, "index.md"), { force: true });
            yield* fs.writeFileString(pageFile, published);
            yield* fs.makeDirectory(paths.join(folder, ".versions"), { recursive: true });
            yield* fs.writeFileString(paths.join(folder, ".versions", `${version}.html`), published);
          }).pipe(Effect.mapError(failed));
          entry.version = version;
          const now = isoSeconds(new Date(yield* Clock.currentTimeMillis));
          if (first || !store.pageOf(source, index)[1]) entry.source = source;
          Object.assign(entry, {
            page: "index.html",
            title: title || (isMarkdown ? name : stem),
            updated: now,
            description,
            icon,
          });
          if (config.sessionId) {
            const id = config.sessionId;
            entry.sessions = [id, ...sessionsOf(entry).filter((other) => other !== id)].slice(0, SESSIONS_KEPT);
          }
          if (given === null && description !== null) entry.derived = true;
          else delete entry.derived;
          entry.created = entry.created || now;
          index.set(slug, entry);
          yield* store.save(index);
          const created = entry.created;
          const owner = slug;
          yield* Ref.update(sessionSources, (map) => new Map(map).set(source, { slug: owner, created }));

          const link = store.linkOf(slug, entry);
          const lines = [
            `Published ${source} at ${link} (Version ${entry.version})` + (first && icon ? ` Icon: "${icon}".` : ""),
          ];
          if (edits) lines.push(yield* saveEdits(source, bytes, raw, edits.length));
          lines.push(...notes);
          lines.push(
            "To update: publish the same file path again in this session (keeps this link); pass `url` to " +
              "update this artifact from another file or a later session.",
          );
          lines.push(
            "The link is a file on this machine. If the page is meant for someone else, tell the user when you " +
              "present the page that to share it they send the published page, " +
              ((yield* store.hasOtherFiles(folder, pageFile))
                ? `the ${folder} folder, without its .versions folder`
                : pageFile) +
              ", not the source file, which lacks the page skeleton.",
          );
          lines.push(
            "The files you sent are still on disk. For the next small change to this file, send it as `edits` on a " +
              "publish of the same file_path (old_str/new_str pairs copied exactly from the file as it now stands): that " +
              "one call changes the file and what is published together, with no separate read or edit. To change several " +
              "files, or to rewrite most of the page, edit the files and publish them in the same response; if an edit " +
              "did not apply, correct it and publish again. If the file's text is no longer in this conversation, read " +
              "it first.",
          );
          if (first) {
            if (!config.openPages) {
              lines.push("The page was not opened in a browser (ARTIFACT_OPEN=0); give the user the link.");
            } else if (yield* browser.open(pageFile)) {
              lines.push("Opened it in the browser.");
            } else {
              lines.push("This server can't open a browser here, so the page was not opened; give the user the link.");
            }
          }
          return lines.join("\n\n");
        });

      const list = Effect.gen(function* () {
        const [index] = yield* store.load();
        if (!index.size) return `No artifacts published yet (folder: ${store.path}).`;
        const rows = [...index].sort(([, a], [, b]) => {
          const [x, y] = [a.updated || "", b.updated || ""];
          return x < y ? 1 : x > y ? -1 : 0;
        });
        return rows
          .map(
            ([slug, entry]) =>
              `- ${entry.title || slug} \u2014 ${store.linkOf(slug, entry)} (updated ${pyStr(entry.updated)}, ` +
              `source ${entry.source || "unknown"})`,
          )
          .join("\n");
      });

      const read = (args: Args) =>
        Effect.gen(function* () {
          const [index] = yield* store.load();
          const found = yield* store.find(args.url, index);
          if (!found) return yield* fail('read needs the `url` of a published artifact; list them with action "list"');
          const [slug, entry] = found;
          const text = yield* fs.readFileString(paths.join(store.path, slug, entry.page)).pipe(Effect.mapError(failed));
          const content = entry.page.endsWith(".html") ? unwrap(text).content : text;
          return (
            `${store.linkOf(slug, entry)} (Version ${pyStr(entry.version)}, source ${entry.source || "unknown"})\n` +
            "This is the page content without the skeleton (doctype, head, base styles, Mermaid runtime); " +
            "publishing adds the skeleton again.\n\n" +
            content
          );
        });

      const remove = (args: Args) =>
        Effect.gen(function* () {
          const [slug, entry, repaired] = yield* store.withLock(
            Effect.gen(function* () {
              const [index, note] = yield* store.load(true);
              const found = yield* store.find(args.url, index);
              if (!found) {
                return yield* fail('delete needs the `url` of a published artifact; list them with action "list"');
              }
              // Whatever is left stays on disk, out of the index.
              yield* fs.remove(paths.join(store.path, found[0]), { recursive: true, force: true }).pipe(Effect.ignore);
              index.delete(found[0]);
              yield* store.save(index);
              return [...found, note] as const;
            }),
          );
          yield* Ref.update(sessionSources, (map) => new Map([...map].filter(([, owner]) => owner.slug !== slug)));
          return (
            (repaired ? repaired + "\n\n" : "") +
            `Deleted ${entry.title || slug} and its versions; its link no longer opens. ` +
            `The source file ${entry.source || "(unknown)"} is untouched.`
          );
        });

      const open = (args: Args) =>
        Effect.gen(function* () {
          const [index] = yield* store.load();
          const found = yield* store.find(args.url, index);
          if (!found) return yield* fail("open needs the `url` of a published artifact");
          const [slug, entry] = found;
          const link = store.linkOf(slug, entry);
          return (yield* browser.open(paths.join(store.path, slug, entry.page)))
            ? `Opened ${link}.`
            : `There is no browser to open here; the page is ${link}.`;
        });

      const actions: Record<string, (args: Args) => Effect.Effect<Result, ActionError | Refusal>> = {
        publish: (args) => store.withLock(publish(args)),
        quickstart: () => quickstart,
        read,
        list: () => list,
        open,
        delete: remove,
      };

      /** An action's result, or its failure as a tool error: a refusal as it is, anything else after
       * "<action> failed:". */
      const answer = (action: string, effect: Effect.Effect<Result, ActionError | Refusal>) =>
        effect.pipe(
          Effect.map((result) => (typeof result === "string" ? textResult(result) : result)),
          Effect.catchTags({
            Refusal: (error) => Effect.succeed(textResult(error.message, true)),
            ActionError: (error) => Effect.succeed(textResult(`${action} failed: ${error.message}`, true)),
          }),
          // Anything unforeseen is a tool error too, not a protocol error the model can't read.
          Effect.catchDefect((defect) =>
            Effect.succeed(
              textResult(`${action} failed: ${defect instanceof Error ? defect.message : String(defect)}`, true),
            ),
          ),
        );

      const call = (args: Args) =>
        Effect.gen(function* () {
          const problem = unknownParameter(args);
          if (problem) return textResult(problem, true);
          const action = args.action || "publish";
          if (action === "preview" && config.previewSwitch && (yield* preview.offered)) {
            return textResult(
              "preview is an action of the ArtifactCheck tool: call ArtifactCheck with `file_path`.",
              true,
            );
          }
          if (typeof action !== "string" || !Object.hasOwn(actions, action)) {
            return textResult(`Unknown action ${repr(action)}.`, true);
          }
          if (args.edits !== undefined && action !== "publish") {
            return textResult(
              `\`edits\` applies only to a publish of \`file_path\` \u2014 remove it from this "${action}" call.`,
              true,
            );
          }
          return yield* answer(action, actions[action]!(args));
        });

      const check = (args: Args) =>
        Effect.gen(function* () {
          const problem = unknownParameter(args, true) ?? badPreviewOption(args);
          if (problem) return textResult(problem, true);
          const action = args.action ?? "preview";
          if (action !== "preview") return textResult(`Unknown action ${repr(action)}.`, true);
          return yield* answer(
            "preview",
            preview.run(
              Effect.gen(function* () {
                if (!args.file_path) return yield* fail("preview needs `file_path`: the local .html page to render.");
                const source = yield* store.absolute(args.file_path, "file_path");
                if (!(yield* store.isFile(source))) return yield* fail(`${source} doesn't exist`);
                return source;
              }),
              { widths: args.widths, themes: args.themes },
            ),
          );
        });

      return Artifacts.of({ call, check });
    }),
  );
}
