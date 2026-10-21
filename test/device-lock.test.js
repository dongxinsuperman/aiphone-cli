"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function fixture(action) {
  const calls = []; let lock; let failHeartbeat = false, failRelease = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    calls.push({ method: req.method, path: req.url, body });
    const send = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (lock && Date.now() - lock.updated > lock.ttl_seconds * 1000) lock = undefined;
    if (req.url === "/api/devices/available") return send(lock ? [] : [{ serial: "usb:/1" }]);
    if (req.url === "/api/devices/statuses") return send([{ serial: "usb:/1", lock: lock || null }]);
    if (req.method === "DELETE") {
      if (failRelease) return send({ detail: "release failed" }, 503);
      if (!lock) return send({ released: false });
      if (body.token !== lock.token) return send({ detail: "bad token" }, 403);
      lock = undefined; return send({ released: true });
    }
    if (req.url.endsWith("/heartbeat")) {
      if (failHeartbeat === "hang") return;
      if (failHeartbeat) return send({ detail: "renew failed" }, 503);
      if (!lock) return send({ detail: "expired" }, 404);
      if (body.token !== lock.token) return send({ detail: "bad token" }, 403);
      lock.updated = Date.now(); return send(lock);
    }
    if (lock && lock.holder !== body.holder) return send({ detail: "occupied" }, 409);
    lock = lock ? { ...lock, updated: Date.now() } : { ...body, token: "owned-token", updated: Date.now() };
    return send(lock, 201);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const start = args => {
    const proc = spawn(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), "devices", ...args], { env: { ...process.env, AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}` } });
    let stdout = "", stderr = ""; const events = [];
    proc.stdout.on("data", data => { stdout += data; for (const line of String(data).split("\n")) { try { events.push(JSON.parse(line)); } catch {} } });
    proc.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
    const done = new Promise(resolve => proc.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }));
    return { proc, done, events };
  };
  const run = args => start(args).done;
  const waitEvent = async (child, name) => {
    const end = Date.now() + 8000;
    while (!child.events.some(e => e.event === name)) { assert.ok(Date.now() < end, `missing ${name}`); await new Promise(r => setTimeout(r, 20)); }
  };
  try { await action({ calls, run, start, waitEvent, setFailure: (heartbeat, release = false) => { failHeartbeat = heartbeat; failRelease = release; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const acquire = (...args) => ["lock", "usb:/1", "--holder", "agent-A", ...args];

it("lock/heartbeat/unlock preserve API contracts, conflicts, identity and query availability", async () => fixture(async ({ calls, run }) => {
  let result = await run(acquire()); assert.equal(result.code, 0); const token = JSON.parse(result.stdout).token;
  assert.deepEqual(calls[0], { method: "POST", path: "/api/devices/usb%3A%2F1/lock", body: { holder: "agent-A", holder_type: "session", ttl_seconds: 120 } });
  assert.equal(JSON.parse((await run(["statuses"])).stdout)[0].lock.holder, "agent-A");
  assert.deepEqual(JSON.parse((await run(["available"])).stdout), []);
  result = await run(["lock", "usb:/1", "--holder", "agent-B"]); assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).error.status, 409);
  result = await run(acquire("--ttl", "3")); assert.equal(JSON.parse(result.stdout).token, token); assert.equal(JSON.parse(result.stdout).ttl_seconds, 120);
  result = await run(["heartbeat", "usb:/1", "--token", "bad"]); assert.equal(JSON.parse(result.stdout).error.status, 403);
  result = await run(["heartbeat", "usb:/1", "--token", token]); assert.equal(result.code, 0);
  result = await run(["unlock", "usb:/1", "--token", "bad"]); assert.equal(result.code, 1);
  result = await run(["unlock", "usb:/1", "--token", token]); assert.equal(JSON.parse(result.stdout).released, true);
  assert.deepEqual(calls.at(-1).body, { token, force: false });
  assert.equal(JSON.parse((await run(["available"])).stdout).length, 1);
  const before = calls.length;
  for (const args of [["lock", "usb:/1"], acquire("--holder", " "), acquire("--ttl", "2"), acquire("--ttl", "301"), acquire("--holder-type", "invalid"), ["unlock", "usb:/1", "--token", token, "--force"], ["heartbeat", "usb:/1"], ["session", "usb:/1", "--holder", "A", "--ttl", "3", "--interval", "5"]]) assert.notEqual((await run(args)).code, 0);
  assert.equal(calls.length, before);
}));

it("session renews past initial TTL and SIGINT releases without starting any device/task", async () => fixture(async ({ calls, start, run, waitEvent }) => {
  const child = start(["session", "usb:/1", "--holder", "A", "--ttl", "3", "--interval", "0.5"]);
  await waitEvent(child, "acquired"); await new Promise(r => setTimeout(r, 3400));
  assert.equal(JSON.parse((await run(["available"])).stdout).length, 0);
  assert.ok(child.events.filter(e => e.event === "renewed").length >= 3);
  child.proc.kill("SIGINT"); const result = await child.done; assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(child.events.some(e => e.event === "released" && e.released && !e.holds_lock));
  assert.equal(JSON.parse((await run(["available"])).stdout).length, 1);
  assert.ok(calls.every(c => /\/(lock|heartbeat|available)$/.test(c.path)));
}));

it("renewal failure terminates nonzero, never reacquires, and attempts token-only cleanup", async () => fixture(async ({ calls, start, waitEvent, setFailure }) => {
  const child = start(["session", "usb:/1", "--holder", "A", "--interval", "0.2"]);
  await waitEvent(child, "acquired"); setFailure(true, true);
  const result = await child.done; assert.equal(result.code, 1);
  assert.ok(child.events.some(e => e.event === "lost" && e.holds_lock === false));
  assert.ok(child.events.some(e => e.event === "release_failed"));
  assert.equal(calls.filter(c => c.method === "POST" && c.path.endsWith("/lock")).length, 1);
  assert.equal(calls.filter(c => c.path.endsWith("/heartbeat")).length, 1);
  assert.deepEqual(calls.at(-1).body, { token: "owned-token", force: false });
}));

it("abrupt session death leaves TTL expiry; SIGTERM releases a session", async () => fixture(async ({ start, run, waitEvent }) => {
  let child = start(["session", "usb:/1", "--holder", "A", "--ttl", "3", "--interval", "0.5"]);
  await waitEvent(child, "acquired"); child.proc.kill("SIGKILL"); await child.done;
  await new Promise(r => setTimeout(r, 3100));
  assert.equal(JSON.parse((await run(["available"])).stdout).length, 1);
  child = start(["session", "usb:/1", "--holder", "A"]);
  await waitEvent(child, "acquired"); child.proc.kill("SIGTERM"); assert.equal((await child.done).code, 0);
  assert.ok(child.events.some(e => e.event === "released"));
}));

it("session conflict exits immediately and does not release another holder's lock", async () => fixture(async ({ calls, run }) => {
  await run(acquire()); const before = calls.length;
  const result = await run(["session", "usb:/1", "--holder", "B"]);
  assert.equal(result.code, 1); const event = JSON.parse(result.stdout);
  assert.equal(event.event, "acquire_failed"); assert.equal(event.error.status, 409);
  assert.equal(calls.length, before + 1);
}));

it("session honors inherited TTL instead of reporting an unsafe renewal cadence", async () => fixture(async ({ calls, run }) => {
  await run(acquire("--ttl", "3"));
  const result = await run(["session", "usb:/1", "--holder", "agent-A"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /服务端沿用的 TTL/);
  assert.equal(calls.filter(c => c.path.endsWith("/heartbeat")).length, 0);
  assert.deepEqual(calls.at(-1).body, { token: "owned-token", force: false });
}));

 it("a stalled heartbeat times out and terminates instead of claiming continued ownership", async () => fixture(async ({ calls, start, waitEvent, setFailure }) => {
  const child = start(["session", "usb:/1", "--holder", "A", "--ttl", "3", "--interval", "0.1"]);
  await waitEvent(child, "acquired"); setFailure("hang");
  const result = await child.done;
  assert.equal(result.code, 1);
  assert.ok(child.events.some(e => e.event === "lost" && !e.holds_lock));
  assert.equal(calls.filter(c => c.path.endsWith("/heartbeat")).length, 1);
  assert.ok(child.events.some(e => e.event === "released"));
}));
