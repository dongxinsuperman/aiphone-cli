# 三端虚拟机第一版：受控创建与已有实例管理

入口是 `aiphone vm android|ios|harmony`，原有 config/devices/submissions 命令和投递 JSON 不变。
管理接口沿用后台已有请求头：仅 /api/internal/ 请求携带 Bearer，默认 dev；后台配置不同值时可用 AIPHONE_INTERNAL_TOKEN 临时覆盖。不修改接口，也不向原有公开设备、安装或投递请求追加此头。

## 创建只提供四项信息

平台由命令路径确定；**别名必须由外部提供**；选择后台目录中的设备预设及该预设兼容的系统。
不生成别名、不自动选机型、不自动选最新系统、不按在线设备猜测配置。
系统只有一个合法选项时可以省略；有多个选项时返回它们，要求调用方明确选择。
不开放完整 JSON、文件/标准输入、自定义 CPU/RAM/分辨率/ABI 等参数。修改已有实例仅开放改别名，不提供任意 PATCH。

```bash
# 用户问「有没有小米13」时，先查询，不创建
aiphone vm android catalog --brand xiaomi --q 13 --limit 20
aiphone vm android preset <精确预设ID或名称>
aiphone vm android systems <精确预设ID或名称>

# 预览内部固定展开的配置；不探查 Agent、不创建
aiphone vm android create --alias 支付回归01 --preset <精确预设ID> --os 13 --dry-run

# 创建配置；显式 --start --wait 才沿用后台探查下发并等待可接单
aiphone vm android create --alias 支付回归01 --preset <精确预设ID> --os 13
aiphone vm ios create --alias 苹果回归01 --preset "iPhone 17" --os 26.0 --start --wait
```

示例不表示这些组合当前有宿主可承接；需以实时目录及实际启动结果为准。
预览和创建结果里的 payload 是程序内部生成结果，用于解释；不是接受完整参数输入的入口。

## 设备库查询：少量输入，丰富选择

三端都有 `catalog`（搜索/分页）、`preset <精确ID或名称>`（详情）、`systems <精确ID或名称>`（兼容系统）。
`catalog` 支持 `--q`、`--category`、`--os`、`--offset`、`--limit`；Android 另支持 `--brand`、`--resolution`、`--ram`。
返回 items 与 page.total/returned/has_more。Android 保留服务端源目录计数，另标 omitted_invalid_rows；无法受控创建的异常行不作为候选。
Android 详情区分真机参考 reference_spec 和固定模拟器配置 vm_spec，不声称复刻厂商 ROM。
按预设 ID 查询使用当前目录；Android 暂无单台画像查询接口，ID 查找可能读取多页，不缓存旧目录。

| 平台 | 预设与系统约束 | 固定参数 |
|---|---|---|
| Android | 仅后台 verified 且有可创建 API 版本的设备画像；仅可选择画像 sdk_versions 中且后台版本菜单支持的系统。支持 Android 名称、版本号或 api-N 标识。 | 屏幕宽高/密度取画像；参考内存最高 4GB、缺省 4GB；4 核、8GB 存储、Google APIs、ABI 自动、host GPU、竖屏、无代理、默认传感器、后台既有 discard_changes 策略。覆盖策略和自定义模式不开放为第一版创建预设。 |
| iOS | 沿用后台 Apple 机型目录及 min/max runtime 过滤；先选机型，再选择兼容 runtime，不任意组合。 | Apple 机型原生规格，不提供额外硬件配置。 |
| 鸿蒙 | 仅支持有 supported_image_ids 且存在创建方法的官方机型；系统镜像必须同设备类型、creatable 且在兼容表内。 | 机型屏幕参数、4GB RAM、8GB 存储、完整冷启动、折叠屏初始展开。 |

服务端最终校验仍保留；不支持的组合在写入前拒绝。后台菜单有约束时 CLI 也应用，不因服务端未拦而放开。
本版不构建「当前 Agent 能创建的预设列表」，不逐预设实时探查。目录兼容和宿主可执行是两件事。

## 已有虚拟机查询

```bash
aiphone vm list
aiphone vm list --platform android --q 回归 --state running --agent <agentId>
aiphone vm android list --alias 支付回归01
aiphone vm android get 支付回归01
aiphone vm android status 支付回归01
aiphone vm android rename 支付回归01 --alias 支付回归02
```

列表返回总实例数 total_existing、筛选后的 page.total、状态计数 counts 和分页结果。跨平台查询不会把停止或离线设备省掉。
操作目标支持实例 ID 或**精确**别名；模糊搜索只用于 list，不能模糊匹配后停机/删除。别名有歧义时必须改用 ID。

## 启动、停止、重启、删除

```bash
aiphone vm android probe <ID或精确别名>
aiphone vm android dispatch <ID或精确别名> --agent <agentId> --wait
aiphone vm android start <ID或精确别名> --wait
aiphone vm android stop <ID或精确别名> --wait
aiphone vm android restart <ID或精确别名>
aiphone vm android delete <ID或精确别名>
```

以上生命周期命令三端都有。首次启动须 dispatch；start 使用原宿主和配置。
restart 固定为「确认无任务锁→停止→等待 stopped→确认原宿主未变→启动同一实例→确认可接单」，默认等待完成。
设备被占用、停止失败、超时或宿主变化时中止，不继续启动，不换宿主，不删除重建。不承诺重启保留所有运行期数据：原有快照策略仍然生效。
等待默认最多 180 秒，每 2 秒查询，可用 --timeout/--interval 调整；超时不停止或删除实例。
换宿主 dispatch 可能返回新 vm_id，必须使用返回的 instance.id；restart 不走换宿主路径。
delete 要求非活动态，不自动 stop。deleted/cleanup_sent 是配置删除及清理通知，host_cleanup_confirmed=false 不代表文件已清理完。

probe 沿用后台旧流程：鸿蒙含临时创建/删除验证，不是纯查询；只有用户明确需要探查或启动时才使用。
iOS health 仅查询目录健康，不表示设备可用。Android device-brands/device-facets 是后台目录辅助查询。
本版不开放目录导入、全局设置写入、全参数复制或强制释放等高级运维入口。

## Agent 回复与失败处理

- 用户未提供别名：要求提供，不能代填。缺预设：先查 catalog；多匹配列出具体规格，让用户选。缺版本：展示该预设兼容系统，不随意拼装。
- 用户只问「有没有」时只查目录。没有精确匹配就说没有，不替换成相近机型创建。
- phase=configured：只说「配置已创建，尚未启动」。phase=start_requested/sent=true：只说「启动请求已下发」。只有 schedulable=true 才报告可接单。
- status.ready 表示 running、设备在线、Agent 匹配、readiness=true；设备忙可能 ready=true 但 schedulable=false。
- 创建后没有可承接宿主：错误保留 instance.id、具体原因及 next_commands；继续 probe/dispatch/status，不重复 create。
- 创建回包的预设/系统与请求不一致（含 Android 被降级为 custom）：返回 preset_mismatch 和非零退出码，保留已保存的 instance.id 与差异字段；不继续探查、下发或启动，不自动替换或删除。此时 next_commands 仅提供 get/status 核对入口。
- 请求异常且 outcome_unknown=true：先 list/get 按外部别名核对，不直接重试创建。
- 新 vm 命令成功/失败均返回 JSON，失败有非零退出码。没有修改原有命令的输出契约。

0.3.0 已通过本地模拟服务与契约验证，并在本机 iOS Simulator 完成创建启动、安装 App、执行任务、停机的真实链路验收；不代表所有平台或线上环境均已实测。
