# 安装包与分发安装 CLI

`aiphone apps` 封装现有 `/api/app-install` 接口，不改变虚拟机、卸载、测试投递命令，不新增后台编排或设备占用机制。

| 命令 | 接口 / 行为 |
|---|---|
| `apps packages list` | GET /api/app-install/packages，查询已有包及 package ID |
| `apps packages upload <file>` | POST /api/app-install/packages，流式 multipart 的 file 字段；上传成功不等于安装 |
| `apps packages download <packageId> -o <file>` | GET /api/app-install/packages/{id}/download；写入新文件，不覆盖已有文件 |
| `apps packages eligible <packageId>` | GET /api/app-install/packages/{id}/eligible-devices；查询该包当前可安装设备 |
| `apps install <packageId> --serial <serial1> <serial2>` | POST /api/app-install/tasks，发送 package_id 和明确指定的 serials |
| `apps tasks get <taskId>` | GET /api/app-install/tasks/{id}，原样查询任务、逐台结果及汇总 |
| `apps tasks wait <taskId>` | 只轮询上述 GET，等待终态并检查是否每台 success |
| `apps tasks retry <taskId>` | POST /api/app-install/tasks/{id}/retry-unsuccessful，显式重试失败/超时/未知项 |

## 常用调用

```bash
aiphone apps packages upload ./build.apk
# 从响应记下 package ID
aiphone apps packages eligible <packageId>
# 选择明确的设备 serial；不会自动全选或匹配别名
aiphone apps install <packageId> --serial <serial1> <serial2> --wait
# 或记下 task ID 后分别查询、等待
aiphone apps tasks get <taskId>
aiphone apps tasks wait <taskId>
# 用户明确要求重试时才调用
aiphone apps tasks retry <taskId> --wait
```

install 和 retry 可选 --wait；不传时只返回受理结果，不等安装完成。
wait 默认本地等待 900 秒、每 2 秒查询，可用 --timeout/--interval 修改。本地超时不取消任务，也不修改 Server 的单台安装超时；应继续查询同一 task ID，不自动重试。

## 结果如何判断

- 查询 get 原样返回 JSON，只代表查询成功；Agent 必须检查 items/summary。
- 等待结束、或 install/retry 立即返回 done 时，只有全部 item 为 success 才退出 0；含 failed/timeout/unknown 时返回原始任务 JSON 并退出 1。
- 请求失败沿用已有 CLI 的 stderr 错误与非零退出码；AIPHONE_DEBUG=1 可显示 API 错误响应。
- 安装已受理、后续等待失败时仍输出已知任务 JSON，保留 task ID。上传或提交响应异常时，先查包/任务记录，不直接重复提交。
- 不自动卸载旧 App、不自动提交测试、不自动关机或删除虚拟机。

## 包与设备类型

- Android：APK。
- 鸿蒙：HAP 或文件形式的 App Pack `.app`。
- iOS 真机：IPA。
- iOS Simulator：用 Simulator SDK 构建的 `.app` 目录压成 zip；不能拿真机 IPA 替代。

CLI 上传非空普通文件，平台和包内容校验仍由现有 Server/Agent 负责。upload 使用流式传输，不把整个安装包读入内存；download 同样流式写文件。
服务端每次上传生成独立包记录，不按应用包名覆盖记录。设备端是否允许覆盖，由原有安装通道和系统规则决定，CLI 不额外改安装参数，也不承诺安装后版本号回读校验。

卸载沿用已有 `aiphone devices uninstall <serial> <packageName>`，传应用精确包名/Bundle ID；它与上传响应的 package ID 不同。

0.3.0 已通过本地模拟服务测试，并在本机 iOS Simulator 完成上传、安装、执行任务、关闭实例的真实链路验收；不代表所有平台和宿主环境均已实测。
