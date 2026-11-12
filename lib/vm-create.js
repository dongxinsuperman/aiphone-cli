"use strict";

const { VmError } = require("./vm-client");
const { resolvePreset, selectSystem, publicPreset } = require("./vm-catalog");
const DUO_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";

function requireAlias(value) {
  const alias = String(value || "").trim();
  if (!alias || alias.length > 128) throw new VmError("alias_required", "别名必须由外部提供，为 1–128 字符；不会自动生成");
  return alias;
}

async function createPlan(platform, opts) {
  const alias = requireAlias(opts.alias);
  const memory = opts.memory === undefined ? 3 : Number(opts.memory);
  if (platform !== "ios" && (!Number.isInteger(memory) || memory < 2 || memory > 32)) throw new VmError("invalid_input", "内存必须为 2–32 GB 的整数");
  const preset = await resolvePreset(platform, opts.preset);
  const { foldState, orientation } = opts;
  let systems = preset.systems;
  if (foldState !== undefined) {
    if (platform === "android") {
      if (!preset.foldable_api_level) throw new VmError("unsupported_fold_state", "该 Android 预设不支持折叠启动");
      systems = systems.filter((s) => s.api_level === preset.foldable_api_level);
    } else if (platform === "harmony" && preset.category !== "Foldable") {
      throw new VmError("unsupported_fold_state", "该鸿蒙预设不支持折叠启动");
    } else if (platform === "ios" && preset.id !== DUO_DEVICE_TYPE) {
      throw new VmError("unsupported_fold_state", "只有 iPhone Duo 支持折叠启动");
    }
  } else if (platform === "android" && !opts.os) {
    // Keep the same implicit choices for commands that predate Android 17.
    const previousSystems = systems.filter((s) => s.api_level <= 36);
    if (previousSystems.length) systems = previousSystems;
  }
  const system = selectSystem(preset, opts.os, systems);
  if (platform === "ios" && foldState !== undefined && system.only_device_type !== DUO_DEVICE_TYPE) {
    throw new VmError("unsupported_fold_state", "折叠启动需要 iPhone Duo 专用镜像");
  }
  const row = preset.source;
  let payload;
  if (platform === "android") {
    const spec = preset.vm_spec;
    const direction = orientation ?? "portrait";
    payload = { alias, name: alias, profile_ref_type: "real_device", profile_ref_id: preset.id, profile_id: preset.id, profile_name: preset.name,
      api_level: system.api_level, abi: "auto", system_type: "google_apis", system_image: "",
      screen_width: spec.screen_width, screen_height: spec.screen_height, density: spec.density, orientation: direction,
      config_json: {
        system: { api_level: system.api_level, system_type: "google_apis", abi: "auto" },
        display: { screen_width: spec.screen_width, screen_height: spec.screen_height, density: spec.density, orientation: direction, screen_size_in: String(row.screen_size_in || "").includes("x") ? "" : row.screen_size_in || "", cutout: "", shape_note: "" },
        performance: { ram_mb: memory * 1024, cpu_cores: 4, vm_heap_mb: 384, gpu_mode: "host" },
        storage: { internal_storage_mb: 8192, sdcard_mb: 0, wipe_data: false, snapshot_policy: "discard_changes" },
        network: { speed: "full", delay: "none", dns_server: "", http_proxy: "" },
        hardware: { back_camera: "emulated", front_camera: "none", gps: true, accelerometer: true, gyroscope: true, proximity: false, hardware_keyboard: false, navigation_style: "none" },
        startup: { no_window: true, no_audio: true, no_boot_anim: true, writable_system: false },
        identity: { brand: row.brand || "", model_code: row.model_code || "", marketing_name: row.marketing_name || "", source_type: row.source_type || "", verification_status: row.verification_status },
      } };
    if (foldState !== undefined) payload.fold_state = foldState;
  } else if (platform === "ios") {
    payload = { alias, device_type: preset.id, runtime: system.id };
    if (orientation !== undefined) payload.initial_orientation = orientation;
    if (foldState !== undefined) payload.initial_fold_state = foldState;
  } else {
    payload = { alias, name: alias, device_type: preset.category, image_id: system.id, os_version: system.version, api_version: system.api_version || "", abi: system.abi,
      screen_profile: preset.name, screen_width: row.width, screen_height: row.height, density: row.density,
      screen_size_in: String(row.size_in || ""), memory_gb: memory, storage_gb: 8, boot_mode: "cold", fold_state: foldState ?? "unfolded", config_json: { display: { mode: "profile" } } };
    if (orientation !== undefined) payload.initial_rotation = Number(orientation);
    if (preset.category === "Foldable") payload.config_json.folded_screen = { width: row.outer_width || 1080, height: row.outer_height || 2480, density: 480, size_in: String(row.outer_size_in || "6.4") };
  }
  const selectedPreset = publicPreset(preset);
  if (platform === "android") selectedPreset.vm_spec.ram_mb = memory * 1024;
  if (platform === "harmony") selectedPreset.vm_spec.memory_gb = memory;
  return { platform, alias, preset: selectedPreset, system, payload,
    policy: "按目录预设和兼容系统创建，可选启动方向、受支持的折叠形态和 Android/鸿蒙内存。不会按在线 Agent 自动选型。",
    availability_checked: false, warnings: ["目录兼容不代表宿主已安装或一定能启动；创建后沿用后台探查/下发流程"] };
}

module.exports = { createPlan, requireAlias };
