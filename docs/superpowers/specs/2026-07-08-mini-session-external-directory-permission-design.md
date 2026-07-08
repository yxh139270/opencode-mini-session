# Mini Session External Directory Permission Design

## 背景

当前 mini session 在 `plugin-managed` 模式下会自行生成一份 `PermissionRuleset`。这份规则在 `src/agent.ts` 中把只有默认允许的工具设为 `allow`，其余权限统一设为 `deny`，其中包括 `external_directory`。

这导致子 session 访问项目目录之外的路径时，不会进入 OpenCode 原生的权限申请流程，而是被插件侧直接拒绝。用户看到的结果就是“没有权限，也没有弹出权限申请”。

## 目标

- 修复 mini session 访问项目外目录时无法弹出权限申请的问题。
- 保持 mini session 仍然是独立 session，不自动继承父 session 的全部权限。
- 只修复 `external_directory` 的权限处理，不扩大到无关权限模型重构。

## 非目标

- 不实现父 session 全权限继承。
- 不尝试同步父 session 已批准权限的完整状态。
- 不改变 custom agent 模式下的权限行为。

## 方案选择

### 方案 A：继承父 session 权限

优点：体验最顺滑，父 session 已允许的外部目录可直接使用。

缺点：当前仓库里没有现成证据表明 OpenCode SDK 暴露了可安全复用的父 session 权限状态。若强行实现，容易引入对底层权限模型的假设。

### 方案 B：子 session 独立，但允许重新申请 `external_directory`

优点：实现最小、行为明确，且能恢复 OpenCode 原生授权流程。

缺点：用户在 mini session 中访问项目外目录时，可能需要再次确认授权。

### 结论

采用方案 B。

## 设计

### 权限生成

保留现有 plugin-managed mini session 的独立权限模型，但对 `external_directory` 做例外处理：

- 默认工具权限仍按现有逻辑处理。
- `external_directory` 不再被硬编码为 `deny`。
- 改为生成可触发 OpenCode 权限系统继续处理的规则，而不是在插件层提前拒绝。

具体实现上，应在 `buildPermissionRules()` 中单独处理 `external_directory`，避免落入统一的 “非默认工具即 deny” 分支。

### 会话创建

`buildMiniSessionCreatePayload()` 继续给 plugin-managed mini session 传入权限规则集，但该规则集对 `external_directory` 的处理改为允许 OpenCode 做后续权限判定与交互。

custom agent 模式保持不变，因为该模式本来就使用代理自身的权限模型。

### 错误与反馈

不新增额外 UI。

一旦 `external_directory` 访问进入 OpenCode 的原生权限申请流程，授权弹窗或拒绝反馈由宿主环境负责，插件只需停止在本地把它提前拒绝。

## 测试

至少覆盖以下场景：

1. plugin-managed 模式生成的权限规则中，`external_directory` 不再是 `deny`。
2. 其他非默认允许权限的现有约束不应被意外放宽。
3. custom agent 模式行为不变。

## 风险

- 如果 OpenCode 对传入的 `PermissionRuleset` 语义要求是必须显式 `allow/deny`，而不是允许留白或更宽松规则，那么需要根据实际 API 行为微调规则表达方式。
- 如果 OpenCode 对 `external_directory` 的申请机制依赖更上层配置，还可能需要在测试中进一步确认真实运行表现。

## 后续演进

如果后续确认 SDK 能可靠读取父 session 已批准的外部目录权限，可以进一步演进为混合方案：

- 已批准目录沿用父 session 结果
- 新目录在 mini session 中重新申请

这一步不包含在本次实现范围内。
