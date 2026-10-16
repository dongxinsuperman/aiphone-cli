"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { lifecycle } = require("../lib/vm-lifecycle");

const BASES = { android: "/api/internal/vm", ios: "/api/internal/ios-sim", harmony: "/api/internal/harmony-vm" };

async function fixture(platform, options, action) {
  const base = `${BASES[platform]}/instances`, calls = [];
  let machine = Object.hasOwn(options, "machine") ? options.machine : "stopped";
  let raw = options.raw || "error", reads = 0, sequence = 0;
  let operation = options.noOperation ? null : { action: "start", request_id: "old-failure", pending: false, outcome: "failed" };
  const serial = platform === "android" ? "emulator-5554" : platform === "ios" ? "test-udid" : "harmony-vm:vm1";
  const state = () => {
    const online = options.online !== false, mutable = !["starting", "stopping"].includes(machine);
    const actions = {
      start: mutable && online && [null, "stopped"].includes(machine),
      stop: mutable && online && [null, "running"].includes(machine),
      dispatch: mutable && machine !== "running", delete: mutable && machine !== "running",
      edit: mutable, copy: mutable, ...options.actions,
    };
    const view = { state: machine, agent_online: online, actions, notice: machine === null ? "原实例状态无法确认" : "", error: options.error || "上次操作未成功" };
    const data = operation ? { operation } : {};
    return { id: "vm1", alias: "test-vm", assigned_agent_id: "agent1", adb_serial: serial, udid: serial, state: raw,
      ...(platform === "ios" ? { runtime: "iOS-26", runtime_state: data } : { runtime: data }),
      lifecycle: Object.hasOwn(options, "malformed") ? options.malformed : view };
  };
  const advance = () => {
    if (!operation?.pending || --reads > 0) return;
    machine = operation.action === "start" ? "running" : "stopped";
    const failed = operation.action === "stop" && options.failedStop;
    raw = failed ? "error" : machine;
    operation = { ...operation, pending: false, outcome: failed ? "failed" : "succeeded",
      ...(options.replaced ? { request_id: "other-request" } : {}) };
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    calls.push({ method: req.method, path: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    const send = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/devices/statuses") return send((machine === "running" || options.fakeAvailable) ? [{ serial, agent_id: "agent1", status: "online", lock: null, extra: { readiness: { ready: true } } }] : []);
    if (req.url === "/api/devices/available") return send((machine === "running" || options.fakeAvailable) ? [{ serial, platform }] : []);
    if (req.url === base && req.method === "GET") return send([state()]);
    if (req.url === base + "/vm1" && req.method === "GET") { advance(); return send(state()); }
    if (req.url === base + "/vm1" && req.method === "PATCH") return send({ ...state(), alias: calls.at(-1).body.alias });
    if (req.url === base + "/vm1" && req.method === "DELETE") return send({ id: "vm1", deleted: true, cleanup_sent: false });
    if ([base + "/vm1/start", base + "/vm1/stop"].includes(req.url)) {
      const action = req.url.split("/").at(-1);
      machine = action === "start" ? "starting" : "stopping"; raw = machine;
      operation = options.noOperation ? null : { action, request_id: `request-${++sequence}`, pending: true, outcome: "pending" };
      reads = 2;
      return send({ sent: true, instance: state() });
    }
    if (req.url.endsWith("/dispatch-candidates")) return send({ agents: [] });
    return send({ detail: "unexpected route" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const invoke = (args) => new Promise((resolve, reject) => {
    const env = { ...process.env, AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      VM_TEST_PORT: String(server.address().port), AIPHONE_INTERNAL_TOKEN: "local-test-token",
      NODE_OPTIONS: "--require " + path.join(__dirname, "helpers/vm-network-guard.cjs"),
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    for (const key of Object.keys(env)) if (key.toLowerCase().endsWith("_proxy") && key.toLowerCase() !== "no_proxy") delete env[key];
    const child = spawn(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), "vm", platform, ...args], { env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI test timeout")); }, 10000);
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const marker = stderr.split("\n").find((s) => s.startsWith("VM_TEST_GUARD "));
        const guard = marker && JSON.parse(marker.slice("VM_TEST_GUARD ".length));
        assert.equal(guard?.profileReads, 0, stderr); assert.equal(guard?.loopbackOnly, true, stderr);
        resolve({ code, json: JSON.parse(stdout), stderr });
      } catch (err) { reject(err); }
    });
  });
  try { await action({ invoke, calls }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

it("only a missing lifecycle field enables old Server fallback", () => {
  assert.equal(lifecycle({ state: "running" }).source, "legacy");
  for (const value of [null, {}, { state: "running" }]) {
    const view = lifecycle({ state: "running", lifecycle: value });
    assert.equal(view.source, "invalid"); assert.equal(view.state, null); assert.equal(view.actions.start, false);
  }
});

for (const p of Object.keys(BASES)) {
  it(`${p}: list/get/filter/count follow lifecycle without rewriting raw state`, async () => fixture(p, {}, async ({ invoke }) => {
    const listed = await invoke(["list", "--state", "stopped"]);
    assert.equal(listed.code, 0); assert.equal(listed.json.page.total, 1);
    assert.equal(listed.json.items[0].state, "error"); assert.equal(listed.json.items[0].lifecycle_state, "stopped");
    assert.deepEqual(listed.json.counts, { stopped: 1 });
    assert.equal((await invoke(["list", "--state", "error"])).json.page.total, 0);
    const got = await invoke(["get", "vm1"]);
    assert.equal(got.json.lifecycle_error, "上次操作未成功"); assert.equal(got.json.allowed_actions.start, true);
  }));

  it(`${p}: historical failure does not change physical ready/stopped facts`, async () => {
    await fixture(p, { machine: "running" }, async ({ invoke }) => {
      const r = await invoke(["status", "vm1"]);
      assert.equal(r.json.lifecycle_state, "running"); assert.equal(r.json.ready, true); assert.equal(r.json.schedulable, true);
    });
    await fixture(p, {}, async ({ invoke }) => {
      const r = await invoke(["wait", "vm1", "--until", "stopped", "--timeout", "1"]);
      assert.equal(r.code, 0); assert.equal(r.json.lifecycle_state, "stopped"); assert.equal(r.json.lifecycle_error, "上次操作未成功");
    });
  });

  it(`${p}: authoritative unknown never falls back to raw stopped or fake availability`, async () => fixture(p, { machine: null, raw: "stopped", online: false, fakeAvailable: true }, async ({ invoke, calls }) => {
    const status = await invoke(["status", "vm1"]);
    assert.equal(status.json.lifecycle_state, null); assert.equal(status.json.ready, false); assert.equal(status.json.schedulable, false);
    assert.equal((await invoke(["list", "--state", "unknown"])).json.page.total, 1);
    const waited = await invoke(["wait", "vm1", "--until", "stopped", "--timeout", "0.25", "--interval", "1"]);
    assert.equal(waited.code, 1); assert.equal(waited.json.error.code, "wait_timeout");
    for (const command of ["start", "stop", "restart"]) assert.equal((await invoke([command, "vm1"])).code, 1);
    assert.ok(calls.every((c) => c.method === "GET"));
  }));

  it(`${p}: online unknown ordinary start uses the server-allowed action`, async () => fixture(p, { machine: null, raw: "error" }, async ({ invoke, calls }) => {
    const r = await invoke(["start", "vm1", "--wait", "--timeout", "2", "--interval", "0.01"]);
    assert.equal(r.code, 0, JSON.stringify(r.json)); assert.equal(r.json.status.lifecycle_state, "running");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  }));

  it(`${p}: server action restrictions prevent conflicting mutations`, async () => fixture(p, { machine: "starting", raw: "stopped", actions: { start: false, stop: false, dispatch: false, delete: false, edit: false } }, async ({ invoke, calls }) => {
    for (const args of [["start", "vm1"], ["stop", "vm1"], ["dispatch", "vm1"], ["probe", "vm1"], ["delete", "vm1"], ["rename", "vm1", "--alias", "new-name"]]) {
      const r = await invoke(args); assert.equal(r.code, 1); assert.equal(r.json.error.code, "action_not_allowed");
    }
    assert.ok(calls.every((c) => c.method === "GET"));
  }));

  it(`${p}: malformed lifecycle blocks mutations instead of enabling legacy behavior`, async () => fixture(p, { raw: "stopped", malformed: null }, async ({ invoke, calls }) => {
    const query = await invoke(["status", "vm1"]); assert.equal(query.json.lifecycle_state, null); assert.equal(query.json.lifecycle_source, "invalid");
    for (const command of ["start", "delete"]) {
      const r = await invoke([command, "vm1"]); assert.equal(r.code, 1); assert.equal(r.json.error.code, "invalid_lifecycle");
    }
    assert.ok(calls.every((c) => c.method === "GET"));
  }));

  it(`${p}: restart can start a physically stopped guest despite raw historical error`, async () => fixture(p, {}, async ({ invoke, calls }) => {
    const r = await invoke(["restart", "vm1", "--timeout", "2", "--interval", "0.01"]);
    assert.equal(r.code, 0, JSON.stringify(r.json)); assert.equal(r.json.status.lifecycle_state, "running");
    assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.path), [BASES[p] + "/instances/vm1/start"]);
  }));

  it(`${p}: restart still aborts failed/replaced stops even if machine fact is stopped`, async () => {
    for (const options of [{ failedStop: true }, { replaced: true }]) await fixture(p, { machine: "running", ...options }, async ({ invoke, calls }) => {
      const r = await invoke(["restart", "vm1", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(r.code, 1); assert.equal(r.json.error.code, options.failedStop ? "vm_operation_failed" : "operation_replaced");
      assert.ok(!calls.some((c) => c.path.endsWith("/start")));
    });
  });

  it(`${p}: running fact with a raw historical error restarts the same instance normally`, async () => fixture(p, { machine: "running" }, async ({ invoke, calls }) => {
    const r = await invoke(["restart", "vm1", "--timeout", "2", "--interval", "0.01"]);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.status.instance.id, "vm1");
    assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.path), [BASES[p] + "/instances/vm1/stop", BASES[p] + "/instances/vm1/start"]);
    assert.ok(calls.every((c) => c.method !== "DELETE"));
  }));

  it(`${p}: delete follows allowed lifecycle facts, not raw active/error labels`, async () => {
    await fixture(p, { machine: "running", raw: "error" }, async ({ invoke, calls }) => {
      const r = await invoke(["delete", "vm1"]); assert.equal(r.json.error.code, "action_not_allowed"); assert.ok(calls.every((c) => c.method === "GET"));
    });
    await fixture(p, { raw: "running" }, async ({ invoke, calls }) => {
      const r = await invoke(["delete", "vm1"]); assert.equal(r.code, 0); assert.equal(r.json.host_cleanup_confirmed, false);
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
    });
  });

  it(`${p}: explicit idempotent stop remains compatible with the backend exception`, async () => fixture(p, {}, async ({ invoke }) => {
    const r = await invoke(["stop", "vm1", "--wait", "--timeout", "2", "--interval", "0.01"]);
    assert.equal(r.code, 0, JSON.stringify(r.json)); assert.equal(r.json.status.lifecycle_state, "stopped");
  }));

  it(`${p}: new lifecycle without an operation ID cannot confirm a command`, async () => fixture(p, { noOperation: true }, async ({ invoke }) => {
    const r = await invoke(["start", "vm1", "--wait", "--timeout", "1"]);
    assert.equal(r.code, 1); assert.equal(r.json.error.code, "operation_unconfirmed");
  }));
}
