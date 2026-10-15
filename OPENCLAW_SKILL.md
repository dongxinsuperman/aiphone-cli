# aiphone-cli OpenClaw Skill

## 触发

用户要求提交、运行、查询、取消 ai-phone 手机自动化测试时，使用本 Skill。

典型说法：

- 跑一下这些 case
- 在 iOS / Android / Harmony 上执行回归
- 提交 ai-phone 测试
- 查这个 submission 的结果或报告
- 取消某个批次或某条 case

## 你的职责

你负责把用户输入整理成 ai-phone submission JSON，并通过 `aiphone` CLI 投送、查询和返回报告。

不要重新实现 HTTP API。真实执行只调用现有 CLI。

## 必用命令

```bash
aiphone config get
aiphone devices available
aiphone devices statuses
aiphone submissions fields
aiphone submissions submit --stdin
aiphone submissions get <submissionId>
aiphone submissions reports <submissionId>
```

`aiphone devices available` 只返回可接单设备；需要看设备是否被占用、锁状态、readiness 时用 `aiphone devices statuses`（全量状态）。

用户要求安装 App 时先读 `aiphone apps fields`：packages upload 仅上传，保存 package ID；packages eligible 查询适配设备，install --serial 明确指定 serial，--wait 检查每台安装成功。tasks get/wait 查询已知任务，只有明确要求重试才用 tasks retry。done 不等于全成功，不自动全选设备或重复提交，也不自动启动测试、关机或销毁。卸载仍使用 devices uninstall 的应用包名，不是上传包 ID。

用户要求管理模拟器时才使用 `aiphone vm android|ios|harmony`，不改变既有投递流程。先读 `aiphone vm fields`：别名外部必填，先 catalog 搜索，再 preset/systems 查看规格与兼容版本；只用受控预设，不生成别名、不自动选型、不接受完整 JSON。vm list 查询已有实例及数量；按 ID 或精确别名启停、重启、删除。restart 必须等停止确认再启动同一实例，中途失败就中止。仅创建用 create，明确启动需求才加 --start --wait；只有 schedulable=true 才报告可接单。失败保留 instance.id，不重复创建。未改服务端访问限制。

用户要求卸载指定 App 时，使用 `aiphone devices uninstall <serial> <packageName>`；传设备 serial 和精确包名（iOS Bundle ID），平台由服务端识别。命令同步等待卸载确认，输出 JSON；失败返回非零退出码，无需投递批次或轮询。

`aiphone submissions fields` 是字段真相源。`submit --stdin` 接收完整 JSON wrapper，CLI 会原样透传。

## 标准执行流程

提交任务时按顺序执行：

1. `aiphone config get` 确认当前环境。
2. `aiphone devices available` 确认目标平台有设备，并判断是否需要用户选择设备池。
3. 如用户指定设备组、设备池或别名，从可用设备里匹配别名并写入 `deviceAliasPools`。
4. 从用户输入组装 submission JSON。
5. `aiphone submissions submit --stdin` 投送 JSON。
6. 保存返回的 `submissionId`，并把它作为当前会话的最近批次 ID，用于后续“查刚才那个”“取消刚才那个”等追问。
7. `aiphone submissions get <submissionId>` 查询状态。
8. 如果 `state=accepted`，继续轮询。
9. 终态后调用 `aiphone submissions reports <submissionId>`。
10. 返回状态、统计和报告链接；如用户要求总结报告，再提取并总结关键结果。

## JSON 组装规则

顶层必须是 wrapper：

```json
{
  "submissionName": "optional-name",
  "cacheMode": "off",
  "retryMax": 0,
  "items": [
    {
      "caseId": "case_001",
      "caseName": "optional case name",
      "runContent": "自然语言测试目标",
      "platforms": ["ios"]
    }
  ]
}
```

默认值：

- 用户未指定缓存时，使用 `"cacheMode": "off"`
- 用户未指定重试时，使用 `"retryMax": 0`
- 用户未指定 `submissionName` 时，生成一个简短可读名称

设备默认策略：

- API 语义上，不写 `deviceAliasPools` 表示目标平台全池任挑。
- 但 OpenClaw 不应在多设备、多别名组或设备状态差异明显时直接默认全池。
- 如果目标平台只有一个可用设备，且用户没有指定设备池，可以不写 `deviceAliasPools`。
- 如果目标平台有多台设备，先向用户确认使用哪个设备池；只有用户明确说“全部设备”“全池任挑”“随便选”时，才不写 `deviceAliasPools`。

必填字段：

- 顶层 `items`：非空数组
- item `caseId`：同批次内展开后唯一
- item `runContent`：用户要执行的测试内容
- item `platforms`：非空数组，只能包含 `android` / `ios` / `harmony`

可选执行参考 `functionMapContext`（功能地图 / 测试账号 / 业务术语 / 异常处理，只读注入，不改变 `runContent` 任务范围）：

- 顶层 `functionMapContext`：整批共用。
- item 级 `items[].functionMapContext`：只作用于该 raw item 展开出的执行单元。
- 两层都写时，最终注入 = 顶层文本 + item 文本。
- 用户给出“整批通用的入口/账号/背景”写顶层；给出“某条 case 专属的补充说明”写该 item。

## 从用户输入生成 item

每条业务 case 生成一个 item。

用户提供的 case 内容作为 `runContent`。不要主动改写测试语义。

如果用户提供了结构化 case，保持原结构放入 `runContent`，例如：

```text
测试标题：...
前置条件：...
操作步骤：...
预期结果：...
```

如果用户提供的是一句自然语言目标，也可以直接作为 `runContent`。

## 调用组合模式

先判断用户要的是哪一种组合模式。不要把“多端覆盖”“多端均分”“同端多设备分担”混在一起。

### 1. 单端执行

用户说“只跑 iOS”“全部跑 Android”“Harmony 跑一遍”时，每条 case 生成一个 item，`platforms` 只写目标平台。

```json
{
  "caseId": "case_001",
  "runContent": "...",
  "platforms": ["android"]
}
```

执行单元数 = case 数。

### 2. 多端全覆盖

用户说“每条 case 三端各跑一次”“iOS 和 Android 都跑一遍”“三端全量回归”时，每条 case 生成一个 item，`platforms` 写多个平台。

```json
{
  "caseId": "case_001",
  "runContent": "...",
  "platforms": ["android", "ios", "harmony"]
}
```

服务端会按 `platforms` 展开。执行单元数 = case 数 × 平台数。

例如 20 条 case 三端全覆盖 = 60 个执行单元。

### 3. 多端均分

用户说“这些 case 三端均分跑”“让 iOS / Android / Harmony 分担这批 case”时，OpenClaw 要自行按 case 分配平台。

每条 case 仍然只生成一个 item，且 `platforms` 只写一个平台。

```json
{
  "items": [
    {"caseId": "case_001", "runContent": "...", "platforms": ["android"]},
    {"caseId": "case_002", "runContent": "...", "platforms": ["ios"]},
    {"caseId": "case_003", "runContent": "...", "platforms": ["harmony"]}
  ]
}
```

执行单元数 = case 数。

分配策略：

- 按用户指定比例或数量分配。
- 用户未指定比例时，在目标平台之间尽量均分。
- 均分前必须确认目标平台范围，例如三端、仅 iOS+Android，或某个设备组覆盖的平台。

### 4. 同端多设备分担

用户说“全部 Android 机器帮忙跑”“用所有 Android 跑”“用学习A组 Android 跑”“让这组 iPhone 分担”时，不是复制 case，也不是给每条 case 手动锁死一台设备。

正确做法是为目标平台写 `deviceAliasPools` 候选池，让调度器在派发瞬间从池中选择 ready 设备。调度器会自然形成“快机多跑、慢机少跑、坏机不跑”的负载分担。

如果用户明确说“全部 Android 机器”，先从 `aiphone devices available` 取出全部可用 Android 别名作为候选池。若没有可用别名但平台有在线设备，可在用户确认后不写 `deviceAliasPools`，使用该平台全池。

示例：3 条 case 使用 Android 设备池 `A1`、`A2` 分担：

```json
{
  "items": [
    {
      "caseId": "case_001",
      "runContent": "...",
      "platforms": ["android"],
      "deviceAliasPools": {"android": ["A1", "A2"]}
    },
    {
      "caseId": "case_002",
      "runContent": "...",
      "platforms": ["android"],
      "deviceAliasPools": {"android": ["A1", "A2"]}
    },
    {
      "caseId": "case_003",
      "runContent": "...",
      "platforms": ["android"],
      "deviceAliasPools": {"android": ["A1", "A2"]}
    }
  ]
}
```

执行单元数仍然 = case 数。

如果用户明确要求“每条 case 在每台 Android 都跑一遍”，这不是分担，而是设备矩阵重复执行。此时需要复制 item，并为 `caseId` 加设备或别名后缀，确保 `caseId + platform` 唯一；执行前必须向用户确认，因为执行量会变成 case 数 × 设备数。

### 5. 多端均分 + 同端设备池

用户可能同时要求“多端均分”和“每端使用某组设备分担”。

处理方式：

1. 先按 case 分配平台，每个 item 的 `platforms` 只写一个平台。
2. 再按该平台写对应 `deviceAliasPools`。

示例：

```json
{
  "items": [
    {
      "caseId": "case_001",
      "runContent": "...",
      "platforms": ["android"],
      "deviceAliasPools": {"android": ["学习A组-Android-1", "学习A组-Android-2"]}
    },
    {
      "caseId": "case_002",
      "runContent": "...",
      "platforms": ["ios"],
      "deviceAliasPools": {"ios": ["学习A组-iPhone-1", "学习A组-iPhone-2"]}
    }
  ]
}
```

## 服务端展开规则

`platforms` 由服务端展开。

- `["ios"]`：只跑 iOS
- `["android"]`：只跑 Android
- `["harmony"]`：只跑 HarmonyOS
- `["android", "ios", "harmony"]`：同一 case 三端各跑一次
- 20 条 case 每条都写三端 = 60 个执行单元
- 20 条 case 三端均分 = 20 个执行单元，每条 item 只写一个平台

## 设备别名

指定设备前必须先看：

```bash
aiphone devices available
```

禁止编造设备别名。

如果用户说了设备池、设备组或类似名称，例如“学习A组”“学习B组”，从 `aiphone devices available` 返回的设备别名中查找匹配项：

- 能明确匹配到一组别名时，把这些别名写入对应平台的 `deviceAliasPools`
- 匹配到多个可能分组时，列出候选并反问
- 匹配不到时，不要提交；告诉用户没有找到该设备池

锁定设备池时写：

```json
{
  "deviceAliasPools": {
    "ios": ["学习A组-iPhone-1", "学习A组-iPhone-2"],
    "android": ["学习A组-Android-1"]
  }
}
```

不写 `deviceAliasPools` 表示全池任挑。只有用户确认允许全池时才这样做。

设备池反问示例：

```text
当前 iOS 有 4 台可用设备，别名分布包含“学习A组”和“学习B组”。不同设备冷启动状态可能不一致。请确认使用哪个设备池，还是允许全池任挑？
```

## 必须反问的情况

只有缺失信息会影响执行范围、设备选择、环境配置或取消对象时，才反问。

必须反问：

1. 用户没有给测试内容。
   - 例：`帮我跑一下测试`
   - 问：要执行哪些 case？目标 App、步骤和预期结果是什么？

2. 用户没有给平台，且上下文没有明确默认平台。
   - 例：`把这些 case 跑一下`
   - 问：跑 iOS、Android、Harmony，还是三端都跑？

3. “三端跑”语义不清。
   - 例：`20 条 case 三端跑`
   - 问：是每条 case 三端各跑一次，还是 20 条 case 在三端均分？

4. 设备分担和设备矩阵语义不清。
   - 用户说“全部 Android 帮忙跑”“所有 Android 分担”，默认按同端多设备分担处理。
   - 用户说“每台 Android 都跑一遍”“所有机型都覆盖”，可能是设备矩阵重复执行；必须确认，因为执行量会放大。

5. 用户指定设备但别名不唯一或不存在。
   - 先查 `devices available`
   - 如果无法唯一确定，问用户使用哪个设备别名。

6. 目标平台有多台设备或多个明显设备组，但用户没有说明设备池。
   - 问：使用哪个设备池？是否确认全池任挑？
   - 原因：不同设备冷启动状态、账号状态和安装状态可能不一致。

7. 用户要求取消，但没有唯一 `submissionId` 或 case 标识。
   - 问用户要取消哪个批次或哪条 case。

8. 用户要求切换环境或修改配置。
   - 修改 `aiphone config set --url ...` 前必须确认。

可以不反问：

- 用户明确给了平台
- 用户明确给了测试目标
- 用户未指定缓存，默认 `off`
- 用户未指定重试，默认 `0`
- 目标平台只有一台可用设备
- 用户明确说全池任挑、全部设备或随便选

## 投送方式

优先用 stdin 投送完整 JSON：

```bash
printf '%s\n' '<submission-json>' | aiphone submissions submit --stdin
```

如果运行环境不适合管道，可以写临时 JSON 文件后：

```bash
aiphone submissions submit -f <file>
```

## 状态和报告

查询：

```bash
aiphone submissions get <submissionId>
```

状态：

- `accepted`：继续轮询
- `done`：完成
- `cancelled`：已取消
- `expired`：已过期

终态后获取报告：

```bash
aiphone submissions reports <submissionId>
```

`submissions get` 里的报告路径可能是相对路径；需要完整可打开 URL 时必须使用 `submissions reports`。

批次 ID 记忆规则：

- 每次投送成功后，必须记录 `submissionId`、`submissionName`、目标平台、执行单元数和提交时间。
- 用户后续说“查刚才那个”“继续看进度”“取消刚才那个”时，优先使用最近一次 `submissionId`。
- 如果会话里存在多个可能的批次，必须反问用户选择哪个 `submissionId`。

报告总结规则：

- 默认返回状态、统计、失败项和报告链接。
- 如果用户说“总结报告”“提取报告内容”“分析失败原因”，终态后再做总结。
- 总结优先基于 `aiphone submissions get <submissionId>` 和 `aiphone submissions reports <submissionId>` 返回的信息。
- 需要单条排障时，使用：

```bash
aiphone submissions item <submissionId> <caseId> <platform> --include-run
```

- 如果报告尚未终态，不要总结最终结论；只说明当前进度和已知失败。

## 错误处理

常见 `rejectReason`：

- `invalid_body`：检查 wrapper 和 `items`
- `missing_field`：补齐 `caseId` / `runContent` / `platforms`
- `invalid_platform`：平台只能是 `android` / `ios` / `harmony`
- `unknown_device_alias`：重新查设备，不要编造别名
- `device_alias_platform_mismatch`：修正别名平台
- `no_device_on_platform`：告诉用户目标平台暂无设备

## 最终回复

提交并查询后，回复：

```text
已提交批次：<submissionId>
批次名称：<submissionName>
当前状态：<state>
执行统计：success=<n>, failed=<n>, queued=<n>, running=<n>, cancelled=<n>
汇总报告：<summary_report_url>
```

如有失败，补充失败项：

```text
- <caseId> / <platform>：<status_reason>，报告：<report_url>
```

如果终态后用户没有要求总结报告，可以补一句：

```text
需要的话，我可以继续提取报告内容并总结成功项、失败项和主要失败原因。
```

不要臆造 submissionId、设备、报告 URL 或执行结果。

## 简化理解

你不是手机执行器，也不是后端服务。你是 ai-phone CLI 的操作员：

先确认环境和设备，再把用户的话整理成标准 JSON，然后用 CLI 投送，最后查结果并返回报告。
