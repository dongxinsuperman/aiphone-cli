"use strict";

const { InvalidArgumentError } = require("commander");
const { getBaseUrl } = require("./config");
const { printJson } = require("./print");

function text(value) {
  if (!value.trim()) throw new InvalidArgumentError("必须为非空字符串");
  return value;
}
function seconds(min, max) { return value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new InvalidArgumentError(`秒数范围为 ${min}–${max}`);
  return n;
}; }
async function request(operation, serial, body, timeoutMs = 10000) {
  const endpoint = `/api/devices/${encodeURIComponent(serial)}/${operation === "heartbeat" ? "heartbeat" : "lock"}`;
  const res = await fetch(new URL(endpoint, `${getBaseUrl()}/`), {
    method: operation === "unlock" ? "DELETE" : "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("接口未返回有效 JSON；请查询设备锁状态，不要自动重试"); }
  if (!res.ok) {
    const error = new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data));
    error.status = res.status; error.body = data; throw error;
  }
  return data;
}
const acquireBody = opts => ({ holder: opts.holder, holder_type: opts.holderType, ttl_seconds: opts.ttl });
function failure(err, extra = {}) {
  return { error: { code: err.status ? `http_${err.status}` : "request_failed", message: err.message, ...(err.status ? { status: err.status, detail: err.body } : {}), ...extra } };
}
async function session(serial, opts) {
  if (opts.interval >= opts.ttl) throw new Error("续期间隔必须小于 TTL");
  let stopped = false, wake, token, lock, deadline, failed = false;
  const now = () => performance.now();
  const stop = () => { stopped = true; if (wake) wake(); };
  const emit = data => printJson({ serial, ...data }, { pretty: false });
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    let started = now();
    lock = await request("lock", serial, acquireBody(opts), Math.min(10000, opts.ttl * 1000 / 3));
    token = lock.token;
    if (!token || !Number.isFinite(lock.ttl_seconds) || lock.ttl_seconds <= 0) throw new Error("占用响应缺少 token 或有效 TTL，无法确认占用权");
    deadline = started + lock.ttl_seconds * 1000;
    if (opts.interval * 1000 >= lock.ttl_seconds * 1000) throw new Error("服务端沿用的 TTL 不大于续期间隔，无法维持会话");
    if (now() >= deadline) throw new Error("申请响应已超过 TTL，无法确认占用权");
    emit({ event: "acquired", holds_lock: true, lock });
    while (!stopped) {
      await new Promise(resolve => {
        const timer = setTimeout(done, Math.min(opts.interval * 1000, Math.max(0, deadline - now())));
        function done() { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
      });
      if (stopped) break;
      if (now() >= deadline) throw new Error("已超过已确认的占用有效期");
      started = now();
      lock = await request("heartbeat", serial, { token }, Math.min(10000, deadline - started, lock.ttl_seconds * 1000 / 3));
      if (!Number.isFinite(lock.ttl_seconds) || lock.ttl_seconds <= 0 || now() >= deadline) throw new Error("未能在占用有效期内确认续期");
      deadline = started + lock.ttl_seconds * 1000;
      emit({ event: "renewed", holds_lock: true, lock });
    }
  } catch (err) {
    failed = true;
    emit({ event: token ? "lost" : "acquire_failed", holds_lock: false, ...failure(err, { hint: "占用权无法保证，外部操作应停止；不会自动重抢" }) });
  } finally {
    if (token) {
      try {
        const result = await request("unlock", serial, { token, force: false });
        emit({ event: "released", holds_lock: false, ...result });
      } catch (err) {
        failed = true;
        emit({ event: "release_failed", holds_lock: false, ...failure(err, { hint: "未确认释放；不强制解锁，由服务端 TTL 过期" }) });
      }
    }
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
  if (failed) process.exitCode = 1;
}
function registerDeviceLockCommands(devices) {
  const execute = action => async (...args) => {
    try { await action(...args); }
    catch (err) { printJson(failure(err)); process.exitCode = 1; }
  };
  function acquireOptions(cmd) {
    return cmd.requiredOption("--holder <id>", "本次调用方的唯一标识", text)
      .option("--holder-type <type>", "展示标签：session/job/webhook/manual/auto", value => {
        if (!["session", "job", "webhook", "manual", "auto"].includes(value)) throw new InvalidArgumentError("不支持的 holder-type");
        return value;
      }, "session").option("--ttl <seconds>", "占用 TTL 秒数，3–300，默认 120", seconds(3, 300), 120);
  }
  acquireOptions(devices.command("lock <serial>").description("申请设备占用，只申请一次并返回 token"))
    .action(execute(async (serial, opts) => printJson(await request("lock", serial, acquireBody(opts)))));
  devices.command("heartbeat <serial>").description("凭 token 续期一次，不自动重试")
    .requiredOption("--token <token>", "申请返回的 token", text)
    .action(execute(async (serial, opts) => printJson(await request("heartbeat", serial, { token: opts.token }))));
  devices.command("unlock <serial>").description("只释放自己持有的锁，不提供强制释放")
    .requiredOption("--token <token>", "申请返回的 token", text)
    .action(execute(async (serial, opts) => printJson(await request("unlock", serial, { token: opts.token, force: false }))));
  acquireOptions(devices.command("session <serial>").description("持续占用，JSONL 事件；Ctrl+C/SIGTERM 尝试释放"))
    .option("--interval <seconds>", "续期间隔，默认 5 秒，必须小于实际 TTL", seconds(0.1, 299), 5)
    .action(execute(session));
}
module.exports = { registerDeviceLockCommands };
