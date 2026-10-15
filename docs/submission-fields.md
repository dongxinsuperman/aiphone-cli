# POST /api/submissions 请求体字段（CLI 透传）

`aiphone submissions submit` **不会裁剪或改写** JSON，下列字段与仓库 `docs/external-api（对外调用清单）.md` §2 一致。

## 顶层 wrapper

| 字段 | 必填 | 说明 |
|------|------|------|
| `items` | **是** | 非空数组，每项一条业务 case（见下表） |
| `submissionName` | 否 | 批次展示名；缺省用 `submissionId` |
| `callbackUrl` | 否 | 每条 item 终态旁路 POST `submission.item.terminal`，批次收口后再 POST `submission.terminal`；须 `http://` 或 `https://`，最长 1024 |
| `cacheMode` | 否 | 批次默认轨迹缓存：`off` / `v1` / `v2` / `v3`；单条 item 可覆盖 |
| `retryMax` | 否 | 本批重跑上限；仍受服务端 `AI_PHONE_RUN_RETRY_*` 限制 |
| `functionMapContext` | 否 | 批次级执行参考（功能地图、账号、术语等）；默认不做产品层长度拦截，仅当服务端把 `AI_PHONE_FUNCTION_MAP_CONTEXT_MAX_CHARS` 配成正整数时按该值拒绝超长（超限 400） |

## items[] 每条

| 字段 | 必填 | 说明 |
|------|------|------|
| `caseId` | **是** | 业务主键；同批内 `caseId + platform`（展开后）唯一 |
| `runContent` | **是** | 自然语言执行目标 |
| `platforms` | **是** | 非空数组，`android` / `ios` / `harmony`，不可重复；按平台展开为多条执行单元 |
| `caseName` | 否 | 展示名；缺省用 `caseId` |
| `functionMapContext` | 否 | **item 级执行参考**（该 raw item 才需要的入口/测试数据/业务说明）；展开到该 item 的每个平台执行单元，并与批次级合并后注入 Run |
| `deviceAliasPools` | 否 | `{ "android": ["别名"], "ios": null }`；缺省 / `null` / `[]` = 该端全池任挑 |
| `cacheMode` | 否 | 覆盖批次级 `cacheMode` |

## functionMapContext 合并规则（批次级 + item 级）

| 传入情况 | 执行单元最终拿到 |
|----------|-------------------|
| 只传顶层 | 批次所有执行单元 = 顶层文本 |
| 只传 `items[].functionMapContext` | 仅该 raw item 展开的单元 = item 文本 |
| 两层都传 | 顶层文本 + item 文本（拼接） |

同一 raw item 选多个平台时，item 文本被这些平台共享；当前不做平台维度 map。

## deviceAliasPools 语义

| 写法 | 含义 |
|------|------|
| 不传 | 各端全池任挑 |
| `"ios": null` 或 `[]` | iOS 全池任挑 |
| `"ios": ["iPhone-1"]` | iOS 锁单台 |
| `"android": ["A1","A2"]` | Android 子集池动态消费 |

别名须先 `aiphone devices available`（或 `aiphone devices statuses` 看全量占用）核对；错误时 400 含 `rejectReason`。

## 常见 rejectReason

`invalid_body` · `missing_field` · `invalid_platform` · `pool_alias_not_in_platforms` · `unknown_device_alias` · `device_alias_platform_mismatch` · `no_device_on_platform`

## 轨迹缓存

`cacheMode` 取值与边界见仓库 `docs/trajectory-cache-usage（轨迹缓存使用文档）.md`。

## 复杂用例文案

`runContent` 建议遵循 `docs/ai-consumable-test-cases（AI可消费测试用例指南）.md`。
