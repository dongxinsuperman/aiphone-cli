#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const {
  DEFAULT_BASE_URL,
  getBaseUrl,
  setBaseUrl,
  getConfigPath,
  readConfigFile,
} = require("../lib/config");
const client = require("../lib/client");
const { buildReportsView } = require("../lib/reports");
const { printJson, printError } = require("../lib/print");

const pkg = require("../package.json");

function loadJsonFile(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    printError(err);
  }
}

const program = new Command()
  .name("aiphone")
  .description("ai-phone 对外 API CLI（匿名 /api/submissions）")
  .version(pkg.version)
  .addHelpText(
    "after",
    `
发现命令：aiphone --help | aiphone submissions --help | aiphone devices --help

典型流程：devices available → submissions submit → submissions get → submissions reports
Agent 说明见包内 AGENTS.md（npm 安装后在 node_modules/aiphone-cli/AGENTS.md）。
`,
  );

const configCmd = program.command("config").description("本地配置（~/.aiphone/config.json）");

configCmd
  .command("set")
  .description("设置 API 基址")
  .requiredOption("--url <baseUrl>", "例如 http://127.0.0.1:8000")
  .action((opts) => {
    const url = setBaseUrl(opts.url);
    printJson({ baseUrl: url, configPath: getConfigPath() });
  });

configCmd
  .command("get")
  .description("查看当前基址")
  .action(() => {
    printJson({
      baseUrl: getBaseUrl({ required: false }),
      configPath: getConfigPath(),
      file: readConfigFile(),
      envOverride: process.env.AIPHONE_BASE_URL || null,
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
  });

configCmd
  .command("path")
  .description("配置文件路径")
  .action(() => {
    process.stdout.write(`${getConfigPath()}\n`);
  });

const submissions = program.command("submissions").description("对外投递批次");

submissions
  .command("fields")
  .description("打印 POST /api/submissions 全部字段说明（与 external-api 对齐）")
  .action(() => {
    const docPath = path.join(__dirname, "..", "docs", "submission-fields.md");
    process.stdout.write(fs.readFileSync(docPath, "utf8"));
  });

submissions
  .command("submit")
  .description("POST /api/submissions（JSON 原样透传，支持全部可选字段）")
  .option("-f, --file <path>", "批次 JSON 文件（wrapper 对象）")
  .option("--stdin", "从标准输入读取 JSON（与 -f 二选一）")
  .action((opts) =>
    run(async () => {
      let body;
      if (opts.stdin) {
        const chunks = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          throw new Error("stdin 为空，请传入批次 JSON");
        }
        body = JSON.parse(raw);
      } else if (opts.file) {
        body = loadJsonFile(opts.file);
      } else {
        throw new Error("请指定 -f <file> 或 --stdin");
      }
      printJson(await client.submitBatch(body));
    }),
  );

submissions
  .command("reports <submissionId>")
  .description("按批次 id 汇总报告链接（相对路径已拼成可打开的全 URL）")
  .action((submissionId) =>
    run(async () => {
      const sub = await client.getSubmission(submissionId);
      printJson(buildReportsView(sub));
    }),
  );

submissions
  .command("get <submissionId>")
  .description("GET /api/submissions/{id}")
  .action((submissionId) =>
    run(async () => {
      printJson(await client.getSubmission(submissionId));
    }),
  );

submissions
  .command("item <submissionId> <caseId> <platform>")
  .description("GET /api/submissions/{id}/items/{caseId}/{platform}")
  .option("--include-run", "附带 Run / 步骤 / 日志（默认不附带）")
  .action((submissionId, caseId, platform, opts) =>
    run(async () => {
      printJson(
        await client.getSubmissionItem(submissionId, caseId, platform, opts.includeRun),
      );
    }),
  );

submissions
  .command("cancel <submissionId>")
  .description("POST /api/submissions/{id}/cancel")
  .action((submissionId) =>
    run(async () => {
      printJson(await client.cancelSubmission(submissionId));
    }),
  );

submissions
  .command("cancel-case <submissionId> <caseId>")
  .description("POST /api/submissions/{id}/cases/{caseId}/cancel")
  .requiredOption("--platform <platform>", "android | ios | harmony")
  .action((submissionId, caseId, opts) =>
    run(async () => {
      printJson(await client.cancelSubmissionCase(submissionId, caseId, opts.platform));
    }),
  );

const devicesCmd = program.command("devices").description("设备查询与 App 管理");

devicesCmd
  .command("available")
  .description("GET /api/devices/available（只返回可接单：agent 在线、ready、锁空闲）")
  .action(() =>
    run(async () => {
      printJson(await client.listDevicesAvailable());
    }),
  );

devicesCmd
  .command("statuses")
  .description("GET /api/devices/statuses（全量设备状态：含占用锁、effective_status、readiness）")
  .action(() =>
    run(async () => {
      printJson(await client.listDeviceStatuses());
    }),
  );

devicesCmd
  .command("uninstall <serial> <packageName>")
  .description("同步卸载 App（精确包名 / iOS Bundle ID，等待服务端确认结果）")
  .action((serial, packageName) =>
    run(async () => {
      printJson(await client.uninstallApp(serial, packageName));
    }),
  );

require("../lib/device-lock").registerDeviceLockCommands(devicesCmd);
require("../lib/vm-commands").registerVmCommands(program);
require("../lib/app-install").registerAppCommands(program);

program.parseAsync(process.argv).catch(printError);
