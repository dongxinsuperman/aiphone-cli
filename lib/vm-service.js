"use strict";

const { request, VmError, instances, instancePath } = require("./vm-client");

const ACTIVE = new Set(["probing", "dispatching", "creating", "starting", "connecting_hdc", "checking_driver", "running", "stopping"]);

function operationOf(platform, instance) {
  // iOS runtime is the system version; its operation metadata is separate.
  const data = platform === "ios" ? instance?.runtime_state : instance?.runtime;
  const operation = data && typeof data === "object" ? data.operation : null;
  return operation && typeof operation === "object" ? operation : null;
}

function operationContext(platform, response) {
  return { requestId: operationOf(platform, response?.instance)?.request_id || null };
}

function lifecycleError(platform, requestedId, err) {
  const response = err.details?.response;
  const payload = response?.detail && typeof response.detail === "object" ? response.detail : response || {};
  const instance = payload.instance || err.details?.instance || err.details?.last_status?.instance;
  const id = instance?.id || payload.vm_id || err.details?.vm_id || requestedId;
  const retiredId = payload.retired_vm_id || payload.old_vm_id || err.details?.retired_vm_id ||
    (payload.switched && id !== requestedId ? requestedId : null);
  const commands = id ? nextCommands(platform, { id }) : null;
  err.details = { ...err.details, ...(id ? { vm_id: id } : {}),
    ...(instance ? { instance } : {}), ...(retiredId ? { retired_vm_id: retiredId } : {}),
    ...(payload.switched === undefined ? {} : { switched: payload.switched }),
    ...(payload.request_id ? { request_id: payload.request_id } : {}),
    ...(commands ? { next_commands: { get: commands.get, status: commands.status } } : {}) };
  return err;
}

function requireSent(platform, id, response, action, { legacyStopped = false } = {}) {
  // An old Server may report an already-stopped no-op. Only an explicit wait
  // may accept that fact; non-wait commands must not label sent:false accepted.
  if (legacyStopped && response?.sent === false && response.instance?.id && response.instance.state === "stopped" &&
      !operationOf(platform, response.instance)) return;
  if (response?.sent !== true || !response.instance?.id) {
    throw lifecycleError(platform, id, new VmError(`${action}_not_sent`,
      "服务端未确认本次指令下发，请查询返回的当前实例；不会自动重试", { response }));
  }
}

function operationSucceeded(platform, instance, context, lastStatus) {
  if (!context) return true; // Standalone wait queries a fact, not a command it issued.
  const operation = operationOf(platform, instance);
  if (context.requestId && operation?.request_id !== context.requestId) {
    throw new VmError(operation ? "operation_replaced" : "operation_unconfirmed",
      "无法确认本次操作的结果，当前记录已变化；不会把其他操作当成本次成功", {
        request_id: context.requestId, observed_request_id: operation?.request_id || null, last_status: lastStatus,
      });
  }
  if (operation?.outcome === "failed") {
    throw new VmError("vm_operation_failed", "本次操作已失败，后续步骤已中止", {
      request_id: operation.request_id, operation, last_status: lastStatus,
    });
  }
  // Backward compatible with Servers predating operation metadata.
  return !operation || (operation.pending === false && operation.outcome === "succeeded");
}

async function listInstances(platform, opts = {}) {
  const platforms = platform ? [platform] : ["android", "ios", "harmony"];
  const groups = await Promise.all(platforms.map(async (p) => (await request("GET", instances(p))).map((vm) => ({ platform: p, ...vm }))));
  const all = groups.flat();
  const filtered = all.filter((vm) => (!opts.alias || vm.alias === opts.alias) && (!opts.state || vm.state === opts.state) && (!opts.agent || vm.assigned_agent_id === opts.agent) &&
    (!opts.q || [vm.id, vm.alias, vm.profile_name, vm.device_type_name, vm.screen_profile].some((v) => String(v || "").toLowerCase().includes(opts.q.toLowerCase()))));
  const counts = {};
  const platformCounts = {};
  for (const vm of filtered) {
    counts[vm.state] = (counts[vm.state] || 0) + 1;
    platformCounts[vm.platform] = (platformCounts[vm.platform] || 0) + 1;
  }
  const offset = opts.offset ?? 0, limit = opts.limit ?? 30;
  return { items: filtered.slice(offset, offset + limit), total_existing: all.length, counts, platform_counts: platformCounts,
    page: { offset, limit, returned: filtered.slice(offset, offset + limit).length, total: filtered.length, has_more: offset + limit < filtered.length } };
}

async function resolveInstance(platform, selector) {
  // Detect ID/alias collisions too, rather than silently choosing another VM.
  const matches = (await request("GET", instances(platform))).filter((vm) => vm.id === selector || vm.alias === selector);
  if (matches.length !== 1) throw new VmError(matches.length ? "ambiguous_instance" : "instance_not_found", "请提供唯一实例 ID 或精确别名，不会模糊匹配后操作", { candidates: matches.map((vm) => ({ id: vm.id, alias: vm.alias })) });
  return matches[0];
}

async function status(platform, id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 75000);
  const instance = await request("GET", instancePath(platform, id), { timeoutMs });
  const remaining = Math.max(1, deadline - Date.now());
  const [devices, available] = await Promise.all([
    request("GET", "/api/devices/statuses", { timeoutMs: remaining }),
    request("GET", "/api/devices/available", { timeoutMs: remaining }),
  ]);
  const serial = platform === "harmony" ? `harmony-vm:${instance.id}` : platform === "ios" ? instance.udid : instance.adb_serial;
  const device = devices.find((d) => serial && d.serial === serial && d.agent_id === instance.assigned_agent_id) || null;
  const schedulable = Boolean(instance.state === "running" && device && available.some((d) => d.serial === serial && d.platform === platform));
  return {
    platform, instance, serial: serial || null, device,
    lifecycle_state: instance.state,
    ready: Boolean(instance.state === "running" && device?.status === "online" && device.extra?.readiness?.ready),
    schedulable,
    evidence: { agent_matches: Boolean(device), available: schedulable },
  };
}

async function waitFor(platform, id, target, { timeout = 180, interval = 2, operation: context } = {}) {
  const deadline = Date.now() + timeout * 1000;
  let last;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    if (target === "ready") last = await status(platform, id, remaining);
    else {
      const instance = await request("GET", instancePath(platform, id), { timeoutMs: remaining });
      last = { platform, instance, lifecycle_state: instance.state };
    }
    const succeeded = operationSucceeded(platform, last.instance, context, last);
    if (succeeded && (target === "ready" ? last.schedulable : last.instance.state === "stopped")) return last;
    if (["error", "unavailable", "agent_offline"].includes(last.instance.state)) {
      throw new VmError("vm_not_ready", "实例进入失败或离线状态，不能报告操作完成", { last_status: last });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval * 1000, Math.max(0, deadline - Date.now()))));
  }
  throw new VmError("wait_timeout", "等待超时，保留当前实例，请用 status/get 继续核对；不会自动重建或删除", { last_status: last });
}

async function waitForOperation(platform, response, target, opts = {}) {
  const id = response.instance.id;
  try {
    return await waitFor(platform, id, target, { ...opts, operation: operationContext(platform, response) });
  } catch (err) { throw lifecycleError(platform, id, err); }
}

async function operate(platform, id, action, opts = {}) {
  try {
    const response = await request("POST", `${instancePath(platform, id)}/${action}`);
    requireSent(platform, id, response, action, { legacyStopped: action === "stop" && opts.wait });
    if (opts.wait) return { platform, response, status: await waitForOperation(platform, response,
      action === "start" ? "ready" : "stopped", opts) };
    return { platform, ...response, message: "这是受理状态，实际完成请用 status/wait 核对" };
  } catch (err) { throw lifecycleError(platform, id, err); }
}

async function dispatch(platform, id, agent) {
  const candidates = await request("POST", `${instancePath(platform, id)}/dispatch-candidates`);
  const capable = (candidates.agents || []).filter((a) => a.ok === true);
  const chosen = agent ? capable.find((a) => a.agent_id === agent) : capable.sort((a, b) => a.agent_id.localeCompare(b.agent_id))[0];
  if (!chosen) throw new VmError("no_capable_agent", agent ? "指定 Agent 当前无法承接此配置" : "没有能承接此配置的在线 Agent；无需补齐所有参数，请查看各宿主原因", { vm_id: id, candidates });
  try {
    const response = await request("POST", `${instancePath(platform, id)}/dispatch`, { body: { agent_id: chosen.agent_id } });
    requireSent(platform, id, response, "dispatch");
    return { ...response, selected_agent: chosen, candidates };
  } catch (err) { throw lifecycleError(platform, id, err); }
}

function nextCommands(platform, instance) {
  const base = `aiphone vm ${platform}`;
  return { get: `${base} get ${instance.id}`, status: `${base} status ${instance.id}`, probe: `${base} probe ${instance.id}`, dispatch: `${base} dispatch ${instance.id} --wait` };
}

function validateCreatedPreset(platform, expected, actual) {
  // Compare stable catalog identity and OS selectors, not server-normalized
  // runtime fields such as auto ABI, timestamps or allocated ports.
  const fields = {
    android: ["profile_ref_type", "profile_ref_id", "api_level"],
    ios: ["device_type", "runtime"],
    harmony: ["device_type", "screen_profile", "image_id"],
  }[platform];
  const mismatches = fields.filter((field) => expected[field] !== actual[field])
    .map((field) => ({ field, expected: expected[field], actual: actual[field] ?? null }));
  if (mismatches.length) throw new VmError("preset_mismatch", "创建回包的预设或系统与请求不一致，已阻止后续探查和启动，不允许自动替换", { mismatches });
}

async function create(platform, plan, opts) {
  let instance;
  let phase = "create";
  try {
    instance = await request("POST", instances(platform), { body: plan.payload });
    if (!instance?.id) throw new VmError("invalid_response", "创建响应没有 vm_id，请先按别名查询，不要重复创建", { outcome_unknown: true });
    phase = "validate_created";
    validateCreatedPreset(platform, plan.payload, instance);
    const result = { platform, operation: "create", phase: "configured", plan, instance, schedulable: false, next_commands: nextCommands(platform, instance) };
    if (!opts.start) return result;
    phase = "dispatch";
    result.dispatch = await dispatch(platform, instance.id, opts.agent);
    instance = result.dispatch.instance;
    result.instance = instance;
    result.next_commands = nextCommands(platform, instance);
    result.phase = "start_requested";
    if (opts.wait) {
      phase = "wait";
      result.status = await waitForOperation(platform, result.dispatch, "ready", opts);
      result.instance = result.status.instance;
      result.phase = "ready";
      result.schedulable = true;
    }
    return result;
  } catch (err) {
    err.details = { ...err.details, phase, plan };
    // A replacement may exist even when its launch failed. Never hide that ID
    // by restoring the configuration captured before dispatch.
    if (err.details.instance?.id) instance = err.details.instance;
    if (instance?.id) {
      const commands = nextCommands(platform, instance);
      const mismatch = err.code === "preset_mismatch";
      err.details = { ...err.details, phase, instance, plan,
        next_commands: mismatch ? { get: commands.get, status: commands.status } : commands,
        hint: mismatch ? "配置已保存但与请求不一致，未继续探查或启动。请按返回 ID 核对，不要继续下发或重复创建；不会自动替换或删除。" : "配置已创建，不要重复 create。使用返回的 vm_id 继续 probe/dispatch/status。" };
    }
    throw err;
  }
}

async function remove(platform, id) {
  const instance = await request("GET", instancePath(platform, id));
  // iOS currently permits active deletion in its API. Keep CLI delete uniform:
  // require explicit stop first, never stop implicitly on the user's behalf.
  if (ACTIVE.has(instance.state)) throw new VmError("active_vm", "请先 stop 并确认停止，再 delete；不会自动停止设备", { instance });
  const result = await request("DELETE", instancePath(platform, id));
  return { platform, operation: "delete", ...result, host_cleanup_confirmed: false, message: "服务端配置删除结果见 deleted；清理通知不等于宿主文件清理完成" };
}

async function restart(platform, id, opts = {}) {
  const deadline = Date.now() + (opts.timeout || 180) * 1000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new VmError("wait_timeout", "重启等待超时，不继续下一步", { vm_id: id });
    return ms;
  };
  let phase = "check";
  try {
    const initial = await status(platform, id, remaining());
    if (!["running", "stopped"].includes(initial.instance.state)) throw new VmError("invalid_state", "仅允许重启 running/stopped 实例，请先核对异常或过渡状态");
    const agent = initial.instance.assigned_agent_id;
    if (!agent) throw new VmError("agent_required", "实例没有绑定宿主，不能原地重启，请先 dispatch");
    if (initial.instance.state === "running" && (!initial.device || initial.device.status !== "online")) throw new VmError("ownership_unconfirmed", "无法确认运行设备归属和在线状态，不继续重启");
    if (initial.device?.lock) throw new VmError("device_busy", "设备被占用，不中断现有任务进行重启");
    phase = "stop";
    let stopContext;
    if (initial.instance.state !== "stopped") {
      const response = await request("POST", `${instancePath(platform, id)}/stop`, { timeoutMs: remaining() });
      requireSent(platform, id, response, "stop", { legacyStopped: true });
      stopContext = operationContext(platform, response);
      await waitForOperation(platform, response, "stopped", { ...opts, timeout: remaining() / 1000 });
    }
    phase = "start";
    const stopped = await request("GET", instancePath(platform, id), { timeoutMs: remaining() });
    if (stopped.state !== "stopped" || stopped.assigned_agent_id !== agent) throw new VmError("instance_changed", "停止状态或宿主已变化，不继续启动");
    if (stopContext && !operationSucceeded(platform, stopped, stopContext, { platform, instance: stopped })) {
      throw new VmError("operation_unconfirmed", "本次停止尚未确认成功，不继续启动", { instance: stopped });
    }
    const response = await request("POST", `${instancePath(platform, id)}/start`, { timeoutMs: remaining() });
    requireSent(platform, id, response, "start");
    if (response.instance.id !== id) throw new VmError("instance_changed", "未确认同一实例启动，不等待其他实例", { response });
    phase = "wait";
    const result = await waitForOperation(platform, response, "ready", { ...opts, timeout: remaining() / 1000 });
    return { platform, operation: "restart", phase: "ready", status: result, warning: "沿用原实例启动/快照策略，不承诺保留运行期间的数据变化；未删除或重建实例" };
  } catch (err) {
    lifecycleError(platform, id, err);
    err.details = { ...err.details, phase, hint: "重启已中止，请用 status 核对当前状态；不会改派宿主、删除或重建。" };
    throw err;
  }
}

module.exports = { status, waitFor, waitForOperation, operate, dispatch, create, remove, listInstances, resolveInstance, restart };
