/**
 * Cache semantics (master plan section 49: performance).
 *
 * Verifies:
 *  - getOrSet miss -> loads, hit -> returns same value
 *  - concurrent getOrSet coalesces to one loader call
 *  - TTL expiry allows a re-load
 *  - cacheDel and cacheDelPrefix remove entries
 *  - An HTTP write makes a previously cached list return the new item on next read
 *
 * These are purely in-process tests (memory fallback) so they do not require
 * Redis. That matches the suite's "no external dependencies" default.
 */
const API = process.env.API || "http://localhost:5051/api/v1";

import {
  cacheReset,
  cacheKey,
  getOrSet,
  cacheDel,
  cacheDelPrefix,
  cacheStatus,
} from "../services/cache.service.js";

let failures = 0;

function ok(label, extra = "") {
  console.log(`  PASS  ${label}${extra ? ` -> ${extra}` : ""}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label} -> ${detail}`);
}
function check(label, condition, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function makeUser(tag) {
  const stamp = `${tag}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
  const email = `${stamp}@test.local`;
  const res = await call("/auth/register", {
    method: "POST",
    body: { name: tag, email, password: "Str0ngPass!" },
  });
  if (res.status !== 201) throw new Error(`could not create ${tag}: ${JSON.stringify(res.body)}`);
  return {
    email: res.body.user.email.toLowerCase(),
    token: res.body.token,
    id: res.body.user.id,
  };
}

async function main() {
  section("Cache status shape");
  const status = cacheStatus();
  check("status is an object", typeof status === "object" && status !== null);
  check("status has mode/connected", "mode" in status && "connected" in status);

  section("getOrSet: miss then hit");
  cacheReset();
  const key = cacheKey("test", "basic");
  let calls = 0;
  const v1 = await getOrSet(key, 5, async () => {
    calls += 1;
    return { n: 1, ts: Date.now() };
  });
  const v2 = await getOrSet(key, 5, async () => {
    calls += 1;
    return { n: 2, ts: Date.now() };
  });
  check("first load ran loader", calls === 1);
  check("second returned cached value", v1.n === v2.n && v1.ts === v2.ts);

  section("getOrSet: concurrent coalescing");
  cacheReset();
  const key2 = cacheKey("test", "concurrent");
  let loaderCalls = 0;
  const tasks = Array.from({ length: 5 }, () =>
    getOrSet(key2, 10, async () => {
      loaderCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { id: loaderCalls };
    })
  );
  const results = await Promise.all(tasks);
  check("exactly one loader invocation", loaderCalls === 1);
  results.forEach((r) => check("all got same cached instance", r.id === 1));

  section("TTL expiry reloads");
  cacheReset();
  const key3 = cacheKey("test", "ttl");
  let c3 = 0;
  const a = await getOrSet(key3, 1, async () => ({ v: ++c3 })); // ttl 1s
  await new Promise((r) => setTimeout(r, 1100));
  const b = await getOrSet(key3, 1, async () => ({ v: ++c3 }));
  check("value changed after expiry", a.v === 1 && b.v === 2);
  check("loader ran again", c3 === 2);

  section("cacheDel and cacheDelPrefix");
  cacheReset();
  const kA = cacheKey("docs", "user", "1", "a");
  const kB = cacheKey("docs", "user", "1", "b");
  const kC = cacheKey("docs", "user", "2", "a");
  await getOrSet(kA, 30, () => ({ x: "a" }));
  await getOrSet(kB, 30, () => ({ x: "b" }));
  await getOrSet(kC, 30, () => ({ x: "c" }));
  await cacheDel(kA);
  check("del removed one key", (await getOrSet(kA, 30, () => "miss")) === "miss");
  check("others still cached", (await getOrSet(kB, 30, () => "miss")).x === "b");

  let kbCalls = 0;
  await cacheDelPrefix(cacheKey("docs", "user", "1"));
  check("prefix del cleared 1's keys", (await getOrSet(kB, 30, () => ({ y: ++kbCalls }))).y === 1);
  check("other user key untouched", (await getOrSet(kC, 30, () => "miss")).x === "c");

  section("HTTP roundtrip: write is visible on next cached list read");
  const owner = await makeUser("CacheTest");
  // Create a document. This should invalidate dashboard list caches (dashboard=documents).
  const d1 = await call("/documents", {
    method: "POST",
    token: owner.token,
    body: { title: "Cache Doc A" },
  });
  check("created doc", d1.status === 201, `status ${d1.status}`);

  // Read list twice quickly - second may hit cache (both should include A). We cannot
  // directly inspect cache mode across processes, but the data must be present.
  const list1 = await call("/documents", { token: owner.token });
  check("list1 includes A", Array.isArray(list1.body) && list1.body.some((x) => x.title === "Cache Doc A"));

  // Create another document (should invalidate list caches).
  const d2 = await call("/documents", {
    method: "POST",
    token: owner.token,
    body: { title: "Cache Doc B" },
  });
  check("created doc B", d2.status === 201, `status ${d2.status}`);

  const list2 = await call("/documents", { token: owner.token });
  check(
    "list2 includes B after write",
    Array.isArray(list2.body) && list2.body.some((x) => x.title === "Cache Doc B"),
    list2.body?.length
  );
}

main().catch((err) => {
  bad("test body ran to completion", err?.message || String(err));
}).finally(() => {
  console.log(failures ? `\n${failures} CACHE CHECK(S) FAILED` : "\nALL CACHE CHECKS PASSED");
  process.exit(failures ? 1 : 0);
});
