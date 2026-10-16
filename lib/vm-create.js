"use strict";

const { VmError } = require("./vm-client");
const { resolvePreset, selectSystem, publicPreset } = require("./vm-catalog");

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
  const system = selectSystem(preset, opts.os);
  const row = preset.source;
  let payload;
  if (platform === "android") {
    const spec = preset.vm_spec;
    payload = { alias, name: alias, profile_ref_type: "real_device", profile_ref_id: preset.id, profile_id: preset.id, profile_name: preset.name,
      api_level: system.api_level, abi: "auto", system_type: "google_apis", system_image: "",
      screen_width: spec.screen_width, screen_height: spec.screen_height, density: spec.density, orientation: "portrait",
      config_json: {
        system: { api_level: system.api_level, system_type: "google_apis", abi: "auto" },
        display: { screen_width: spec.screen_width, screen_height: spec.screen_height, density: spec.density, orientation: "portrait", screen_size_in: String(row.screen_size_in || "").includes("x") ? "" : row.screen_size_in || "", cutout: "", shape_note: "" },
        performance: { ram_mb: memory * 1024, cpu_cores: 4, vm_heap_mb: 384, gpu_mode: "host" },
        storage: { internal_storage_mb: 8192, sdcard_mb: 0, wipe_data: false, snapshot_policy: "discard_changes" },
        network: { speed: "full", delay: "none", dns_server: "", http_proxy: "" },
        hardware: { back_camera: "emulated", front_camera: "none", gps: true, accelerometer: true, gyroscope: true, proximity: false, hardware_keyboard: false, navigation_style: "none" },
        startup: { no_window: true, no_audio: true, no_boot_anim: true, writable_system: false },
        identity: { brand: row.brand || "", model_code: row.model_code || "", marketing_name: row.marketing_name || "", source_type: row.source_type || "", verification_status: row.verification_status },
      } };
  } else if (platform === "ios") payload = { alias, device_type: preset.id, runtime: system.id };
  else {
    payload = { alias, name: alias, device_type: preset.category, image_id: system.id, os_version: system.version, api_version: system.api_version || "", abi: system.abi,
      screen_profile: preset.name, screen_width: row.width, screen_height: row.height, density: row.density,
      screen_size_in: String(row.size_in || ""), memory_gb: memory, storage_gb: 8, boot_mode: "cold", fold_state: "unfolded", config_json: { display: { mode: "profile" } } };
    if (preset.category === "Foldable") payload.config_json.folded_screen = { width: row.outer_width || 1080, height: row.outer_height || 2480, density: 480, size_in: String(row.outer_size_in || "6.4") };
  }
  const selectedPreset = publicPreset(preset);
  if (platform === "android") selectedPreset.vm_spec.ram_mb = memory * 1024;
  if (platform === "harmony") selectedPreset.vm_spec.memory_gb = memory;
  return { platform, alias, preset: selectedPreset, system, payload,
    policy: "仅允许外部别名、目录预设、兼容系统版本和 Android/鸿蒙内存；其余参数固定。不会按在线 Agent 自动选型。",
    availability_checked: false, warnings: ["目录兼容不代表宿主已安装或一定能启动；创建后沿用后台探查/下发流程"] };
}

module.exports = { createPlan, requireAlias };
