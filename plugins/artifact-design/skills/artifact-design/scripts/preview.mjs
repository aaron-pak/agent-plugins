#!/usr/bin/env node
// Preview an HTML artifact the way Claude Code's ArtifactCheck does, before publishing it.
//
//   node preview.mjs page.html [--out dir]
//
// Wraps the page with publish.py (without touching the file), serves it over http from the
// page's folder so its own files load as they do on claude.ai, renders it at desktop and
// phone widths in light and dark, saves a screenshot of each, and lists horizontal
// overflow, text too faint to read against its background (colors that ignore the
// theme), loads the claude.ai allowlist blocks, and console errors, including a script
// that fails to parse. Needs Playwright and a Chromium; without them it says so and
// exits, and the skill skips the look.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const page = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
if (!page) {
  console.error("usage: node preview.mjs page.html [--out dir]");
  process.exit(1);
}

function loadPlaywright() {
  const roots = [import.meta.url];
  try {
    roots.push(pathToFileURL(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "noop.js")).href);
  } catch {}
  for (const root of roots) {
    const require = createRequire(root);
    for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
      try {
        return require(name);
      } catch {}
    }
  }
  return null;
}

const playwright = loadPlaywright();
if (!playwright) {
  console.log("Playwright isn't installed here, so there is no preview. Skip the look and publish.");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const stem = basename(page, extname(page));
const outDir = outIndex !== -1 ? resolve(args[outIndex + 1]) : mkdtempSync(join(tmpdir(), `artifact-preview-${stem}-`));
mkdirSync(outDir, { recursive: true });
const wrapped = join(outDir, `${stem}.html`);
execFileSync("python3", [join(here, "publish.py"), page, "--out", wrapped, "--no-open", "--quiet"]);

// Serve the wrapped page from the page's own folder, so relative images, scripts and
// fetch() calls resolve the way they do for files published alongside an artifact.
const pageDir = dirname(resolve(page));
const route = `/${stem}.preview.html`;
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain",
  ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
  ".pdf": "application/pdf", ".wasm": "application/wasm",
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (path === route) {
    res.writeHead(200, { "content-type": types[".html"] });
    return res.end(readFileSync(wrapped));
  }
  const file = resolve(pageDir, `.${path}`);
  if (!file.startsWith(pageDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const pageUrl = `http://127.0.0.1:${server.address().port}${encodeURI(route)}`;

let browser;
try {
  browser = await playwright.chromium.launch();
} catch (error) {
  console.log(`No Chromium for Playwright here (${error.message.split("\n")[0]}). Skip the look and publish.`);
  server.close();
  process.exit(0);
}

const views = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true },
];
const findings = new Map(); // message -> views it appeared in
const note = (label, message) => {
  if (!findings.has(message)) findings.set(message, []);
  findings.get(message).push(label);
};
const shots = [];
const backgrounds = {};

for (const view of views) {
  for (const scheme of ["light", "dark"]) {
    const label = `${view.name} ${scheme}`;
    const context = await browser.newContext({
      viewport: view.viewport,
      isMobile: view.isMobile ?? false,
      hasTouch: view.hasTouch ?? false,
      colorScheme: scheme,
    });
    const tab = await context.newPage();
    await tab.addInitScript(() => {
      window.__blocked = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__blocked.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`);
      });
    });
    tab.on("console", (msg) => {
      const text = msg.text().trim();
      // CSP refusals and failed loads are reported once each below.
      if (msg.type() === "error" && !/^(Refused to|Failed to load resource)/.test(text)) note(label, `console error: ${text}`);
    });
    tab.on("pageerror", (err) => note(label, `script error: ${err.message}`));
    tab.on("requestfailed", (req) => {
      const reason = req.failure()?.errorText ?? "failed";
      if (reason !== "csp") note(label, `load failed: ${req.url()} (${reason})`);
    });
    tab.on("response", (response) => {
      if (response.status() >= 400) note(label, `load failed: ${response.url()} (${response.status()})`);
    });

    await tab.goto(pageUrl, { waitUntil: "load" });
    await tab.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await tab.waitForTimeout(400);

    const result = await tab.evaluate((width) => {
      const describe = (el) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        else if (el.classList.length) s += `.${[...el.classList].slice(0, 2).join(".")}`;
        return s;
      };
      const parse = (c) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r, g, b, a };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (x, y) => {
        const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
        return (hi + 0.05) / (lo + 0.05);
      };
      const backgroundOf = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const style = getComputedStyle(n);
          if (style.backgroundImage !== "none") return null;
          const c = parse(style.backgroundColor);
          if (c && c.a > 0.5) return c;
        }
        return matchMedia("(prefers-color-scheme: dark)").matches ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
      };

      const overflow = [];
      if (document.documentElement.scrollWidth > width + 1) {
        for (const el of document.body.querySelectorAll("*")) {
          const rect = el.getBoundingClientRect();
          if (rect.right <= width + 1 || rect.width === 0) continue;
          let clipped = false;
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(n).overflowX)) clipped = true;
          }
          if (!clipped) overflow.push(`${describe(el)} reaches ${Math.round(rect.right)}px`);
          if (overflow.length >= 5) break;
        }
      }

      const faint = [];
      for (const el of document.body.querySelectorAll("*")) {
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || +style.opacity === 0) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const fg = parse(style.color);
        const bg = backgroundOf(el);
        if (!fg || !bg) continue;
        const r = ratio(fg, bg);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && +style.fontWeight >= 700);
        if (r < (large ? 3 : 4.5)) faint.push(`${describe(el)} "${el.textContent.trim().slice(0, 30)}" ${r.toFixed(2)}:1`);
        if (faint.length >= 6) break;
      }

      return {
        overflow,
        faint,
        blocked: window.__blocked,
        background: getComputedStyle(document.body).backgroundColor,
        title: document.title,
      };
    }, view.viewport.width);

    backgrounds[scheme] = result.background;
    for (const o of result.overflow) note(label, `page scrolls sideways: ${o}`);
    for (const f of result.faint) note(label, `hard to read: ${f}`);
    for (const b of result.blocked) note(label, `${b} (not on the claude.ai allowlist)`);
    if (!result.title) note(label, "no <title>");

    const shot = join(outDir, `${stem}-${view.name}-${scheme}.png`);
    await tab.screenshot({ path: shot, fullPage: true });
    shots.push(shot);
    await context.close();
  }
}
await browser.close();
server.close();

if (backgrounds.light === backgrounds.dark) {
  note("all views", `the page looks the same in light and dark (background ${backgrounds.light}); fine only for a deliberate single-look design`);
}

console.log("Screenshots (look at these):");
for (const shot of shots) console.log(`  ${shot}`);
console.log(findings.size ? "Findings:" : "Findings: none");
for (const [message, labels] of findings) {
  const where = labels.length >= views.length * 2 ? "all views" : [...new Set(labels)].join(", ");
  console.log(`  - ${message} [${where}]`);
}
