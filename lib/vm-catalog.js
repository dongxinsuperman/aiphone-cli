"use strict";

const { BASES, request, VmError } = require("./vm-client");
const ANDROID_VERSIONS = { 21: "5.0", 22: "5.1", 23: "6.0", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16" };
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const number = (value) => Number(String(value ?? "").match(/\d+(?:\.\d+)?/)?.[0]) || 0;
const encodeVersion = (v) => String(v).split(".").slice(0, 3).reduce((sum, part, i) => sum + Number(part) * [65536, 256, 1][i], 0);
const androidSystem = (api) => ({ id: `api-${api}`, name: `Android ${ANDROID_VERSIONS[api]}`, version: ANDROID_VERSIONS[api], api_level: api });

function publicPreset(preset) { const { source, ...out } = preset; return out; }

function androidPreset(row) {
  if (row.verification_status !== "verified") return null;
  const apis = [...new Set((row.sdk_versions || []).map(number).filter((n) => ANDROID_VERSIONS[n]))].sort((a, b) => a - b);
  if (!apis.length) return null;
  const width = Number(row.screen_width || row.config_template?.display?.screen_width || 1080);
  const height = Number(row.screen_height || row.config_template?.display?.screen_height || 2400);
  const density = number(row.densities?.[0] || row.config_template?.display?.density) || 420;
  if (width < 320 || width > 7680 || height < 320 || height > 7680 || density < 120 || density > 800) return null;
  return { id: row.id, name: row.marketing_name || row.model_code || row.device || row.id,
    brand: row.brand || "", category: row.form_factor || "", model_code: row.model_code || "",
    reference_spec: { screen_width: row.screen_width, screen_height: row.screen_height, densities: row.densities || [], ram_mb: row.ram_mb || null, soc: row.soc || "" },
    vm_spec: { screen_width: width, screen_height: height, density, ram_mb: Math.min(Number(row.ram_mb) || 4096, 4096), cpu_cores: 4, storage_mb: 8192, abi: "auto", system_type: "google_apis" },
    systems: apis.map(androidSystem), source: row,
    note: "设备画像近似，不复刻厂商 ROM；reference_spec 为真机参考，vm_spec 为固定模拟器配置" };
}

function officialPresets(platform, catalog) {
  if (platform === "ios") return (catalog.device_types || []).map((row) => ({
    id: row.identifier, name: row.name, category: row.product_family,
    reference_spec: { model_identifier: row.model_identifier || "" },
    vm_spec: { hardware: "由 Apple 官方机型固定，不开放 CPU/RAM/屏幕自定义" },
    systems: (catalog.official_runtimes || []).filter((r) => {
      const v = encodeVersion(r.version);
      return v > 0 && v >= (row.min_runtime_version || 0) && v <= (row.max_runtime_version || 4294967295);
    }).map((r) => ({ id: r.identifier, name: r.name, version: r.version })), source: row,
  })).filter((p) => p.systems.length);
  return (catalog.screen_profiles || []).map((row) => ({
    id: row.id || `${row.device_type}|${row.name}`, name: row.name, category: row.device_type,
    vm_spec: { screen_width: row.width, screen_height: row.height, density: row.density, memory_gb: 4, storage_gb: 8, boot_mode: "cold", fold_state: "unfolded" },
    systems: (catalog.images || []).filter((i) => i.creatable !== false && i.device_type === row.device_type && (row.supported_image_ids || []).includes(i.id) && row.create_methods?.[i.id])
      .map((i) => ({ id: i.id, name: i.os_version, version: i.os_version, api_version: i.api_version, abi: i.abi || "auto", create_method: row.create_methods[i.id] })), source: row,
  })).filter((p) => p.systems.length);
}

function pageResult(items, total, offset, limit, extra = {}) {
  return { items: items.map(publicPreset), page: { offset, limit, returned: items.length, total, has_more: offset + items.length < total }, ...extra };
}

async function catalog(platform, opts = {}) {
  const offset = opts.offset ?? 0, limit = opts.limit ?? 30;
  if (platform === "android") {
    let sdk;
    if (opts.os) {
      const sys = Object.keys(ANDROID_VERSIONS).map(Number).map(androidSystem).find((s) => [s.id, s.name, s.version, `API ${s.api_level}`].some((v) => same(v, opts.os)));
      if (!sys) throw new VmError("invalid_system", "请选择后台支持的 Android 版本或 api-N 标识");
      sdk = sys.api_level;
    }
    const data = await request("GET", `${BASES.android}/device-profiles`, { query: { q: opts.q, brand: opts.brand, form_factor: opts.category, sdk, resolution: opts.resolution, ram: opts.ram, offset, limit } });
    const rows = (data.items || []).map(androidPreset).filter(Boolean);
    return { ...pageResult(rows, data.page?.total ?? rows.length, offset, limit), page: { ...(data.page || {}), offset, limit, returned: rows.length, total: data.page?.total ?? rows.length, has_more: Boolean(data.page?.has_more) }, source_stats: data.stats || {}, omitted_invalid_rows: (data.items || []).length - rows.length, availability_checked: false };
  }
  const data = await request("GET", `${BASES[platform]}/catalog`);
  const rows = officialPresets(platform, data).filter((p) =>
    (!opts.q || [p.name, p.id].some((v) => String(v).toLowerCase().includes(opts.q.toLowerCase()))) &&
    (!opts.category || same(p.category, opts.category)) &&
    (!opts.os || p.systems.some((s) => [s.id, s.name, s.version].some((v) => same(v, opts.os))))
  );
  return pageResult(rows.slice(offset, offset + limit), rows.length, offset, limit, { availability_checked: false });
}

async function resolvePreset(platform, selector) {
  if (!selector?.trim()) throw new VmError("preset_required", "请先 catalog 搜索，再提供 --preset 精确名称或 ID；不会自动选择机型");
  let rows;
  if (platform === "android") {
    // No profile-by-ID endpoint exists; ID lookup enumerates the existing paged API.
    const load = async (q) => {
      const found = []; let offset = 0;
      while (true) {
        const data = await request("GET", `${BASES.android}/device-profiles`, { query: { q, offset, limit: 200 } });
        const page = data.items || [];
        found.push(...page.map(androidPreset).filter(Boolean));
        if (!data.page?.has_more) break;
        if (!page.length) throw new VmError("invalid_catalog", "设备目录分页没有推进，请检查服务端返回");
        offset += page.length;
      }
      return found;
    };
    rows = await load(selector);
    if (!rows.some((p) => [p.id, p.name, p.model_code, p.source.device].some((v) => v && same(v, selector))) && /^[\w.:-]{1,64}$/.test(selector)) rows = await load(undefined);
  } else rows = officialPresets(platform, await request("GET", `${BASES[platform]}/catalog`));
  const matches = rows.filter((p) => [p.id, p.name, p.model_code, p.source.device].some((v) => v && same(v, selector)));
  if (matches.length !== 1) throw new VmError(matches.length ? "ambiguous_preset" : "preset_not_found", matches.length ? "匹配多个预设，请选择精确 ID" : "没有匹配的可创建预设，不会替换成相近机型", { requested: selector, count: matches.length, candidates: matches.slice(0, 30).map(publicPreset) });
  return matches[0];
}

function selectSystem(preset, value) {
  const matches = value ? preset.systems.filter((s) => [s.id, s.name, s.version, ...(s.api_level ? [`API ${s.api_level}`] : [])].some((v) => v && same(v, value))) : preset.systems;
  if (matches.length !== 1) throw new VmError(value && !matches.length ? "incompatible_system" : "system_selection_required", value && !matches.length ? "该预设不支持指定系统，不允许自由组合" : "请选择该预设支持的系统版本，不会自动选择最新版本", { preset: { id: preset.id, name: preset.name }, systems: preset.systems });
  return matches[0];
}

module.exports = { catalog, resolvePreset, selectSystem, publicPreset };
