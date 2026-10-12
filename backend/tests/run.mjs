/**
 * Test runner: boots a throwaway server, runs every `*.test.mjs` in this folder
 * against it, then shuts the server down and exits non-zero on any failure.
 *
 * Usage: npm test            (from backend/)
 *        PORT=6001 npm test  (use a specific port)
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
// Default 5051. Note: WHATWG fetch refuses to connect to a blocklist of ports
// (SIP 5060-5069, 6000, 6667, ...), so the test port must avoid that range.
const port = process.env.PORT || "5051";
const API = `http://localhost:${port}/api/v1`;
const WS_BASE = `ws://localhost:${port}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A hung suite is indistinguishable from a slow one, so give each a ceiling. It
// is generous enough for the Google and WebSocket suites and short enough that a
// deadlock is reported rather than waited on.
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS || 8 * 60 * 1000);

/** Poll the health endpoint until the server is accepting requests. */
async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `Server exited with code ${server.exitCode} during startup.\n${serverLog.slice(-4000)}`
      );
    }
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

const server = spawn(process.execPath, ["index.js"], {
  cwd: backendRoot,
  env: {
    ...process.env,
    PORT: port,
    // The suite registers a dozen throwaway accounts from one IP, which would
    // otherwise trip the production register/login limits.
    RATE_LIMIT_REGISTER: "200",
    RATE_LIMIT_LOGIN: "200",
    // The Google suite drives several complete OAuth flows, plus repeated Drive
    // reads, from one address.
    RATE_LIMIT_GOOGLE_SIGNIN: "500",
    RATE_LIMIT_GOOGLE_CONNECT: "500",
    RATE_LIMIT_GOOGLE_DRIVE: "500",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
// Keep the tail: a crash prints a stack trace, not a log of everything before it.
const rememberServerOutput = (d) => {
  serverLog = (serverLog + d.toString()).slice(-20000);
};
server.stdout.on("data", rememberServerOutput);
server.stderr.on("data", rememberServerOutput);

let serverDied = null;
server.on("exit", (code, signal) => {
  serverDied = `server exited during the run (code ${code}, signal ${signal})`;
});

const stop = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

let failed = false;
try {
  if (!(await waitForHealth())) {
    console.error("Server did not become healthy in time. Output:\n" + serverLog);
    process.exit(1);
  }
  console.log(`Server healthy on port ${port}.\n`);

  const all = (await readdir(here)).filter((f) => f.endsWith(".test.mjs")).sort();
  // `TEST_FILTER=google npm test` runs a subset, which keeps the edit/run loop
  // short while a single change is in flight. The full suite is still the
  // default.
  const filter = process.env.TEST_FILTER;
  const files = filter
    ? all.filter((f) => f.includes(filter))
    : all;
  if (!files.length) {
    console.error(`No test files match TEST_FILTER="${filter}". Available: ${all.join(", ")}`);
    process.exit(1);
  }
  if (filter) console.log(`Filtered to: ${files.join(", ")}\n`);

  for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const started = Date.now();
    const outcome = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(here, file)], {
        cwd: backendRoot,
        env: { ...process.env, API, WS_BASE },
        stdio: "inherit",
      });
      // A suite whose server has died would otherwise wait on a connection that
      // is never answered, so the death is treated as the end of the suite.
      const onServerExit = () => resolve({ code: 1, reason: serverDied || "the server died" });
      server.once("exit", onServerExit);

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({
          code: 1,
          reason: `no result after ${Math.round(SUITE_TIMEOUT_MS / 1000)}s, so it was killed`,
        });
      }, SUITE_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        server.off("exit", onServerExit);
        console.error(`could not start ${file}: ${err.message}`);
        resolve({ code: 1 });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        server.off("exit", onServerExit);
        resolve({ code: code ?? 1 });
      });
    });

    if (outcome.reason) {
      // The server's own output is the only evidence of why it died, and it is
      // buffered rather than inherited precisely so it can be printed here.
      console.error(`\n${file}: ${outcome.reason}`);
      if (serverLog) console.error(`Server output:\n${serverLog.slice(-4000)}`);
      console.error(
        "Re-run this suite on its own to see it directly:\n" +
          `  TEST_FILTER=${file.replace(".test.mjs", "")} npm test\n`
      );
      failed = true;
      break;
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (outcome.code !== 0) {
      console.log(`${file} exited with code ${outcome.code} after ${secs}s`);
      failed = true;
    } else {
      console.log(`${file} passed in ${secs}s`);
    }
  }
} catch (err) {
  console.error(err.message || err);
  failed = true;
} finally {
  stop();
}

if (failed) {
  console.log("\nSome test files reported failures.");
  process.exit(1);
}
console.log("\nAll test files passed.");
process.exit(0);
