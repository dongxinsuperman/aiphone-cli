"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { InvalidArgumentError } = require("commander");
const { getBaseUrl } = require("./config");
const { ApiError } = require("./client");
const { printJson, printError } = require("./print");

const BASE = "/api/app-install";
const encoded = encodeURIComponent;

async function response(method, endpoint, opts = {}) {
  try {
    const res = await fetch(new URL(endpoint, `${getBaseUrl()}/`), {
      method, signal: AbortSignal.timeout(opts.timeoutMs || 300000),
      headers: { Accept: "application/json", ...opts.headers },
      ...(opts.body === undefined ? {} : { body: opts.body }),
      ...(opts.stream ? { duplex: "half" } : {}),
    });
    if (!res.ok) {
      let data;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = { message: text || res.statusText }; }
      const detail = data.detail;
      const message = typeof detail === "string" ? detail : detail?.message || data.message || JSON.stringify(detail || data);
      throw new ApiError(message, { status: res.status, body: data });
    }
    return res;
  } catch (err) {
    if (method !== "GET") err.message += "；若服务端已受理，请先查询包/任务记录，不要直接重复提交";
    throw err;
  }
}

async function jsonRequest(method, endpoint, body, timeoutMs) {
  const res = await response(method, endpoint, {
    timeoutMs,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  try { return await res.json(); }
  catch { throw new Error(`接口未返回有效 JSON，请检查服务地址${method !== "GET" ? "，先查询记录再决定是否重试" : ""}`); }
}

async function upload(file) {
  const localPath = path.resolve(file);
  const stat = await fsp.stat(localPath);
  if (!stat.isFile() || !stat.size) throw new Error("安装包必须是非空文件；iOS Simulator 的 .app 目录请先压成 zip");
  const boundary = `aiphone-${randomUUID()}`;
  const filename = path.basename(localPath).replace(/[^\x20-\x7e]|["\\]/g, "_");
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from((async function* () {
    yield prefix;
    for await (const chunk of fs.createReadStream(localPath)) yield chunk;
    yield suffix;
  })());
  try {
    const res = await response("POST", `${BASE}/packages`, {
      stream: true, body,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(prefix.length + stat.size + suffix.length) },
    });
    try { return await res.json(); }
    catch { throw new Error("上传响应不是有效 JSON，请先 packages list 核对，勿重复上传"); }
  } finally { body.destroy(); }
}

async function download(packageId, output) {
  const outputPath = path.resolve(output);
  const handle = await fsp.open(outputPath, "wx");
  let complete = false, bytes = 0;
  try {
    const res = await response("GET", `${BASE}/packages/${encoded(packageId)}/download`);
    if (!res.body) throw new Error("下载响应为空");
    for await (const chunk of res.body) { await handle.writeFile(chunk); bytes += chunk.byteLength; }
    complete = true;
    return { package_id: packageId, path: outputPath, bytes };
  } finally {
    await handle.close();
    if (!complete) await fsp.unlink(outputPath);
  }
}

const getTask = (id, timeoutMs) => jsonRequest("GET", `${BASE}/tasks/${encoded(id)}`, undefined, timeoutMs);

function successful(task) {
  return task.state === "done" && Array.isArray(task.items) && task.items.length > 0 && task.items.every((item) => item.state === "success");
}

async function waitTask(id, opts) {
  const deadline = Date.now() + opts.timeout * 1000;
  let task;
  while (Date.now() < deadline) {
    try { task = await getTask(id, Math.max(1, deadline - Date.now())); }
    catch (err) { err.task = task; throw err; }
    if (task.state === "done") return task;
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.interval * 1000, Math.max(0, deadline - Date.now()))));
  }
  const err = new Error(`等待安装任务 ${id} 超时；任务可能仍在运行，请继续 tasks get/wait，不自动重试安装`);
  err.task = task;
  throw err;
}

async function printTask(task, opts = {}) {
  if (opts.wait && task.state !== "done") {
    try { task = await waitTask(task.id, opts); }
    catch (err) { if (!err.task) err.task = task; throw err; }
  }
  printJson(task);
  if (task.state === "done" && !successful(task)) process.exitCode = 1;
}

function positive(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 86400) throw new InvalidArgumentError("请输入大于 0、不超过 86400 的秒数");
  return n;
}
function timeOptions(cmd) { return cmd.option("--timeout <seconds>", "本地等待上限，不修改服务端安装超时", positive, 900).option("--interval <seconds>", "轮询间隔", positive, 2); }
function waiting(cmd) { return timeOptions(cmd.option("--wait", "等待安装终态并按每台设备结果返回退出码")); }
function run(action) { return async (...args) => {
  try { await action(...args); }
  catch (err) { if (err.task) printJson(err.task); printError(err); }
}; }

function registerAppCommands(program) {
  const apps = program.command("apps").description("安装包与分发安装（已有后台接口）");
  apps.command("fields").description("包类型、安装流程和结果判定说明")
    .action(() => process.stdout.write(fs.readFileSync(path.join(__dirname, "../docs/app-install.md"), "utf8")));
  const packages = apps.command("packages").description("安装包管理");
  packages.command("list").description("查询已上传包及 package ID")
    .action(run(async () => printJson(await jsonRequest("GET", `${BASE}/packages`))));
  packages.command("upload <file>").description("上传本地包文件，流式 multipart；不执行安装")
    .action(run(async (file) => printJson(await upload(file))));
  packages.command("download <packageId>").description("下载已有包到新文件，不覆盖现有文件").requiredOption("-o, --output <file>", "输出文件路径")
    .action(run(async (id, opts) => printJson(await download(id, opts.output))));
  packages.command("eligible <packageId>").description("查询该包当前可安装的设备 serial/alias；不会安装")
    .action(run(async (id) => printJson(await jsonRequest("GET", `${BASE}/packages/${encoded(id)}/eligible-devices`))));
  waiting(apps.command("install <packageId>").description("将已有包分发到明确指定的设备；不会自动全选设备")
    .requiredOption("--serial <serials...>", "一个或多个精确设备 serial，空格分隔"))
    .action(run(async (id, opts) => {
      const serials = [...new Set(opts.serial.map((s) => s.trim()))];
      if (!id.trim() || serials.some((s) => !s)) throw new Error("packageId 与 serial 不能为空");
      const task = await jsonRequest("POST", `${BASE}/tasks`, { package_id: id, serials });
      await printTask(task, opts);
    }));
  const tasks = apps.command("tasks").description("安装任务查询与显式重试");
  tasks.command("get <taskId>").description("查询原始任务、逐台结果与汇总；done 不代表全成功")
    .action(run(async (id) => printJson(await getTask(id))));
  timeOptions(tasks.command("wait <taskId>").description("等待终态；仅全部设备 success 才返回退出码 0"))
    .action(run(async (id, opts) => printTask(await waitTask(id, opts))));
  waiting(tasks.command("retry <taskId>").description("显式调用 retry-unsuccessful，仅重试失败/超时/未知项"))
    .action(run(async (id, opts) => printTask(await jsonRequest("POST", `${BASE}/tasks/${encoded(id)}/retry-unsuccessful`), opts)));
}

module.exports = { registerAppCommands };
