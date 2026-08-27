// A small Chrome DevTools Protocol harness — enough to serve the built app, drive it in headless
// Chromium, and read its own numbers back out. Shared by `browser-smoke.mjs` (does it work?) and
// `measure.mjs` (what does it cost?).
//
// Deliberately dependency-free: Node 22 has `fetch` and `WebSocket` built in, and the repo does
// not otherwise carry a browser-automation dependency. `packages/wasm/test/browser-smoke.mjs`
// takes the same approach for the same reason.

import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = join(here, "../dist");

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".html": "text/html; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
};

/** Find a Chrome/Chromium binary, or null. `CHROME_BIN` wins. */
export async function locateChromium() {
  const fixed = [
    process.env.CHROME_BIN,
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of fixed) {
    if (await exists(c)) return c;
  }
  // The playwright layout nests the binary under a versioned directory.
  try {
    for (const entry of await readdir("/opt/pw-browsers")) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome"]) {
        const p = join("/opt/pw-browsers", entry, rel);
        if (await exists(p)) return p;
      }
    }
  } catch {
    /* no such directory */
  }
  return null;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Serve `root` on an ephemeral port, with `application/wasm` so `instantiateStreaming` works. */
export async function serve(root) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => server.close() };
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    /** Console output and uncaught exceptions. A browser failure whose console the harness threw
     *  away is a failure you have to reproduce by hand. */
    this.log = [];
    /** The page's CURRENT execution context. `Page.navigate` destroys the old one, and an
     *  `Runtime.evaluate` with no `contextId` can still land in it — where the promise it creates
     *  is never settled and the caller times out against a page that in fact loaded fine. */
    this.contextId = null;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.method) {
        case "Runtime.executionContextCreated":
          if (msg.params.context.auxData?.isDefault !== false) this.contextId = msg.params.context.id;
          return;
        case "Runtime.executionContextsCleared":
          this.contextId = null;
          return;
        case "Runtime.executionContextDestroyed":
          if (msg.params.executionContextId === this.contextId) this.contextId = null;
          return;
        case "Runtime.consoleAPICalled":
          this.log.push(
            `[console.${msg.params.type}] ${(msg.params.args ?? [])
              .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
              .join(" ")}`,
          );
          return;
        case "Runtime.exceptionThrown": {
          const d = msg.params.exceptionDetails;
          this.log.push(`[uncaught] ${d.exception?.description ?? d.text}`);
          return;
        }
        default:
          break;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Evaluate an expression (awaiting it if it yields a promise) in the page's live context. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(this.contextId === null ? {} : { contextId: this.contextId }),
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** Navigate, and wait until a fresh default execution context exists for the new document. */
  async navigate(url, timeoutMs = 20_000) {
    const before = this.contextId;
    const settled = new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.contextId !== null && this.contextId !== before) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, timeoutMs);
    });
    await this.send("Page.navigate", { url });
    await settled;
  }

  /** Poll `expression` until it is truthy, or give up. */
  async waitFor(expression, timeoutMs, everyMs = 200) {
    return this.eval(`
      new Promise((resolve) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          let ok = false;
          try { ok = !!(${expression}); } catch { ok = false; }
          if (ok) { clearInterval(poll); resolve(true); }
          else if (Date.now() - t0 > ${timeoutMs}) { clearInterval(poll); resolve(false); }
        }, ${everyMs});
      })
    `);
  }

  close() {
    this.ws.close();
  }
}

/** Launch headless Chromium and attach to its page target. Returns `{ cdp, stop }`. */
export async function launch(chromium, { width = 1600, height = 1000 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "rindle-scale-demo-"));
  const chrome = spawn(
    chromium,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chrome did not report a devtools port in 30 s")), 30_000);
    const poll = setInterval(async () => {
      try {
        const p = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
        if (Number.isFinite(p) && p > 0) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(p);
        }
      } catch {
        /* not written yet */
      }
    }, 100);
    chrome.on("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`chrome exited early (${code})`));
    });
  });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp connect failed")), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  return {
    cdp,
    async stop() {
      cdp.close();
      chrome.kill("SIGKILL");
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}
