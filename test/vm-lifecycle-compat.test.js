"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BASES = { android: "/api/internal/vm", ios: "/api/internal/ios-sim", harmony: "/api/internal/harmony-vm" };

async function fixture(platform, options, action) {
  const base = BASES[platform] + "/instances";
  const calls = [];
  const runtimeFields = data => platform === "ios"
    ? { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", runtime_state: data }
    : { runtime: data };
  const operation = (kind, outcome, requestId = kind + "-attempt") => options.legacy ? {} : {
    operation: { action: kind, request_id: requestId, pending: outcome === "pending", outcome,
      ...(outcome === "failed" ? { failure_reason: "operation_timeout" } : {}) },
  };
  let vm = { id: "old-vm", alias: "personal-test", state: options.initialState || "running",
    assigned_agent_id: "old-agent", adb_serial: "emulator-5666", udid: "mock-ios-udid", ...runtimeFields({}) };
  let pendingReads = 0;
  let startCount = 0;
  const serial = () => platform === "harmony" ? "harmony-vm:" + vm.id : platform === "ios" ? vm.udid : vm.adb_serial;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: req.method, route });
    const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (route === "/api/devices/statuses") return send(vm?.state === "running" ? [{ serial: serial(), platform,
      agent_id: vm.assigned_agent_id, status: "online", lock: null, extra: { readiness: { ready: true } } }] : []);
    if (route === "/api/devices/available") return send(vm?.state === "running" ? [{ serial: serial(), platform }] : []);
    if (route === BASES.ios + "/catalog") return send({
      device_types: [{ identifier: "type.iphone17", name: "iPhone 17", product_family: "iPhone", min_runtime_version: 1703936 }],
      official_runtimes: [{ identifier: "runtime.ios26", name: "iOS 26.0", version: "26.0" }],
    });
    if (route === base && req.method === "GET") return send(vm ? [vm] : []);
    if (route === base && req.method === "POST") {
      vm = { ...body, id: "created-vm", state: "draft", assigned_agent_id: null,
        ...(platform === "ios" ? { runtime_state: {} } : { runtime: {} }) };
      return send(vm, 201);
    }
    if (!route.startsWith(base + "/")) return send({ detail: "Unexpected test route" }, 404);
    const [id, command] = route.slice(base.length + 1).split("/");
    if (!vm || id !== vm.id) return send({ detail: "retired instance" }, 404);
    if (!command && req.method === "GET") {
      if (pendingReads > 0 && --pendingReads === 0) Object.assign(vm, runtimeFields(operation("start", "succeeded")));
      return send(vm);
    }
    if (!command && req.method === "DELETE") {
      vm = null;
      return send({ id, deleted: true, cleanup_sent: false, avd_cleanup_sent: false });
    }
    if (command === "dispatch-candidates") return send({ agents: [{ agent_id: "new-agent", ok: true }] });
    if (command === "dispatch") {
      const failed = options.switchFailed || options.sentFalse;
      const switched = Boolean(vm.assigned_agent_id && vm.assigned_agent_id !== "new-agent");
      const oldId = vm.id;
      vm = { ...vm, id: switched ? "new-vm" : vm.id, state: failed ? "error" : "running",
        assigned_agent_id: failed ? null : "new-agent",
        ...runtimeFields(operation("start", failed ? "failed" : "succeeded")) };
      const response = { sent: !failed, switched, ...(switched ? { old_vm_id: oldId, old_cleanup_sent: false } : {}), instance: failed ? vm : {
        ...vm, state: "starting", assigned_agent_id: null, ...runtimeFields(operation("start", "pending")),
      } };
      if (options.httpError) return send({ detail: { ...response, vm_id: vm.id,
        request_id: "start-attempt", message: "新实例启动下发失败" } }, options.httpError);
      return send(response);
    }
    if (command === "stop") {
      if (options.sentFalse || options.legacyNoop || options.httpError) {
        vm = { ...vm, state: options.legacyNoop ? "stopped" : "error",
          ...runtimeFields(options.legacyNoop ? {} : operation("stop", "failed")) };
        const response = { sent: false, instance: vm };
        return options.httpError ? send({ detail: { ...response, vm_id: id,
          request_id: "stop-attempt", message: "停止下发失败" } }, options.httpError) : send(response);
      }
      vm = { ...vm, state: "stopped", ...runtimeFields(operation("stop",
        options.stopFailedOutcome ? "failed" : "succeeded", options.replacedOperation ? "another-stop" : "stop-attempt")) };
      return send({ sent: true, instance: { ...vm, state: "stopping", ...runtimeFields(operation("stop", "pending")) } });
    }
    if (command === "start") {
      startCount += 1;
      if (options.sentFalse || options.httpError) {
        vm = { ...vm, state: "error", ...runtimeFields(operation("start", "failed")) };
        const response = { sent: false, instance: vm };
        return options.httpError ? send({ detail: { ...response, vm_id: id,
          request_id: "start-attempt", message: "启动下发失败" } }, options.httpError) : send(response);
      }
      pendingReads = options.pendingReady ? 2 : 0;
      vm = { ...vm, state: "running", ...runtimeFields(operation("start", pendingReads ? "pending" : "succeeded")) };
      return send({ sent: true, instance: { ...vm, state: "starting", ...runtimeFields(operation("start", "pending")) } });
    }
    return send({ detail: "Unexpected test operation" }, 404);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const invoke = args => new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase().endsWith("_proxy")) delete env[key];
    Object.assign(env, { AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      AIPHONE_INTERNAL_TOKEN: "personal-local-test", VM_TEST_PORT: String(server.address().port),
      NODE_OPTIONS: "--require " + path.join(__dirname, "helpers/vm-network-guard.cjs"),
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
    const child = spawn(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), "vm", platform, ...args], { env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("test CLI timeout")); }, 10000);
    child.stdout.on("data", b => stdout += b);
    child.stderr.on("data", b => stderr += b);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      try {
        const line = stderr.split("\n").find(value => value.startsWith("VM_TEST_GUARD "));
        const guard = line && JSON.parse(line.slice("VM_TEST_GUARD ".length));
        assert.equal(guard?.profileReads, 0, stderr);
        assert.equal(guard?.loopbackOnly, true, stderr);
        resolve({ code, json: JSON.parse(stdout), stdout, stderr });
      } catch (err) { reject(err); }
    });
  });
  try { await action({ invoke, calls, startCount: () => startCount }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

for (const platform of Object.keys(BASES)) {
  it(`${platform}: failed stop outcome prevents restart even when physical state is stopped`, async () => fixture(platform,
    { stopFailedOutcome: true }, async ({ invoke, startCount }) => {
      const result = await invoke(["restart", "old-vm", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(result.code, 1);
      assert.equal(result.json.error.code, "vm_operation_failed");
      assert.equal(result.json.error.phase, "stop");
      assert.equal(result.json.error.request_id, "stop-attempt");
      assert.equal(startCount(), 0);
    }));

  it(`${platform}: stop --wait reports the command failure, not a late stopped fact`, async () => fixture(platform,
    { stopFailedOutcome: true }, async ({ invoke }) => {
      const result = await invoke(["stop", "old-vm", "--wait", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(result.code, 1);
      assert.equal(result.json.error.code, "vm_operation_failed");
      assert.equal(result.json.error.instance.state, "stopped");
    }));

  it(`${platform}: another request cannot satisfy this restart stop`, async () => fixture(platform,
    { replacedOperation: true }, async ({ invoke, startCount }) => {
      const result = await invoke(["restart", "old-vm", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(result.code, 1);
      assert.equal(result.json.error.code, "operation_replaced");
      assert.equal(result.json.error.observed_request_id, "another-stop");
      assert.equal(startCount(), 0);
    }));

  it(`${platform}: ready state waits for the matching operation to finish`, async () => fixture(platform,
    { initialState: "stopped", pendingReady: true }, async ({ invoke, calls }) => {
      const result = await invoke(["start", "old-vm", "--wait", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(result.code, 0, result.stdout);
      assert.ok(calls.filter(c => c.method === "GET" && c.route.endsWith("/old-vm")).length >= 2);
    }));

  for (const httpError of [0, 409]) {
    it(`${platform}: switched launch failure retains new ID (${httpError || "200 sent:false"})`, async () => fixture(platform,
      { initialState: "stopped", switchFailed: true, httpError }, async ({ invoke, calls }) => {
        const result = await invoke(["dispatch", "old-vm", "--agent", "new-agent"]);
        assert.equal(result.code, 1);
        assert.equal(result.json.error.vm_id, "new-vm");
        assert.equal(result.json.error.retired_vm_id, "old-vm");
        assert.equal(result.json.error.instance.id, "new-vm");
        assert.equal(result.json.error.switched, true);
        assert.match(result.json.error.next_commands.get, /new-vm$/);
        assert.equal(calls.filter(c => c.method === "POST" && c.route.endsWith("/dispatch")).length, 1);
        if (httpError) assert.equal(result.json.error.http_status, httpError);
      }));
  }

  for (const command of ["start", "stop"]) {
    it(`${platform}: ${command} sent:false is nonzero without --wait`, async () => fixture(platform,
      { initialState: command === "start" ? "stopped" : "running", sentFalse: true }, async ({ invoke }) => {
        const result = await invoke([command, "old-vm"]);
        assert.equal(result.code, 1);
        assert.equal(result.json.error.code, command + "_not_sent");
        assert.equal(result.json.error.vm_id, "old-vm");
      }));
  }

  for (const command of ["start", "stop"]) {
    it(`${platform}: ${command} HTTP failure retains current instance and request`, async () => fixture(platform,
      { httpError: platform === "ios" ? 502 : 409 }, async ({ invoke, calls }) => {
        const result = await invoke([command, "old-vm"]);
        assert.equal(result.code, 1);
        assert.equal(result.json.error.instance.id, "old-vm");
        assert.equal(result.json.error.request_id, command + "-attempt");
        assert.equal(calls.filter(c => c.method === "POST").length, 1);
      }));
  }

  it(`${platform}: old Server without operation metadata still restarts`, async () => fixture(platform,
    { legacy: true }, async ({ invoke }) => {
      const result = await invoke(["restart", "old-vm", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.json.status.instance.id, "old-vm");
    }));

  it(`${platform}: successful switch waits on the new ID and its operation`, async () => fixture(platform,
    { initialState: "stopped" }, async ({ invoke }) => {
      const result = await invoke(["dispatch", "old-vm", "--agent", "new-agent", "--wait", "--timeout", "2", "--interval", "0.01"]);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.json.status.instance.id, "new-vm");
    }));

  it(`${platform}: legacy stopped no-op is only accepted by an explicit wait`, async () => fixture(platform,
    { initialState: "stopped", legacy: true, legacyNoop: true }, async ({ invoke }) => {
      assert.equal((await invoke(["stop", "old-vm"])).code, 1);
      assert.equal((await invoke(["stop", "old-vm", "--wait", "--timeout", "2"])).code, 0);
    }));

  it(`${platform}: cleanup_sent:false does not turn successful ledger deletion into failure`, async () => fixture(platform,
    { initialState: "agent_offline" }, async ({ invoke }) => {
      const result = await invoke(["delete", "old-vm"]);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.json.deleted, true);
      assert.equal(result.json.cleanup_sent, false);
      assert.equal(result.json.host_cleanup_confirmed, false);
    }));
}

it("create --start without --wait preserves its configuration but fails when dispatch was not sent", async () => fixture("ios",
  { sentFalse: true }, async ({ invoke, calls }) => {
    const result = await invoke(["create", "--alias", "personal-created", "--preset", "iPhone 17", "--os", "26.0", "--start"]);
    assert.equal(result.code, 1);
    assert.equal(result.json.error.code, "dispatch_not_sent");
    assert.equal(result.json.error.instance.id, "created-vm");
    assert.equal(result.json.error.vm_id, "created-vm");
    assert.equal(calls.filter(c => c.method === "POST" && c.route.endsWith("/instances")).length, 1);
    assert.equal(calls.filter(c => c.method === "POST" && c.route.endsWith("/dispatch")).length, 1);
  }));
