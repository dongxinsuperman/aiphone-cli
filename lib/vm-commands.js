"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { InvalidArgumentError } = require("commander");
const { BASES, request, VmError, instancePath } = require("./vm-client");
const { createPlan, requireAlias } = require("./vm-create");
const catalog = require("./vm-catalog");
const service = require("./vm-service");
const { printJson } = require("./print");

function positive(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 86400) throw new InvalidArgumentError("请输入大于 0、不超过 86400 的秒数");
  return n;
}
function integer(min, max) { return (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new InvalidArgumentError(`请输入 ${min}–${max} 的整数`);
  return n;
}; }
function pagination(cmd) { return cmd.option("--offset <n>", "分页偏移", integer(0, 10000000), 0).option("--limit <n>", "每页条数", integer(1, 200), 30); }
function timeOptions(cmd) { return cmd.option("--timeout <seconds>", "等待上限秒数", positive, 180).option("--interval <seconds>", "轮询间隔秒数", positive, 2); }
function waiting(cmd) { return timeOptions(cmd.option("--wait", "等待操作完成，启动须确认可接单")); }
function listOptions(cmd) { return pagination(cmd.option("--q <text>", "按别名/实例 ID/机型搜索").option("--alias <name>", "按精确别名筛选").option("--state <state>", "按生命周期状态筛选").option("--agent <id>", "按所属 Agent 筛选")); }
function execute(action) { return async (...args) => {
  try { printJson(await action(...args)); }
  catch (err) { printJson({ ok: false, error: { code: err.code || "vm_error", message: err.message, ...(err.details || {}) } }); process.exitCode = 1; }
}; }

function registerVmCommands(program) {
  const vm = program.command("vm").description("三端受控预设创建与已有虚拟机管理");
  vm.command("fields").description("查看参数、后台约束及 Agent 调用说明").action(() => process.stdout.write(fs.readFileSync(path.join(__dirname, "../docs/vm-management.md"), "utf8")));
  listOptions(vm.command("list").description("跨平台查询已有虚拟机、数量与分页").option("--platform <platform>", "android/ios/harmony，缺省查三端"))
    .action(execute((opts) => {
      if (opts.platform && !BASES[opts.platform]) throw new VmError("invalid_platform", "平台须为 android/ios/harmony");
      return service.listInstances(opts.platform, opts);
    }));
  for (const platform of Object.keys(BASES)) {
    const cmd = vm.command(platform).description({ android: "Android Emulator", ios: "iOS Simulator", harmony: "鸿蒙 Emulator" }[platform]);
    listOptions(cmd.command("list").description("查询已有实例、数量、状态与所属 Agent"))
      .action(execute((opts) => service.listInstances(platform, opts)));
    cmd.command("get <idOrAlias>").description("按实例 ID 或精确别名查询；不猜测相近设备")
      .action(execute((id) => service.resolveInstance(platform, id)));
    cmd.command("status <idOrAlias>").description("查询 running、ready 与可接单状态")
      .action(execute(async (id) => service.status(platform, (await service.resolveInstance(platform, id)).id)));
    timeOptions(cmd.command("wait <idOrAlias>").description("只查询，等待可接单或停止").option("--until <state>", "ready/stopped", "ready"))
      .action(execute(async (id, opts) => {
        if (!["ready", "stopped"].includes(opts.until)) throw new VmError("invalid_input", "--until 只支持 ready/stopped");
        return service.waitFor(platform, (await service.resolveInstance(platform, id)).id, opts.until, opts);
      }));

    const search = pagination(cmd.command("catalog").description("查询可创建预设与兼容系统；只读，不探查 Agent")
      .option("--q <text>", "按机型名称/型号搜索").option("--category <type>", "设备类别，沿用后台目录").option("--os <version>", "按兼容系统版本筛选"));
    if (platform === "android") search.option("--brand <brand>", "品牌，如 xiaomi").option("--resolution <bucket>", "分辨率档，如 1080p").option("--ram <bucket>", "真机参考内存档，如 6-8G");
    search.action(execute((opts) => catalog.catalog(platform, opts)));
    cmd.command("preset <idOrName>").description("查看唯一预设、参考规格、固定模拟器规格和兼容系统")
      .action(execute(async (selector) => catalog.publicPreset(await catalog.resolvePreset(platform, selector))));
    cmd.command("systems <idOrName>").description("仅查询该预设允许选择的系统，不返回独立任意组合列表")
      .action(execute(async (selector) => {
        const preset = await catalog.resolvePreset(platform, selector);
        return { platform, preset: { id: preset.id, name: preset.name }, systems: preset.systems };
      }));

    waiting(cmd.command("create").description("只接受外部别名、目录预设和兼容系统；不接受完整 JSON")
      .requiredOption("--alias <name>", "外部必填且唯一，不自动生成")
      .option("--preset <idOrName>", "从 catalog 选择精确预设 ID 或名称")
      .option("--os <version>", "该预设兼容系统版本/ID，多选项时必须指定")
      .option("--agent <id>", "配合 --start 指定宿主，不改变所选配置")
      .option("--start", "创建后沿用后台探查与下发流程")
      .option("--dry-run", "只预览受控生成的参数，不创建或探查 Agent"))
      .action(execute(async (opts) => {
        if ((opts.wait || opts.agent) && !opts.start) throw new VmError("invalid_input", "--wait/--agent 需要同时指定 --start");
        const plan = await createPlan(platform, opts);
        return opts.dryRun ? { operation: "plan", ...plan } : service.create(platform, plan, opts);
      }));
    cmd.command("rename <idOrAlias>").description("只修改别名，不开放底层参数或完整 JSON").requiredOption("--alias <name>", "外部提供的新别名")
      .action(execute(async (id, opts) => {
        const alias = requireAlias(opts.alias);
        const instance = await service.resolveInstance(platform, id);
        return request("PATCH", instancePath(platform, instance.id), { body: { alias } });
      }));
    cmd.command("probe <idOrAlias>").description("沿用后台宿主探查；鸿蒙含临时创建验证，并非纯查询")
      .action(execute(async (id) => request("POST", `${instancePath(platform, (await service.resolveInstance(platform, id)).id)}/dispatch-candidates`)));
    waiting(cmd.command("dispatch <idOrAlias>").description("下发并启动；更换宿主可能返回新 ID").option("--agent <id>", "指定宿主，缺省从可承接候选中确定性选择"))
      .action(execute(async (id, opts) => {
        const instance = await service.resolveInstance(platform, id);
        const response = await service.dispatch(platform, instance.id, opts.agent);
        if (opts.wait) return { platform, response, status: await service.waitFor(platform, response.instance.id, "ready", opts) };
        return { platform, ...response, message: "已下发，尚未确认可接单，请用 status/wait 核对" };
      }));
    for (const action of ["start", "stop"]) {
      waiting(cmd.command(`${action} <idOrAlias>`).description(action === "start" ? "启动已有实例，沿用原配置及宿主" : "停止已有实例，--wait 确认 stopped"))
        .action(execute(async (id, opts) => {
          const instance = await service.resolveInstance(platform, id);
          const response = await request("POST", `${instancePath(platform, instance.id)}/${action}`);
          if (opts.wait) return { platform, response, status: await service.waitFor(platform, response.instance.id, action === "start" ? "ready" : "stopped", opts) };
          return { platform, ...response, message: "这是受理状态，实际完成请用 status/wait 核对" };
        }));
    }
    timeOptions(cmd.command("restart <idOrAlias>").description("停止同一实例→确认停止→原宿主启动→确认可接单；失败中止"))
      .action(execute(async (id, opts) => service.restart(platform, (await service.resolveInstance(platform, id)).id, opts)));
    cmd.command("delete <idOrAlias>").description("删除非活动实例配置；不隐式停机，不宣称宿主文件已清理")
      .action(execute(async (id) => service.remove(platform, (await service.resolveInstance(platform, id)).id)));
    if (platform === "android") for (const route of ["device-brands", "device-facets"]) {
      cmd.command(route).description(`查询后台 ${route}`).action(execute(() => request("GET", `${BASES.android}/${route}`)));
    }
    if (platform === "ios") cmd.command("health").description("仅查询服务端目录健康，非设备可用性")
      .action(execute(() => request("GET", `${BASES.ios}/health`)));
  }
}

module.exports = { registerVmCommands };
