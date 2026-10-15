"use strict";

// VM management is additive: do not change the anonymous submission client.
const { getBaseUrl } = require("./config");

const BASES = {
  android: "/api/internal/vm",
  ios: "/api/internal/ios-sim",
  harmony: "/api/internal/harmony-vm",
};

class VmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function request(method, pathname, { body, query, timeoutMs = 75000 } = {}) {
  const url = new URL(pathname, `${getBaseUrl()}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers = { Accept: "application/json" };
  // Match the existing workbench: internal APIs use Bearer dev by default.
  // Do not send this header to public device/submission/install endpoints.
  if (pathname.startsWith("/api/internal/")) {
    headers.Authorization = `Bearer ${process.env.AIPHONE_INTERNAL_TOKEN || "dev"}`;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method, headers, signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch {
      throw new VmError("invalid_response", "模拟器接口未返回 JSON，请检查服务地址或代理", {
        http_status: response.status, outcome_unknown: method !== "GET",
        hint: method === "GET" ? "请检查服务地址或代理。" : "操作是否已生效未知，先 list/get 核对，不要直接重试。",
      });
    }
    if (!response.ok) {
      const detail = data?.detail;
      const code = detail?.code || detail?.reason || `http_${response.status}`;
      const message = typeof detail === "string" ? detail : detail?.message || data?.message || JSON.stringify(detail || data);
      throw new VmError(code, message, {
        http_status: response.status, response: data,
        ...(response.status >= 500 && method !== "GET" ? {
          outcome_unknown: true,
          hint: "服务端错误不保证操作未生效，请先 list/get 核对，不要直接重试。",
        } : {}),
        ...([401, 403].includes(response.status) ? {
          hint: "内部请求沿用后台 Bearer，默认 dev；如后台配置了其他值，请通过 AIPHONE_INTERNAL_TOKEN 提供相同值。",
        } : {}),
      });
    }
    return data;
  } catch (err) {
    if (err instanceof VmError) throw err;
    throw new VmError("request_failed", err.message, {
      method, path: pathname,
      outcome_unknown: method !== "GET",
      hint: method === "GET" ? "查询失败，可重新查询。" : "请求可能已被服务端受理，请先 list/get 核对，不要直接重试创建或删除。",
    });
  }
}

function instances(platform) { return `${BASES[platform]}/instances`; }
function instancePath(platform, id) { return `${instances(platform)}/${encodeURIComponent(id)}`; }

module.exports = { BASES, VmError, request, instances, instancePath };
