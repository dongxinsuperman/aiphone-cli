"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

async function fixture(action) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiphone-app-cli-"));
  const calls = [];
  const state = { mode: "success", gets: 0, failGet: false, immediate: false, serials: ["device:1"] };
  const packageBytes = Buffer.from([0, 255, 13, 10, 100, 99, 11]);
  const task = (done) => ({ id: "task/1", package_id: "pkg/1", state: done ? "done" : "running",
    items: state.serials.map((serial) => ({ serial, state: done ? state.mode : "running" })),
    summary: { total: state.serials.length, success: done && state.mode === "success" ? state.serials.length : 0 } });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ path: req.url, method: req.method, headers: req.headers, body });
    const send = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/app-install/packages" && req.method === "GET") return send([{ id: "pkg/1", platform: "android" }]);
    if (req.url === "/api/app-install/packages" && req.method === "POST") return send({ id: "uploaded", platform: "android" }, 201);
    if (req.url === "/api/app-install/packages/pkg%2F1/download") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(packageBytes); }
    if (req.url === "/api/app-install/packages/pkg%2F1/eligible-devices") return send([{ serial: "device:1", alias: "test", platform: "android" }]);
    if (req.url === "/api/app-install/tasks" && req.method === "POST") { state.gets = 0; state.serials = JSON.parse(body).serials; return send(task(state.immediate), 201); }
    if (req.url === "/api/app-install/tasks/task%2F1/retry-unsuccessful" && req.method === "POST") { state.gets = 0; return send(task(false)); }
    if (req.url === "/api/app-install/tasks/task%2F1") {
      if (state.failGet) return send({ detail: "query unavailable" }, 503);
      return send(task(state.mode !== "running" && ++state.gets >= 2));
    }
    return send({ detail: "package not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const invoke = (args) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), "apps", ...args], {
      env: { ...process.env, AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("CLI timed out")); }, 10000);
    proc.stdout.on("data", (b) => { stdout += b; });
    proc.stderr.on("data", (b) => { stderr += b; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(stdout); } catch { /* Help output */ }
      resolve({ code, stdout, stderr, json });
    });
    proc.stdin.end();
  });
  try { await action({ dir, invoke, calls, state, packageBytes }); }
  finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
}

it("package list, eligibility and multipart upload match the existing API", async () => fixture(async ({ dir, invoke, calls, packageBytes }) => {
  const listed = await invoke(["packages", "list"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.json[0].id, "pkg/1");
  const eligible = await invoke(["packages", "eligible", "pkg/1"]);
  assert.equal(eligible.json[0].serial, "device:1");
  const file = path.join(dir, "sample.apk");
  await fs.writeFile(file, packageBytes);
  const uploaded = await invoke(["packages", "upload", file]);
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.equal(uploaded.json.id, "uploaded");
  const call = calls.at(-1);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/app-install/packages");
  assert.match(call.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.equal(Number(call.headers["content-length"]), call.body.length);
  assert.ok(call.body.includes(Buffer.from('name="file"; filename="sample.apk"')));
  const start = call.body.indexOf(Buffer.from("\r\n\r\n")) + 4;
  assert.deepEqual(call.body.subarray(start, start + packageBytes.length), packageBytes);
  assert.ok(!calls.some((c) => c.path === "/api/app-install/tasks"));
}));

it("download preserves bytes, refuses overwrite and removes incomplete local files on HTTP errors", async () => fixture(async ({ dir, invoke, calls, packageBytes }) => {
  const output = path.join(dir, "download.apk");
  const downloaded = await invoke(["packages", "download", "pkg/1", "-o", output]);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.equal(downloaded.json.bytes, packageBytes.length);
  assert.deepEqual(await fs.readFile(output), packageBytes);
  const count = calls.length;
  const again = await invoke(["packages", "download", "pkg/1", "-o", output]);
  assert.equal(again.code, 1);
  assert.equal(calls.length, count);
  assert.deepEqual(await fs.readFile(output), packageBytes);
  const badOutput = path.join(dir, "missing.apk");
  const missing = await invoke(["packages", "download", "missing", "-o", badOutput]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /package not found/);
  await assert.rejects(fs.stat(badOutput), { code: "ENOENT" });
}));

it("install uses exact serials and wait only queries until every item succeeds", async () => fixture(async ({ invoke, calls }) => {
  const result = await invoke(["install", "pkg/1", "--serial", "device:1", "device:2", "device:1", "--wait", "--interval", "0.01", "--timeout", "2"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.state, "done");
  assert.equal(result.json.items.length, 2);
  const writes = calls.filter((c) => c.method === "POST");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].body), { package_id: "pkg/1", serials: ["device:1", "device:2"] });
  assert.ok(calls.filter((c) => c.method === "GET").every((c) => c.path === "/api/app-install/tasks/task%2F1"));
}));

it("done with failed/timeout/unknown items is not reported as a successful install", async () => fixture(async ({ invoke, state }) => {
  for (const mode of ["failed", "timeout", "unknown"]) {
    state.mode = mode; state.gets = 0;
    const result = await invoke(["tasks", "wait", "task/1", "--interval", "0.01", "--timeout", "2"]);
    assert.equal(result.code, 1, mode);
    assert.equal(result.json.state, "done");
    assert.equal(result.json.items[0].state, mode);
  }
  state.immediate = true;
  const acceptedButFailed = await invoke(["install", "pkg/1", "--serial", "device:1"]);
  assert.equal(acceptedButFailed.code, 1);
}));

it("retry is explicit, task get is raw and query failure preserves accepted task ID", async () => fixture(async ({ invoke, calls, state }) => {
  const raw = await invoke(["tasks", "get", "task/1"]);
  assert.equal(raw.code, 0);
  const retried = await invoke(["tasks", "retry", "task/1", "--wait", "--interval", "0.01", "--timeout", "2"]);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(calls.find((c) => c.method === "POST").path, "/api/app-install/tasks/task%2F1/retry-unsuccessful");
  state.failGet = true;
  const failed = await invoke(["install", "pkg/1", "--serial", "device:1", "--wait"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.json.id, "task/1");
  assert.match(failed.stderr, /query unavailable/);
}));

it("timeouts do not cancel or retry installation, invalid input never reaches API", async () => fixture(async ({ invoke, calls, state, dir }) => {
  state.mode = "running";
  const timeout = await invoke(["tasks", "wait", "task/1", "--timeout", "0.08", "--interval", "0.01"]);
  assert.equal(timeout.code, 1);
  assert.equal(timeout.json.id, "task/1");
  assert.match(timeout.stderr, /超时/);
  assert.ok(calls.every((c) => c.method === "GET"));
  calls.length = 0;
  for (const args of [
    ["install", "pkg/1"], ["install", "pkg/1", "--serial", "   "],
    ["tasks", "wait", "task/1", "--timeout", "0"],
    ["packages", "upload", path.join(dir, "absent.apk")], ["packages", "upload", dir],
    ["packages", "download", "pkg/1"],
  ]) assert.equal((await invoke(args)).code, 1);
  assert.equal(calls.length, 0);
}));
