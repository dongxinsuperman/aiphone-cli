# aiphone-cli

ai-phone **对外 API** 命令行工具。HTTP 契约以仓库根目录 `docs/external-api（对外调用清单）.md` 为准。

## 安装

此目录为独立开源准备目录，尚未发布。包名暂用 `aiphone-cli`，`private: true` 防止误发布；它不代表已登记的 npm 包名。

```bash
npm ci
node bin/aiphone.js --help
```

## 配置

默认服务地址为空。使用者自行部署 Server/Agent 后配置地址，写入 `~/.aiphone/config.json`；下面仅为本地地址示例：

```bash
aiphone config set --url http://127.0.0.1:8000
aiphone config get
```

临时覆盖（不写文件）：

```bash
export AIPHONE_BASE_URL=http://127.0.0.1:8000
```

## 投递与字段

`submissions submit` 将 JSON **原样 POST** 到服务端，与 `external-api` 文档字段一致（含全部可选项）。

```bash
aiphone submissions fields              # 字段速查
aiphone submissions submit -f examples/scenario-full-options.json
```

## 命令

| 命令 | 接口 |
|------|------|
| `aiphone submissions fields` | 投递字段说明（Markdown） |
| `aiphone submissions submit -f batch.json` | `POST /api/submissions`（透传） |
| `aiphone submissions get <id>` | `GET /api/submissions/{id}` |
| `aiphone submissions reports <id>` | 同上，但输出可打开的完整报告 URL |
| `aiphone submissions submit --stdin` | 从管道读 JSON 投递 |
| `aiphone submissions item <id> <caseId> <platform> [--include-run]` | `GET .../items/...` |
| `aiphone submissions cancel <id>` | `POST .../cancel` |
| `aiphone submissions cancel-case <id> <caseId> --platform ios` | `POST .../cases/.../cancel` |
| `aiphone devices available` | `GET /api/devices/available` |
| `aiphone devices statuses` | `GET /api/devices/statuses`（全量状态，含占用锁） |
| `aiphone devices uninstall <serial> <packageName>` | `POST /api/devices/{serial}/apps/uninstall`（同步卸载） |

卸载使用设备 `serial` 和精确包名（iOS 为 Bundle ID），平台由服务端识别：

```bash
aiphone devices uninstall <serial> com.example.demo
```

命令等待服务端完成查询、卸载及确认，成功时输出服务端 JSON；失败时输出错误并返回非零退出码。不创建批次，无需轮询。

示例批次见 `examples/smoke.json`（投递前请确认平台上有在线设备）。

## 安装包与分发安装

`aiphone apps --help` / `aiphone apps fields`。已有后台接口现已提供包查询、上传下载、适配设备查询、安装任务创建、查询等待和显式失败重试命令：

```bash
aiphone apps packages upload ./build.apk
aiphone apps packages eligible <packageId>
aiphone apps install <packageId> --serial <serial1> <serial2> --wait
aiphone apps tasks get <taskId>
aiphone apps tasks retry <taskId> --wait
```

上传不自动安装，安装不自动执行测试或操作虚拟机。done 不代表全成功；--wait 会检查每台结果并返回相应退出码。详见 [安装说明](docs/app-install.md)。

## 三端模拟器管理

新增独立入口 `aiphone vm android|ios|harmony`，原有命令不变。创建仅选择外部必填别名、后台设备预设和兼容系统版本，不接受完整 JSON 或自定义硬件参数：

```bash
aiphone vm android catalog --brand xiaomi --q 13
aiphone vm android preset <精确预设ID>
aiphone vm android create --alias 支付回归01 --preset <精确预设ID> --os 13 --dry-run
aiphone vm list --state running
aiphone vm android restart <实例ID或精确别名>
```

create 只创建配置；显式 --start --wait 才沿用后台探查下发并等待可接单。列表支持计数、筛选、分页；重启停止确认后才启动同一实例。详见 [模拟器管理说明](docs/vm-management.md)，或 `aiphone vm fields`。
虚拟机管理请求沿用后台已有 Bearer 请求头，默认 dev；可用 AIPHONE_INTERNAL_TOKEN 覆盖。旧公开命令不追加此请求头，也不修改服务端权限。示例不代表当前宿主支持这些配置。

## 本地开发与验证

```bash
npm install
npm link
node bin/aiphone.js --help
```

## 发布

尚不发布或全局安装。公开包名、发布账号及仓库确认后再配置公开发行；当前保留 `private: true`。功能代码来自公司版 0.3.0，Host 默认值、包元数据和公开文档单独维护，不附带任何部署脚本、凭据或公司默认地址。

## 设备占用管理

`devices lock/heartbeat/unlock/session` 用于 **直连设备前的必要占用**：通过 SSH 使用 ADB、HDC、WDA 前，先建立占用会话并确认 acquired，再开始直连；期间保持续期，失效或无法确认时停止外部操作，结束时先停操作再释放并确认。默认 TTL 120 秒、每 5 秒续期。长时间直连优先用 session，自行管理生命周期的脚本才拆用三个原子命令。锁仅约束平台调度，调用方负责停止独立直连命令；不重抢、不强制释放。完整命令、事件和失败处理见 [docs/device-lock.md](docs/device-lock.md)。
