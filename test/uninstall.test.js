"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

it("uninstall CLI sends the exact target, returns JSON and reports API failures", async () => {
  const requests = [];
  let status = 200;
  let response = { success: true, serial: "device:123/usb", platform: "android", package_name: "com.example.demo", message: "卸载成功" };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, contentType: req.headers["content-type"], body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const invoke = (args) => execFile(process.execPath, [path.join(__dirname, "../bin/aiphone.js"), "devices", "uninstall", ...args], {
    env: { ...process.env, AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    timeout: 10000,
  });
  try {
    const { stdout, stderr } = await invoke(["device:123/usb", "com.example.demo"]);
    assert.deepEqual(JSON.parse(stdout), response);
    assert.equal(stderr, "");
    assert.deepEqual(requests[0], {
      method: "POST", path: "/api/devices/device%3A123%2Fusb/apps/uninstall",
      contentType: "application/json", body: { package_name: "com.example.demo" },
    });
    for (const [httpStatus, code, message] of [
      [400, "APP_NOT_FOUND", "应用不存在"],
      [409, "DEVICE_BUSY", "设备忙"],
      [504, "UNINSTALL_TIMEOUT", "卸载超时"],
    ]) {
      status = httpStatus;
      response = { detail: { code, message } };
      await assert.rejects(invoke(["device:123/usb", "com.example.demo"]), (err) => {
        assert.equal(err.code, 1);
        assert.equal(err.stdout, "");
        assert.ok(err.stderr.includes(`${code}: ${message}`));
        return true;
      });
    }
    const count = requests.length;
    await assert.rejects(invoke(["device:123/usb"]), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /missing required argument/);
      return true;
    });
    assert.equal(requests.length, count);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
