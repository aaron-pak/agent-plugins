// Each run's private world: a temporary root holding the agent's home, its working folder, its
// config folder, a temp folder and the runner's own output. Nothing of the operator's loads: no
// settings, instruction files, memory, hooks, MCP servers or other plugins, and only an allowlist of
// the operator's environment (the PATH, locale, proxy and the model credentials) passes through.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Sandbox = { root: string; home: string; cwd: string; configDir: string; tmpDir: string; outDir: string };

export function createSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "evals-run-")));
  const box = {
    root,
    home: join(root, "home"),
    cwd: join(root, "home", "work"),
    configDir: join(root, "config"),
    tmpDir: join(root, "tmp"),
    outDir: join(root, "out"),
  };
  for (const dir of [box.home, box.cwd, box.configDir, box.tmpDir, box.outDir]) mkdirSync(dir, { recursive: true });
  return box;
}

export function removeSandbox(box: Sandbox): void {
  rmSync(box.root, { recursive: true, force: true });
}

const PASS_EXACT = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
]);
const PASS_PREFIX = ["LC_", "ANTHROPIC_", "AWS_", "VERTEX_REGION_"];

/** The operator's environment variables a run may see. */
export function passedEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (PASS_EXACT.has(k) || PASS_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

/** The environment a run's agent starts with. */
export function runEnv(
  box: Sandbox,
  extra: Record<string, string>,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...passedEnv(from),
    HOME: box.home,
    USERPROFILE: box.home,
    XDG_CONFIG_HOME: join(box.home, ".config"),
    XDG_DATA_HOME: join(box.home, ".local", "share"),
    XDG_CACHE_HOME: join(box.home, ".cache"),
    XDG_STATE_HOME: join(box.home, ".local", "state"),
    TMPDIR: box.tmpDir,
    TMP: box.tmpDir,
    TEMP: box.tmpDir,
    ...extra,
  };
}

/** The operator's real home, which a run must never read. */
export function operatorHome(): string {
  return homedir();
}

/** Every file under a folder, as paths relative to it with `/` separators. */
export function listFiles(dir: string, limit = 200_000): Set<string> {
  const out = new Set<string>();
  const walk = (rel: string, depth: number): void => {
    if (depth > 32 || out.size > limit) return;
    const abs = rel ? join(dir, rel) : dir;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      let s;
      try {
        s = statSync(join(dir, r));
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(r, depth + 1);
      else out.add(r);
    }
  };
  if (existsSync(dir)) walk("", 0);
  return out;
}

/** The files a run created: present after, absent before, sorted, one per line. */
export function createdFiles(before: Set<string>, after: Set<string>): string {
  return [...after]
    .filter((f) => !before.has(f))
    .sort()
    .join("\n");
}

export type Exec = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Runs a command to completion, with a timeout and an output cap. */
export function exec(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
    onSpawn?: (kill: () => void) => void;
  },
): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let pending = "";
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      } catch {}
      child.kill("SIGKILL");
    };
    options.onSpawn?.(kill);
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += chunk;
      if (options.onLine) {
        pending += chunk;
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          options.onLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    child.on("error", (error) => {
      stderr += String(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onLine && pending) options.onLine(pending);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
