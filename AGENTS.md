# aiphone-cli（Agent 使用说明）

安装后命令名为 `aiphone`。**发现子命令**：`aiphone --help`、`aiphone submissions --help`。

**字段真相源**：对应 ai-phone Server 仓库的 `docs/external-api（对外调用清单）.md`。
CLI 对 `submit` 是 **JSON 原样透传**，不删、不改可选字段；本地可查：

```bash
aiphone submissions fields   # 投递字段速查（与 external-api 对齐）
```

完整示例（含全部常用可选项）：`examples/scenario-full-options.json`。

## 1. 前置（一次性）

```bash
# 此目录尚未公开发包；本地使用 node bin/aiphone.js 代替 aiphone
aiphone config set --url http://127.0.0.1:8000
```

环境变量 `AIPHONE_BASE_URL` 可临时覆盖 config，不写文件。

## 2. 推荐调用顺序

```bash
aiphone devices available                    # 投递前看各端是否有 ready 设备
aiphone submissions submit -f batch.json   # 或 echo '{...}' | aiphone submissions submit --stdin
# 记下响应里的 submissionId
aiphone submissions get <submissionId>       # 轮询 state / counts
aiphone submissions reports <submissionId>   # 终态后拿汇总 + 单条报告全 URL
```

## 3. 投递字段（必填 / 可选）

### 顶层（均可选，除 `items`）

| 字段 | 必填 | CLI 是否支持 |
|------|------|----------------|
| `items` | 是 | ✅ 透传 |
| `submissionName` | 否 | ✅ |
| `callbackUrl` | 否 | ✅ |
| `cacheMode` | 否 | ✅ 批次默认 `off`/`v1`/`v2`/`v3` |
| `retryMax` | 否 | ✅ |
| `functionMapContext` | 否 | ✅ 批次级执行参考 |

### items[] 每条

| 字段 | 必填 | CLI 是否支持 |
|------|------|----------------|
| `caseId` | 是 | ✅ |
| `runContent` | 是 | ✅ |
| `platforms` | 是 | ✅ |
| `caseName` | 否 | ✅ |
| `functionMapContext` | 否 | ✅ **item 级执行参考**（展开到该 item 各平台单元，与批次级合并） |
| `deviceAliasPools` | 否 | ✅ 含 `null`/`[]` 全池语义 |
| `cacheMode` | 否 | ✅ 覆盖批次级 |

**未在 CLI 单独做 flag 的字段，一律写在 JSON 里 `submit` 即可。**

`functionMapContext` 合并：只传顶层→全体单元用顶层文本；只传 item→仅该 item 单元用 item 文本；两层都传→顶层 + item 拼接。详见 `aiphone submissions fields`。

## 4. 批次 JSON 核心规则

- 顶层 wrapper：`{ submissionName?, callbackUrl?, cacheMode?, retryMax?, functionMapContext?, items: [...] }`
- 每个 **raw item** 一条业务 case；`platforms` 非空数组，服务端会 **按平台展开**：
  - 一条 item 写 `"platforms": ["android","ios","harmony"]` → 产生 **3 条执行单元**（同一 caseId 跑三端各一次）
  - 写 `"platforms": ["android"]` → 只跑 Android **1 次**
- 20 个 case × 三端各跑一遍 = `items` 里 **20 条**，每条 `platforms` 含三端 → 共 **60** 个执行单元
- **三端均分 20 个 case**（约 7+7+6）：API **不会**自动均分；Agent 自行拆成 20 条 item，每条 `platforms` 只含一个端，例如前 7 条仅 android、中 7 条仅 ios、后 6 条仅 harmony

投递前建议 `aiphone devices available`，避免 `no_device_on_platform`。

## 5. 场景对照

| 用户意图 | items 写法 | 执行单元数（20 case） |
|----------|------------|------------------------|
| 每个 case 三端各跑一次 | 20 条，每条 `platforms: ["android","ios","harmony"]` | 60 |
| 全部只跑 Android | 20 条，每条 `platforms: ["android"]` | 20 |
| 三端均分 case | 20 条，每条 `platforms` 单元素，按 case 分配端 | 20 |
| 锁某台设备 | 对应平台在 `deviceAliasPools` 写别名数组 | 见 external-api §2 |

示例文件：

- `examples/scenario-all-platforms.json` — 2 case 演示三端展开（可改成 20 条）
- `examples/scenario-android-only.json`
- `examples/scenario-split-by-platform.json` — 均分模式
- `examples/scenario-full-options.json` — 含 callback、批次级 + item 级 functionMapContext、deviceAliasPools、item 级 cacheMode

## 6. 命令清单（对外 API）

| 命令 | 用途 |
|------|------|
| `aiphone config set/get/path` | API 基址 |
| `aiphone devices available` | 可接单设备（别名、平台、serial） |
| `aiphone devices statuses` | 全量设备状态（含占用锁、effective_status、readiness） |
| `aiphone devices uninstall <serial> <packageName>` | 同步卸载 App；使用 serial 和精确包名（iOS Bundle ID），平台由服务端识别，等待确认结果 |
| `aiphone submissions fields` | 投递字段速查 |
| `aiphone submissions submit -f <file>` | 投递（JSON 透传） |
| `aiphone submissions submit --stdin` | 从管道读 JSON（适合 Agent 生成后直投） |
| `aiphone submissions get <id>` | 批次状态 + items + 相对 report_url |
| `aiphone submissions reports <id>` | **报告专视图**：summary + 每条可打开的完整 URL |
| `aiphone submissions item <id> <caseId> <platform> [--include-run]` | 单条排障 |
| `aiphone submissions cancel <id>` | 整批取消 |
| `aiphone submissions cancel-case <id> <caseId> --platform <p>` | 单条取消 |

## 7. 报告

- `submissions get` 返回的 `summary_report_url`、`items[].report_url` 为 **相对路径**
- `submissions reports <id>` 已拼上 config 里的 baseUrl，可直接浏览器打开
- 批次 `state` 为 `done` / `cancelled` 后汇总报告才稳定；进行中可轮询 `get`

## 8. Agent 拼 batch 流程（20 case 三端各跑）

1. `aiphone devices available`
2. 生成 `batch.json`：`items` 长度 20，每项含 `caseId`、`runContent`、`platforms: ["android","ios","harmony"]`
3. `aiphone submissions submit -f batch.json` → 保存 `submissionId`
4. 循环 `aiphone submissions get <id>` 直到 `state` 非 `accepted`
5. `aiphone submissions reports <id>` → 把 `summary_report_url` 交给用户

## 9. 调试

`AIPHONE_DEBUG=1` 可在 API 错误时打印完整响应体。

## 10. 三端虚拟机：受控创建与已有实例管理

`aiphone vm --help` / `aiphone vm fields`。完整策略见 [docs/vm-management.md](docs/vm-management.md)。
创建只接受平台、外部必填别名、后台设备预设和兼容系统版本。先 catalog 搜索，再 preset/systems 查规格和合法组合；不生成别名、不自动选型、不接受完整 JSON 或任意底层参数。
用户仅要求创建时使用 create；明确启动需求才加 --start --wait，沿用后台创建后探查流程，不预先枚举所有 Agent 支持的设备。
vm list 查询已有实例及数量，支持平台/别名/Agent/状态/分页；get/status/start/stop/restart/delete 按 ID 或精确别名操作。restart 停止并确认后才启动同一实例，被占用或失败就中止。
只有 schedulable=true 才报告可接单。失败保留已创建 ID，不重复 create；不自动删设备或改派宿主。
原有 devices/submissions 主流程不变。内部虚拟机管理请求沿用后台 Bearer，默认 dev，可用 AIPHONE_INTERNAL_TOKEN 覆盖；公开请求不追加此头，不修改服务端权限。

新版 Server 有 lifecycle 时以它的机器状态和 actions 为准，历史 error 单独展示；state:null 表示无法确认，不能回退原始 state。只有完全缺少 lifecycle 的旧 Server 才走旧判断。list --state unknown 查询未知实例。命令等待仍关联本次操作结果，不能用后来出现的 stopped 覆盖一次失败的 stop 并继续 restart。

## 11. 安装包与分发安装

`aiphone apps --help` / `aiphone apps fields`，详见 [docs/app-install.md](docs/app-install.md)。
upload 仅上传并返回 package ID；先 packages eligible 查询可安装设备，再 install --serial 明确指定目标。不自动全选、不将包 ID 当应用包名。
install/retry 可用 --wait；tasks get 原样查询，tasks wait 等待并检查逐台 success。done 可能含失败；等待失败保留已知 task ID，不自动重试。
APK、HAP/App Pack、真机 IPA、Simulator .app.zip 各走现有平台通道。卸载仍用 devices uninstall。
不改变现有投递流程，不新增自动建机、安装、执行、销毁编排。
