"use strict";

const { VmError } = require("./vm-client");

const STATES = new Set(["draft", "stopped", "starting", "running", "stopping", null]);
const ACTIONS = ["start", "stop", "dispatch", "delete", "edit", "copy"];

function lifecycle(instance) {
  // Missing means old Server; present-but-null/invalid must never fall back.
  if (!Object.hasOwn(instance, "lifecycle")) return {
    source: "legacy", state: instance.state, agent_online: null, actions: null,
    notice: "", error: instance.error_message || "",
  };
  const value = instance.lifecycle;
  if (!value || !STATES.has(value.state) || typeof value.agent_online !== "boolean" ||
      typeof value.notice !== "string" || typeof value.error !== "string" ||
      !value.actions || !ACTIONS.every((a) => typeof value.actions[a] === "boolean")) {
    return { source: "invalid", state: null, agent_online: false,
      actions: Object.fromEntries(ACTIONS.map((a) => [a, false])),
      notice: "服务端 lifecycle 不完整，无法确认机器状态或允许操作；请查询当前实例。", error: "" };
  }
  return { ...value, source: "server" };
}

function project(instance) {
  const view = lifecycle(instance);
  return { ...instance, lifecycle_state: view.state, lifecycle_source: view.source,
    ...(view.source === "legacy" ? {} : { allowed_actions: view.actions, lifecycle_notice: view.notice, lifecycle_error: view.error }) };
}

function requireAction(instance, action) {
  const view = lifecycle(instance);
  if (view.source === "legacy") return;
  if (view.source === "invalid") throw new VmError("invalid_lifecycle", view.notice, { instance });
  // The existing Stop API allows explicit idempotent Stop on a stopped guest.
  // Leave its ownership/occupation checks to that API, not a local exception.
  if (action === "stop" && view.state === "stopped" && view.agent_online) return;
  if (!view.actions[action]) throw new VmError("action_not_allowed", view.notice || `当前实例不允许 ${action} 操作`, {
    instance, action, lifecycle: view,
  });
}

module.exports = { lifecycle, project, requireAction };
