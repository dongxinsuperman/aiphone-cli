# 设备占用管理

复用 Server 的设备锁，不新建锁机制、不连接 SSH、不启动镜像、不投递任务。锁使平台调度跳过设备，但无法拦截独立 SSH / ADB / HDC / WDA；外部调用方必须在失去占用时自行停止操作。

## Agent 直连设备的前置流程

通过 SSH 使用宿主机上的 ADB、HDC、WDA 等工具直连设备前，必须先申请设备占用，避免平台同时向该设备调度测试任务。占用成功只是取得平台占用权，不代表设备已启动、工具已连通或业务可执行；这些仍由直连调用方确认。

推荐顺序：**查询设备 → 建立占用会话 → 确认 acquired → 直连操作并持续续期 → 停止直连操作 → 释放占用并确认结果**。

1. 用 `aiphone devices statuses` 确认目标 serial、状态和占用情况；不要把虚拟机 ID 或别名当作 serial。
2. 为本次独立操作提供唯一 holder，启动 `aiphone devices session <serial> --holder <唯一标识>`，保持进程运行。直连期间优先采用持续会话。
3. 持续读取 JSONL 并监控进程；收到 `acquired` 且 `holds_lock:true` 后，才能通过独立 SSH/工具开始操作。申请冲突或失败时不开始直连、不抢占。
4. 操作期间由会话每 5 秒自动续期，默认 TTL 为 120 秒。Agent 继续监听 `renewed`；不能只读第一行就忽略后续事件，也不能暂停或结束会话后继续操作。
5. 收到 `lost`、`acquire_failed`、会话异常退出，或无法在已确认的实际 TTL 内继续确认占用时，立即停止发出新的直连操作，并中止可控的进行中操作。网络失败也按占用无法保证处理，不自动重抢或恢复。
6. 正常结束时先停止外部操作，再向会话进程发送 SIGINT/Ctrl+C 或 SIGTERM；读取 `released` 并确认释放请求结果。`release_failed` 或强制终止时，不宣称已释放，等待服务端 TTL 失效；可用 statuses 再核对。

自行管理续期和清理的脚本可改用下面的 lock/heartbeat/unlock 三个原子命令：先取得 token，按实际 TTL 提前持续 heartbeat，任一次续期无法确认即停止操作，最后在清理逻辑中用原 token unlock。只执行一次 lock 无法支持长时间直连。

占用是直连调用规范中的必要步骤；锁在平台调度层生效，不会在 SSH/ADB 层强制阻断。CLI 会话不代替 Agent 执行或停止外部命令，调用方必须落实失效停止与结束清理。

## 脚本原子操作

```bash
aiphone devices lock <serial> --holder <本次调用方唯一标识>
aiphone devices heartbeat <serial> --token <申请返回的token>
aiphone devices unlock <serial> --token <申请返回的token>
```

lock 可选 `--ttl <seconds>`（3–300，默认 120）、`--holder-type <type>`（session/job/webhook/manual/auto，默认 session）。holder 必须非空，调用方负责确保唯一；同一 holder 再申请沿用 token 和原 TTL，不会更新 TTL。holder_type 仅为展示标签。

成功原样输出接口 JSON；失败输出 JSON `{error:{code,message,status?,detail?}}`，退出码 1。HTTP 409 表示占用冲突，403 表示 token 不匹配，404 表示设备或锁不存在。网络失败不自动重试；申请响应丢失时可能已经占用，应先用 devices statuses 核对并依靠 TTL 过期，不能宣称申请成功。

unlock 始终发送 `force:false`，不支持强制释放，不使用其他人的 token。token 是占用凭据，应避免将输出写入公开日志。

## 持续会话

```bash
aiphone devices session <serial> --holder <本次调用方唯一标识>
```

前台运行，默认申请 120 秒 TTL，每 5 秒续期；可用 `--ttl`、`--holder-type`、`--interval <seconds>` 调整。interval 最小 0.1 秒且必须小于请求和服务端实际 TTL。使用实际返回 TTL；心跳成功后从本次请求开始时刻保守计算有效期。每个请求有超时，不重叠续期，不重抢或自动恢复。

stdout 为 JSONL 事件：

- acquired：申请成功，`holds_lock:true`，lock 含 token。
- renewed：续期成功，`holds_lock:true`。
- acquire_failed / lost：申请或续期失败，`holds_lock:false`；结束会话，退出码 1。网络错误表示占用权无法保证，不代表已经确认服务端释放。
- released：释放请求成功，`holds_lock:false`；released 字段表示是否实际移除了锁。
- release_failed：未确认释放，退出码 1，等待服务端 TTL 过期。

Ctrl+C / SIGTERM 停止续期并尝试带原 token 释放；退出码 0 表示正常结束且释放请求成功。续期失败后也仅尝试释放自己的锁。无法捕获的强制终止、进程崩溃或网络故障依靠 Server TTL，最多从最后一次成功续期起等待该锁实际 TTL。未确认申请结果时不发送无 token 的解锁。

会话不执行任何外部命令。Agent 应持续读取事件并监控进程退出；只有最近的有效确认才能视为持有占用，不能在会话失败后继续以为独占设备。会话结束后 token 不再可用。

## 查询

`devices statuses` 查看锁与设备状态，`devices available` 查看可接单设备；沿用已有命令与输出。锁续期是刷新有效期，不是累加时长。
