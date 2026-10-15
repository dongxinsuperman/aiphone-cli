"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_BASE_URL } = require("../lib/config");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("config", () => {
  it("does not embed a service host", () => {
    assert.equal(DEFAULT_BASE_URL, "");
  });

  it("shows empty configuration and refuses requests until a host is provided", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aiphone-oss-config-"));
    try {
      const env = { ...process.env, HOME: home, AIPHONE_BASE_URL: "" };
      const invoke = (args) => spawnSync(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), ...args], { env, encoding: "utf8", timeout: 10000 });
      const empty = invoke(["config", "get"]);
      assert.equal(empty.status, 0, empty.stderr);
      assert.equal(JSON.parse(empty.stdout).baseUrl, "");
      const request = invoke(["devices", "available"]);
      assert.equal(request.status, 1);
      assert.match(request.stderr, /尚未配置服务地址/);
      assert.equal(invoke(["config", "set", "--url", "http://127.0.0.1:8000"]).status, 0);
      assert.equal(JSON.parse(invoke(["config", "get"]).stdout).baseUrl, "http://127.0.0.1:8000");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
