# Claude Code Instructions for Akemon

## Architecture Direction

Akemon 的核心是 core 与各 module 的决策结构：身份、记忆、目标、偏好、任务判断、权限策略、任务分派和复盘。

- `Engine` 是可替换的算力层，服务于 core/module 的短调用、总结、分类、结构化判断等低风险计算。短期可以是纯 LLM API；长期也可以是 no-tools / constrained agent runtime。无论底层是什么，Engine 不拥有 Akemon 的身份、记忆策略或执行权限。
- Akemon 不内建通用执行 agent，不复刻 Codex、Claude Code、浏览器 agent、办公 agent 或其他专用 agent 工具的能力。需要执行代码修改、命令运行、浏览器操作、外部系统调用等任务时，Akemon 应优先调用用户已经选择和信任的 agent 工具或 agent SDK。
- Akemon 是任务分配者，但不是传统 agent 编排系统。更准确地说，它像把工作下发给各部门的秘书：明确目标、上下文、记忆边界、权限边界、风险和交付物，再接收结果、记录审计并决定下一步。必要时，它也可以把任务交给专门的 agent 编排工具。
- 外部 agent 默认只使用 work memory。`self/` 下的人格记忆仍由 Akemon core/module 维护；不要为 Codex/Claude Code 等外部工具添加直接编辑 `self/` 记忆的产品路径，除非用户明确要求普通文件级操作。

## Assumptions & Guesses Log

当进行以下操作时，请在 `.claude/assumptions.md` 中记录假设：
- 读取未知代码时的推测
- 架构决策时的假设
- 修复bug时的诊断假设

### 记录格式

```
- [时间戳] 操作: 具体假设
  置信度: 高/中/低
  验证方式: 如何验证
```

### 例子

```
- [2026-04-16 14:30] 读代码: relay-client.ts 中的 executeOrder 函数直接返回结果，不保存对话
  置信度: 中
  验证方式: 查看最近的 commit ecc1d35，看是否有 appendRound 调用
```

## Inbox / Delegation Log

`.claude/inbox.md` 是任务分发的共享草稿板（用户 + 各 agent 共享）。

- 结构：`## In flight` / `## Queued` / `## Done` 三个 section，内容行格式 `[日期] [执行者] 任务 — 状态`
- 追加：直接 `echo >> .claude/inbox.md` 或 Edit
- 清空：`./.claude/reset-inbox.sh` 会重建三个 section 骨架；不要 `> inbox.md` 截断（会丢骨架）

## File Safety

- 测试/脚本的临时产物一律用 `mkdtemp` 写到 `/tmp`，不要用 cwd-relative 路径落在仓库里
- 工作目录下 `.gitignore` 的目录 = 真·运行数据（不是测试产物），没有 git 兜底，丢了找不回
- **不使用 `rm`/`rm -rf`** 删除工作目录下任何文件或目录。需要删除时改用 `trash <path>`（macOS 回收站，可从 Finder 找回）或 `mv <path> /tmp/`。精准删除，不一刀切

## General Guidelines

- 在修改代码前**必须先读取**相关文件，理解现有实现
- 只做用户要求的改动，不要添加额外功能或重构
- 遵循现有代码风格和架构模式
- 使用 RTK 来优化 token 使用
