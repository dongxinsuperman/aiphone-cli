"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BASES = { android: "/api/internal/vm", ios: "/api/internal/ios-sim", harmony: "/api/internal/harmony-vm" };
const DUO = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
const DUO_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4";
const androidProfiles = [
  { id: "abcdef123456", marketing_name: "Xiaomi 13", brand: "xiaomi", model_code: "2211133C", form_factor: "Phone", screen_width: 1080, screen_height: 2400, densities: ["480"], ram_mb: 8192, sdk_versions: ["33", "35"], verification_status: "verified" },
  { id: "abcdef123457", marketing_name: "Xiaomi 13 Pro", brand: "xiaomi", form_factor: "Phone", screen_width: 1440, screen_height: 3200, densities: ["560"], ram_mb: 12288, sdk_versions: ["33"], verification_status: "verified" },
  { id: "abcdef123458", marketing_name: "Pending Phone", sdk_versions: ["35"], verification_status: "pending" },
  { id: "pixel-fold", marketing_name: "Pixel Fold", sdk_versions: ["36"], foldable_api_level: 37, verification_status: "verified" },
];
const iosCatalog = {
  device_types: [
    { identifier: "type.ipod", name: "iPod touch", product_family: "iPhone", min_runtime_version: 1 },
    { identifier: "type.iphone16", name: "iPhone 16", product_family: "iPhone", min_runtime_version: 1179648 },
    { identifier: "type.iphone17", name: "iPhone 17", product_family: "iPhone", min_runtime_version: 1703936 },
    { identifier: "type.ipad", name: "iPad Pro", product_family: "iPad", min_runtime_version: 1703936 },
    { identifier: DUO, name: "iPhone Duo", product_family: "iPhone", min_runtime_version: 1769472, runtime_identifiers: [DUO_RUNTIME] },
  ],
  official_runtimes: [
    { identifier: "runtime.ios18", name: "iOS 18.0", version: "18.0" },
    { identifier: "runtime.ios26", name: "iOS 26.0", version: "26.0" },
    { identifier: "runtime.beta", name: "iOS 27 beta", version: "27.0" },
    { identifier: "runtime.ios27", name: "iOS 27.2", version: "27.2" },
    { identifier: DUO_RUNTIME, name: "iOS 27.2 · iPhone Duo", version: "27.2", only_device_type: DUO },
  ],
};
const harmonyCatalog = {
  images: [
    { id: "phone-old", device_type: "Phone", os_version: "HarmonyOS 5.0(17)", abi: "auto", creatable: true },
    { id: "phone-new", device_type: "Phone", os_version: "HarmonyOS 6.0(20)", abi: "auto", creatable: true },
    { id: "phone-disabled", device_type: "Phone", os_version: "HarmonyOS 7.0(21)", creatable: false },
    { id: "tablet", device_type: "Tablet", os_version: "HarmonyOS 6.0(20)", abi: "auto", creatable: true },
    { id: "foldable", device_type: "Foldable", os_version: "HarmonyOS 7.0(26)", abi: "auto", creatable: true },
  ],
  screen_profiles: [
    { id: "p1", name: "Default Phone", device_type: "Phone", supported_image_ids: ["phone-new", "phone-old"], create_methods: { "phone-new": "default", "phone-old": "default" } },
    { id: "p2", name: "Old Phone", device_type: "Phone", supported_image_ids: ["phone-old"], create_methods: { "phone-old": "screen_profile" } },
    { id: "t1", name: "Default Tablet", device_type: "Tablet", supported_image_ids: ["tablet"], create_methods: { tablet: "default" } },
    { id: "fold1", name: "Mate X7", device_type: "Foldable", supported_image_ids: ["foldable"], create_methods: { foldable: "screen_profile" }, outer_width: 1080, outer_height: 2444 },
  ],
};

async function fixture(action) {
  const calls = [];
  const state = { records: new Map(), candidates: [{ agent_id: "z", ok: true }, { agent_id: "a", ok: true }], available: true, busy: false, wrongAgent: false, deny: false, startFailed: false, cleanup: false };
  const keyFor = (p, id) => `${p}/${id}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, "http://localhost");
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
    const send = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (state.deny && url.pathname.startsWith("/api/internal/")) return send({ detail: "missing Authorization: Bearer header" }, 401);
    if (url.pathname === "/api/devices/statuses" || url.pathname === "/api/devices/available") {
      const available = url.pathname.endsWith("/available");
      return send([...state.records.entries()].filter(([, vm]) => vm.state === "running").filter(() => !available || state.available && !state.busy).map(([key, vm]) => {
        const p = key.split("/")[0];
        return {
          serial: p === "ios" ? vm.udid : p === "android" ? vm.adb_serial : `harmony-vm:${vm.id}`,
          platform: p, agent_id: state.wrongAgent ? "other" : vm.assigned_agent_id,
          status: "online", extra: { readiness: { ready: true } }, lock: state.busy ? { holder_type: "run" } : null,
        };
      }));
    }
    const platform = Object.keys(BASES).find((p) => url.pathname.startsWith(BASES[p]));
    if (!platform) return send({ echo: body || "legacy", id: "batch", items: [] });
    const suffix = url.pathname.slice(BASES[platform].length);
    if (suffix === "/catalog") return send(platform === "ios" ? iosCatalog : harmonyCatalog);
    if (suffix === "/device-profiles") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const rows = androidProfiles.filter((r) => !q || [r.marketing_name, r.model_code].some((v) => String(v || "").toLowerCase().includes(q)))
        .filter((r) => !url.searchParams.has("brand") || r.brand === url.searchParams.get("brand"))
        .filter((r) => !url.searchParams.has("sdk") || r.sdk_versions.includes(url.searchParams.get("sdk")) || String(r.foldable_api_level) === url.searchParams.get("sdk"));
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 30);
      return send({ items: rows.slice(offset, offset + limit), page: { offset, limit, total: rows.length, has_more: offset + limit < rows.length } });
    }
    if (suffix === "/instances" && req.method === "GET") return send([...state.records.entries()].filter(([key]) => key.startsWith(platform + "/")).map(([, vm]) => vm));
    if (suffix === "/instances" && req.method === "POST") {
      const config = { ...body.config_json };
      if (platform === "android" && body.fold_state || platform === "harmony" && body.fold_state === "folded") {
        config.fold = { initial_state: body.fold_state };
      }
      if (platform === "harmony" && body.initial_rotation) config.initial_rotation = body.initial_rotation;
      if (platform === "ios") {
        if (body.initial_orientation) config.initial_orientation = body.initial_orientation;
        if (body.initial_fold_state) config.initial_fold_state = body.initial_fold_state;
      }
      const vm = { ...body, config_json: config, ...state.createOverride, id: `vm${state.records.size + 1}`, state: "draft" };
      state.records.set(keyFor(platform, vm.id), vm);
      if (state.disconnectOnCreate) return req.socket.destroy();
      return send(vm, 201);
    }
    const match = suffix.match(/^\/instances\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const vm = state.records.get(keyFor(platform, id));
      if (!vm) return send({ detail: "not found" }, 404);
      if (!match[2] && req.method === "GET") return send(vm);
      if (!match[2] && req.method === "PATCH") { Object.assign(vm, body); return send(vm); }
      if (!match[2] && req.method === "DELETE") { state.records.delete(keyFor(platform, id)); return send({ id, deleted: true, cleanup_sent: state.cleanup }); }
      if (match[2] === "dispatch-candidates") return send({ agents: state.candidates });
      if (["dispatch", "start"].includes(match[2])) {
        if (state.switchId && match[2] === "dispatch") {
          state.records.delete(keyFor(platform, id));
          vm.id = "moved-vm";
          state.records.set(keyFor(platform, vm.id), vm);
        }
        vm.state = state.startFailed ? "error" : "running";
        vm.assigned_agent_id = body?.agent_id || vm.assigned_agent_id;
        vm.adb_serial = "emulator-5554";
        vm.udid = "udid-test";
        return send({ sent: true, instance: { ...vm, state: "starting" } });
      }
      if (match[2] === "stop") { if (state.stopFailed) return send({ sent: false, instance: { ...vm, state: "agent_offline" } }); vm.state = "stopped"; return send({ sent: true, instance: vm }); }
      if (match[2] === "copy") return send({ ...vm, ...body, id: "copied", state: "draft" }, 201);
    }
    return send({ echo: body || "ok" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const invoke = (args, stdin, env = {}) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), ...args], {
      env: { ...process.env, AIPHONE_INTERNAL_TOKEN: "", AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}`, ...env },
    });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("test CLI timeout")); }, 10000);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(stdout); } catch { /* Help text isn't JSON. */ }
      resolve({ code, stdout, stderr, json });
    });
    proc.stdin.end(stdin || "");
  });
  try { await action({ invoke, calls, state, keyFor }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const choices = { android: ["Xiaomi 13", "13"], ios: ["iPhone 17", "26.0"], harmony: ["Default Phone", "HarmonyOS 6.0(20)"] };
const createArgs = (p, ...extra) => ["vm", p, "create", "--alias", `test-${p}`, "--preset", choices[p][0], "--os", choices[p][1], ...extra];

it("VM internal headers match the workbench without affecting public endpoints", async () => fixture(async ({ invoke, calls }) => {
  assert.equal((await invoke(["vm", "ios", "list"])).code, 0);
  assert.equal(calls.at(-1).headers.authorization, "Bearer dev");
  assert.equal((await invoke(["vm", "ios", "list"], undefined, { AIPHONE_INTERNAL_TOKEN: "local-test-token" })).code, 0);
  assert.equal(calls.at(-1).headers.authorization, "Bearer local-test-token");
  const r = await invoke(createArgs("ios", "--start", "--wait"));
  assert.equal(r.code, 0, r.stdout);
  assert.ok(calls.some((c) => c.path === "/api/devices/statuses"));
  assert.ok(calls.filter((c) => !c.path.startsWith("/api/internal/")).every((c) => !c.headers.authorization));
}));

it("alias is mandatory; create/update cannot accept raw JSON or hardware overrides", async () => fixture(async ({ invoke, calls }) => {
  for (const p of Object.keys(BASES)) {
    for (const args of [
      ["vm", p, "create"], ["vm", p, "create", "--alias", "   "],
      createArgs(p, "--stdin"), createArgs(p, "-f", "not-read.json"), createArgs(p, "--ram", "9000"),
      ["vm", p, "update", "id", "--stdin"],
    ]) {
      const r = await invoke(args, '{"alias":"bypass","config_json":{}}');
      assert.notEqual(r.code, 0, JSON.stringify(args));
    }
  }
  assert.equal(calls.length, 0);
}));

it("preset/system selection cannot be guessed or combined outside backend compatibility", async () => fixture(async ({ invoke, calls }) => {
  const noPreset = await invoke(["vm", "android", "create", "--alias", "explicit"]);
  assert.equal(noPreset.json.error.code, "preset_required");
  const noOs = await invoke(["vm", "android", "create", "--alias", "explicit", "--preset", "Xiaomi 13"]);
  assert.equal(noOs.json.error.code, "system_selection_required");
  assert.equal(noOs.json.error.systems.length, 2);
  for (const [p, preset, os] of [["android", "Xiaomi 13 Pro", "15"], ["ios", "iPhone 17", "18.0"], ["harmony", "Old Phone", "HarmonyOS 6.0(20)"], ["harmony", "Default Phone", "phone-disabled"]]) {
    const r = await invoke(["vm", p, "create", "--alias", "explicit", "--preset", preset, "--os", os]);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, "incompatible_system");
  }
  assert.ok(calls.every((c) => c.method === "GET"));
}));

it("catalog search has counts, pagination, reference specs and preset-specific systems", async () => fixture(async ({ invoke, calls }) => {
  const search = await invoke(["vm", "android", "catalog", "--q", "13", "--brand", "xiaomi", "--limit", "1"]);
  assert.equal(search.code, 0, search.stdout);
  assert.equal(search.json.page.total, 2);
  assert.equal(search.json.page.has_more, true);
  assert.equal(search.json.items[0].reference_spec.ram_mb, 8192);
  assert.equal(search.json.items[0].vm_spec.ram_mb, 3072);
  const next = await invoke(["vm", "android", "catalog", "--q", "13", "--brand", "xiaomi", "--offset", "1", "--limit", "1"]);
  assert.equal(next.json.items[0].name, "Xiaomi 13 Pro");
  const detail = await invoke(["vm", "android", "preset", "abcdef123456"]);
  assert.equal(detail.json.name, "Xiaomi 13");
  const ios = await invoke(["vm", "ios", "systems", "iPhone 17"]);
  assert.ok(ios.json.systems.every((s) => s.version !== "18.0"));
  const harmony = await invoke(["vm", "harmony", "preset", "Old Phone"]);
  assert.deepEqual(harmony.json.systems.map((s) => s.id), ["phone-old"]);
  const missing = await invoke(["vm", "android", "catalog", "--q", "no match"]);
  assert.equal(missing.json.page.total, 0);
  assert.ok(calls.every((c) => c.method === "GET"));
}));

it("controlled plans fix hardware and preserve backend presets on all three platforms", async () => fixture(async ({ invoke, calls }) => {
  for (const p of Object.keys(BASES)) {
    const r = await invoke(createArgs(p, "--dry-run"));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.alias, `test-${p}`);
    assert.equal(r.json.availability_checked, false);
    if (p === "android") {
      assert.equal(r.json.payload.profile_ref_type, "real_device");
      assert.equal(r.json.payload.config_json.performance.ram_mb, 3072);
      assert.equal(r.json.payload.density, 480);
      assert.equal(r.json.payload.api_level, 33);
      assert.equal(r.json.payload.config_json.network.http_proxy, "");
    }
    if (p === "ios") assert.deepEqual(r.json.payload, { alias: "test-ios", device_type: "type.iphone17", runtime: "runtime.ios26" });
    if (p === "harmony") { assert.equal(r.json.payload.memory_gb, 3); assert.equal(r.json.payload.boot_mode, "cold"); assert.equal(r.json.payload.fold_state, "unfolded"); }
  }
  assert.ok(calls.every((c) => c.method === "GET"));
}));

it("creates three-platform startup posture through the existing endpoints", async () => fixture(async ({ invoke, calls }) => {
  for (const [platform, preset, direction, fold, expected] of [
    ["android", "Pixel Fold", "landscape_right", "unfolded", { api_level: 37, orientation: "landscape_right", fold_state: "unfolded" }],
    ["ios", "iPhone Duo", "landscape_left", "folded", { runtime: DUO_RUNTIME, initial_orientation: "landscape_left", initial_fold_state: "folded" }],
    ["harmony", "Mate X7", "3", "folded", { initial_rotation: 3, fold_state: "folded" }],
  ]) {
    const r = await invoke(["vm", platform, "create", "--alias", `posture-${platform}`, "--preset", preset,
      "--orientation", direction, "--fold-state", fold]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const call = calls.at(-1);
    assert.equal(call.path, `${BASES[platform]}/instances`);
    assert.equal(call.method, "POST");
    for (const [field, value] of Object.entries(expected)) assert.equal(call.body[field], value);
  }
  const ordinary = await invoke(["vm", "android", "create", "--alias", "old-default", "--preset", "Pixel Fold", "--dry-run"]);
  assert.equal(ordinary.code, 0, ordinary.stdout);
  assert.equal(ordinary.json.payload.api_level, 36);
  assert.equal(ordinary.json.payload.orientation, "portrait");
  assert.equal(ordinary.json.payload.fold_state, undefined);
  const catalog = await invoke(["vm", "android", "catalog", "--os", "api-37"]);
  assert.ok(catalog.json.items.some((preset) => preset.id === "pixel-fold" && preset.foldable_api_level === 37));
}));

it("rejects unsupported folds and hides the Duo-only runtime from other iOS models", async () => fixture(async ({ invoke, calls }) => {
  for (const platform of Object.keys(BASES)) {
    const r = await invoke(createArgs(platform, "--fold-state", "folded"));
    assert.equal(r.json.error.code, "unsupported_fold_state", r.stdout);
  }
  const android = await invoke(["vm", "android", "create", "--alias", "bad-fold", "--preset", "Pixel Fold", "--os", "api-36", "--fold-state", "folded"]);
  assert.equal(android.json.error.code, "incompatible_system");
  const ios = await invoke(["vm", "ios", "systems", "iPhone 17"]);
  assert.ok(ios.json.systems.some((system) => system.id === "runtime.ios27"));
  assert.ok(ios.json.systems.every((system) => system.id !== DUO_RUNTIME));
  assert.ok(calls.every((call) => call.method === "GET"));
}));

it("retains the draft ID and skips launch if the Server drops explicitly requested posture", async () => fixture(async ({ invoke, state, calls }) => {
  state.createOverride = { config_json: {} };
  const r = await invoke(["vm", "ios", "create", "--alias", "posture-mismatch", "--preset", "iPhone Duo",
    "--orientation", "landscape_right", "--fold-state", "folded", "--start"]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, "posture_mismatch");
  assert.equal(r.json.error.instance.id, "vm1");
  assert.deepEqual(r.json.error.mismatches.map(({ field }) => field), ["initial_orientation", "initial_fold_state"]);
  assert.deepEqual(calls.filter(({ method }) => method === "POST").map(({ path }) => path), ["/api/internal/ios-sim/instances"]);
}));

it("create only saves config unless start is requested; lifecycle routes remain platform-specific", async () => fixture(async ({ invoke, calls }) => {
  for (const p of Object.keys(BASES)) {
    const r = await invoke(createArgs(p));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.phase, "configured");
    assert.equal(r.json.schedulable, false);
    assert.equal(calls.at(-1).path, `${BASES[p]}/instances`);
    assert.equal(calls.at(-1).method, "POST");
    const launched = await invoke(["vm", p, "dispatch", r.json.instance.id, "--wait", "--timeout", "2"]);
    assert.equal(launched.code, 0, launched.stdout);
    assert.equal(launched.json.status.schedulable, true);
    const delActive = await invoke(["vm", p, "delete", r.json.instance.id]);
    assert.equal(delActive.json.error.code, "active_vm");
    const stopped = await invoke(["vm", p, "stop", r.json.instance.id, "--wait"]);
    assert.equal(stopped.code, 0, stopped.stdout);
    const del = await invoke(["vm", p, "delete", r.json.instance.id]);
    assert.equal(del.json.host_cleanup_confirmed, false);
  }
}));

it("created preset mismatches fail before any probe/start and preserve the saved instance", async () => fixture(async ({ invoke, state, calls }) => {
  for (const [p, override] of [
    ["android", { profile_ref_type: "custom", profile_ref_id: "" }],
    ["android", { profile_ref_id: "different-profile" }],
    ["android", { api_level: 35 }],
    ["ios", { device_type: "type.iphone16" }],
    ["ios", { runtime: "runtime.ios18" }],
    ["harmony", { device_type: "Tablet" }],
    ["harmony", { screen_profile: "Other Phone" }],
    ["harmony", { image_id: "phone-old" }],
  ]) {
    state.createOverride = override;
    const before = calls.length;
    const result = await invoke(createArgs(p, "--start", "--wait"));
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, "preset_mismatch");
    assert.equal(result.json.error.phase, "validate_created");
    assert.ok(result.json.error.instance.id);
    assert.equal(result.json.error.plan.alias, `test-${p}`);
    assert.ok(result.json.error.mismatches.some((m) => Object.hasOwn(override, m.field)));
    assert.deepEqual(Object.keys(result.json.error.next_commands).sort(), ["get", "status"]);
    assert.ok(state.records.has(`${p}/${result.json.error.instance.id}`));
    assert.deepEqual(calls.slice(before).filter((c) => c.method !== "GET").map((c) => [c.method, c.path]), [["POST", `${BASES[p]}/instances`]]);
  }
  const before = calls.length;
  state.createOverride = { profile_ref_type: "custom" };
  const withoutStart = await invoke(createArgs("android"));
  assert.equal(withoutStart.code, 1);
  assert.equal(withoutStart.json.error.code, "preset_mismatch");
  assert.equal(calls.slice(before).filter((c) => c.method === "POST").length, 1);
}));

it("legitimate server ABI normalization does not trigger preset mismatch", async () => fixture(async ({ invoke, state }) => {
  state.createOverride = { abi: "arm64" };
  const result = await invoke(createArgs("harmony"));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.instance.abi, "arm64");
  assert.equal(result.json.phase, "configured");
}));

it("existing instances support aggregate counts, paging, filtering, exact aliases and rename", async () => fixture(async ({ invoke, state, calls }) => {
  state.records.set("android/one", { id: "one", alias: "回归安卓", state: "stopped", assigned_agent_id: "a" });
  state.records.set("ios/two", { id: "two", alias: "回归iOS", state: "running", assigned_agent_id: "b" });
  const all = await invoke(["vm", "list", "--limit", "1"]);
  assert.equal(all.json.total_existing, 2);
  assert.equal(all.json.page.total, 2);
  assert.equal(all.json.page.has_more, true);
  const filtered = await invoke(["vm", "list", "--platform", "android", "--agent", "a", "--state", "stopped"]);
  assert.equal(filtered.json.page.total, 1);
  const exact = await invoke(["vm", "android", "get", "回归安卓"]);
  assert.equal(exact.json.id, "one");
  const fuzzy = await invoke(["vm", "android", "get", "回归"]);
  assert.equal(fuzzy.code, 1);
  const rename = await invoke(["vm", "android", "rename", "回归安卓", "--alias", "新别名"]);
  assert.equal(rename.json.alias, "新别名");
  assert.deepEqual(calls.at(-1).body, { alias: "新别名" });
  state.records.set("android/collision", { id: "collision", alias: "one", state: "stopped" });
  const before = calls.length;
  const ambiguous = await invoke(["vm", "android", "delete", "one"]);
  assert.equal(ambiguous.json.error.code, "ambiguous_instance");
  assert.ok(calls.slice(before).every((c) => c.method === "GET"));
}));

it("restart stops then starts the same instance and never creates or deletes", async () => fixture(async ({ invoke, calls }) => {
  for (const p of Object.keys(BASES)) {
    const r = await invoke(createArgs(p, "--start", "--wait"));
    assert.equal(r.code, 0, r.stdout);
    const id = r.json.instance.id;
    const before = calls.length;
    const restarted = await invoke(["vm", p, "restart", id, "--timeout", "2", "--interval", "0.01"]);
    assert.equal(restarted.code, 0, restarted.stdout);
    assert.equal(restarted.json.status.instance.id, id);
    assert.equal(restarted.json.phase, "ready");
    assert.deepEqual(calls.slice(before).filter((c) => c.method === "POST").map((c) => c.path), [`${BASES[p]}/instances/${id}/stop`, `${BASES[p]}/instances/${id}/start`]);
    assert.ok(calls.slice(before).every((c) => c.method !== "DELETE"));
  }
}));

it("restart aborts on failed stop or busy device instead of starting/recreating", async () => fixture(async ({ invoke, calls, state }) => {
  const r = await invoke(createArgs("android", "--start", "--wait"));
  const id = r.json.instance.id;
  state.stopFailed = true;
  let before = calls.length;
  const failed = await invoke(["vm", "android", "restart", id, "--timeout", "1"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.json.error.phase, "stop");
  assert.ok(!calls.slice(before).some((c) => c.path.endsWith("/start")));
  state.stopFailed = false; state.busy = true; before = calls.length;
  const busy = await invoke(["vm", "android", "restart", id]);
  assert.equal(busy.json.error.code, "device_busy");
  assert.ok(calls.slice(before).every((c) => c.method === "GET"));
}));

it("failed launch preserves created ID and network ambiguity never retries create", async () => fixture(async ({ invoke, state, calls }) => {
  state.candidates = [{ agent_id: "x", ok: false, reason: "runtime missing" }];
  const r = await invoke(createArgs("ios", "--start"));
  assert.equal(r.code, 1);
  assert.equal(r.json.error.instance.id, "vm1");
  assert.equal(r.json.error.code, "no_capable_agent");
  state.disconnectOnCreate = true;
  const ambiguous = await invoke(createArgs("android"));
  assert.equal(ambiguous.json.error.outcome_unknown, true);
  assert.equal(ambiguous.json.error.plan.alias, "test-android");
  assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/instances")).length, 2);
}));

it("status distinguishes running, ownership and busy; waits fail on timeout or error", async () => fixture(async ({ invoke, state }) => {
  const created = await invoke(createArgs("android", "--start"));
  const id = created.json.instance.id;
  state.busy = true;
  const busy = await invoke(["vm", "android", "status", id]);
  assert.equal(busy.json.ready, true); assert.equal(busy.json.schedulable, false);
  // One successful local status read, then sleep to the deadline. Avoid racing
  // another HTTP request's abort timer at the end of an 80 ms test window.
  const timeout = await invoke(["vm", "android", "wait", id, "--timeout", "0.3", "--interval", "1"]);
  assert.equal(timeout.json.error.code, "wait_timeout");
  state.busy = false; state.wrongAgent = true;
  const wrong = await invoke(["vm", "android", "status", id]);
  assert.equal(wrong.json.schedulable, false);
  state.wrongAgent = false; state.startFailed = true;
  const fail = await invoke(["vm", "android", "start", id, "--wait"]);
  assert.equal(fail.json.error.code, "vm_not_ready");
}));

it("dispatch follows replacement IDs, access errors do not trigger fallback", async () => fixture(async ({ invoke, state }) => {
  const draft = await invoke(createArgs("ios"));
  state.switchId = true;
  const moved = await invoke(["vm", "ios", "dispatch", draft.json.instance.id, "--wait"]);
  assert.equal(moved.json.status.instance.id, "moved-vm");
  state.deny = true;
  const denied = await invoke(["vm", "android", "list"]);
  assert.equal(denied.json.error.http_status, 401);
}));

it("legacy commands keep their routes, methods, passthrough payload and JSON output", async () => fixture(async ({ invoke, calls }) => {
  for (const [args, method, route] of [
    [["devices", "available"], "GET", "/api/devices/available"],
    [["devices", "statuses"], "GET", "/api/devices/statuses"],
    [["submissions", "get", "batch"], "GET", "/api/submissions/batch"],
    [["submissions", "reports", "batch"], "GET", "/api/submissions/batch"],
    [["submissions", "item", "batch", "case", "ios"], "GET", "/api/submissions/batch/items/case/ios"],
    [["submissions", "cancel", "batch"], "POST", "/api/submissions/batch/cancel"],
    [["submissions", "cancel-case", "batch", "case", "--platform", "android"], "POST", "/api/submissions/batch/cases/case/cancel"],
  ]) {
    const r = await invoke(args);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.json);
    assert.equal(calls.at(-1).path, route);
    assert.equal(calls.at(-1).method, method);
  }
  const payload = { items: [{ caseId: "c1", runContent: "目标", platforms: ["ios"], future_field: { a: 1 } }], functionMapContext: "map", custom: "keep" };
  const submit = await invoke(["submissions", "submit", "--stdin"], JSON.stringify(payload));
  assert.equal(submit.code, 0);
  assert.deepEqual(calls.at(-1).body, payload);
  assert.deepEqual(submit.json.echo, payload);
  assert.equal(calls.at(-1).path, "/api/submissions");
  assert.ok(calls.every((c) => !c.path.startsWith("/api/internal/")));
  const count = calls.length;
  for (const args of [["--version"], ["config", "get"], ["submissions", "fields"], ["vm", "fields"], ["vm", "ios", "--help"]]) {
    const r = await invoke(args);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  }
  assert.equal(calls.length, count);
}));

 it("memory overrides reach controlled payloads and invalid values never make requests", async () => fixture(async ({ invoke, calls }) => {
  for (const p of ["android", "harmony"]) {
    for (const memory of [2, 3, 4, 32]) {
      const result = await invoke(createArgs(p, "--memory", String(memory)));
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const body = calls.filter(c => c.method === "POST").at(-1).body;
      assert.equal(p === "android" ? body.config_json.performance.ram_mb : body.memory_gb, p === "android" ? memory * 1024 : memory);
    }
    for (const memory of ["0", "1", "33", "-1", "2.5", "NaN", "3GB"]) {
      const before = calls.length;
      const result = await invoke(createArgs(p, "--memory", memory));
      assert.notEqual(result.code, 0);
      assert.equal(calls.length, before);
    }
    const preview = await invoke(createArgs(p, "--memory", "2", "--dry-run"));
    assert.equal(preview.code, 0);
    assert.equal(p === "android" ? preview.json.preset.vm_spec.ram_mb : preview.json.preset.vm_spec.memory_gb, p === "android" ? 2048 : 2);
  }
  const before = calls.length;
  assert.notEqual((await invoke(createArgs("ios", "--memory", "3"))).code, 0);
  assert.equal(calls.length, before);
}));
