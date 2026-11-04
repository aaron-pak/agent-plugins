// What the server and the hook read from their surroundings once, at startup: the home folder and the
// environment variables that say where the store is and which harness started them.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { Config, Context, Effect, Layer } from "effect";

/** The variables the plugin reads. */
export type Env = {
  /** The store's root, in place of ~/.agents/memory. */
  readonly AGENT_MEMORY_DIR?: string | undefined;
  /** The setting that moves Claude Code's auto memory to <dir>/projects/<project>/memory/. */
  readonly CLAUDE_CODE_REMOTE_MEMORY_DIR?: string | undefined;
  /** The plugin's folder, as Codex names it to a hook. */
  readonly PLUGIN_ROOT?: string | undefined;
  /** The plugin's folder, as Claude Code names it to a hook. */
  readonly CLAUDE_PLUGIN_ROOT?: string | undefined;
  /** "1" in a process Claude Code started, or one that inherited it. */
  readonly CLAUDECODE?: string | undefined;
  /** The folder a client started the server in, when it says so. */
  readonly PWD?: string | undefined;
};

const NAMES = [
  "AGENT_MEMORY_DIR",
  "CLAUDE_CODE_REMOTE_MEMORY_DIR",
  "PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDECODE",
  "PWD",
] as const satisfies ReadonlyArray<keyof Env>;

/** A path with a leading ~ read as the home folder. */
export const expandHome = (path: string, home: string) =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

/** The store's root: AGENT_MEMORY_DIR (a relative one from the home folder), else ~/.agents/memory. */
export function memoryRoot(env: Env, home: string): string {
  const set = env.AGENT_MEMORY_DIR?.trim();
  if (set) return resolve(home, expandHome(set, home));
  return join(home, ".agents", "memory");
}

export class MemoryConfig extends Context.Service<
  MemoryConfig,
  {
    readonly home: string;
    /** The store's root (memoryRoot). */
    readonly root: string;
    /** The folder the process was started in, when its PWD names one: absolute, else null. */
    readonly pwd: string | null;
    readonly env: Env;
  }
>()("auto-memory/MemoryConfig") {
  /** The config for these variables and home folder, as the layer makes it from the process's. */
  static make(env: Env, home: string): MemoryConfig["Service"] {
    return MemoryConfig.of({
      home,
      root: memoryRoot(env, home),
      pwd: env.PWD && isAbsolute(env.PWD) ? env.PWD : null,
      env,
    });
  }

  static readonly layer = Layer.effect(
    MemoryConfig,
    Effect.gen(function* () {
      const env: Record<string, string | undefined> = {};
      for (const name of NAMES) env[name] = (yield* Config.String(name).pipe(Config.withDefault(""))) || undefined;
      return MemoryConfig.make(env, homedir());
    }),
  );

  /** A layer with these variables and home folder, for tests. */
  static readonly layerWith = (env: Env, home = homedir()) => Layer.succeed(MemoryConfig, MemoryConfig.make(env, home));
}
