"use strict";

const { getBaseUrl } = require("./config");

class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request(method, pathname, { query, body } = {}) {
  const base = getBaseUrl();
  const url = new URL(pathname.startsWith("/") ? pathname : `/${pathname}`, `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const init = {
    method,
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const detail = data?.detail;
    const msg =
      typeof detail === "string"
        ? detail
        : detail?.rejectReason
          ? `${detail.rejectReason}: ${detail.rejectDetail || ""}`.trim()
          : detail?.code
            ? `${detail.code}: ${detail.message || ""}`.trim()
            : data?.message || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, { status: res.status, body: data });
  }

  return data;
}

function submitBatch(payload) {
  return request("POST", "/api/submissions", { body: payload });
}

function getSubmission(submissionId) {
  return request("GET", `/api/submissions/${encodeURIComponent(submissionId)}`);
}

function getSubmissionItem(submissionId, caseId, platform, includeRun) {
  return request(
    "GET",
    `/api/submissions/${encodeURIComponent(submissionId)}/items/${encodeURIComponent(caseId)}/${encodeURIComponent(platform)}`,
    { query: { include_run: includeRun ? "true" : "false" } },
  );
}

function cancelSubmission(submissionId) {
  return request("POST", `/api/submissions/${encodeURIComponent(submissionId)}/cancel`);
}

function cancelSubmissionCase(submissionId, caseId, platform) {
  return request(
    "POST",
    `/api/submissions/${encodeURIComponent(submissionId)}/cases/${encodeURIComponent(caseId)}/cancel`,
    { query: { platform } },
  );
}

function listDevicesAvailable() {
  return request("GET", "/api/devices/available");
}

function listDeviceStatuses() {
  return request("GET", "/api/devices/statuses");
}

function uninstallApp(serial, packageName) {
  return request("POST", `/api/devices/${encodeURIComponent(serial)}/apps/uninstall`, {
    body: { package_name: packageName },
  });
}

module.exports = {
  ApiError,
  submitBatch,
  getSubmission,
  getSubmissionItem,
  cancelSubmission,
  cancelSubmissionCase,
  listDevicesAvailable,
  listDeviceStatuses,
  uninstallApp,
};
