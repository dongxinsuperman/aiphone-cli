"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

it("item CLI explicitly selects whether to include execution details", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, includeRun: url.searchParams.get("include_run") });
    // Match the real API's default: omitted include_run returns details.
    const includeRun = url.searchParams.get("include_run") !== "false";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      item: { case_id: "c1", state: "success" },
      run: includeRun ? { id: "run1" } : null,
      steps: includeRun ? [{ step: 1 }] : [],
      logs: includeRun ? [{ message: "done" }] : [],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const includeRun of [false, true]) {
      const args = [path.join(__dirname, "../bin/aiphone.js"), "submissions", "item", "batch1", "c1", "android"];
      if (includeRun) args.push("--include-run");
      const { stdout } = await execFile(process.execPath, args, {
        env: { ...process.env, AIPHONE_BASE_URL: `http://127.0.0.1:${server.address().port}` },
        timeout: 10000,
      });
      const result = JSON.parse(stdout);
      assert.deepEqual(requests.at(-1), {
        method: "GET",
        path: "/api/submissions/batch1/items/c1/android",
        includeRun: String(includeRun),
      });
      assert.equal(result.item.state, "success");
      assert.deepEqual(result.run, includeRun ? { id: "run1" } : null);
      assert.equal(result.steps.length, includeRun ? 1 : 0);
      assert.equal(result.logs.length, includeRun ? 1 : 0);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
