# Claude Code Instructions for Akemon

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

## General Guidelines

- 在修改代码前**必须先读取**相关文件，理解现有实现
- 只做用户要求的改动，不要添加额外功能或重构
- 遵循现有代码风格和架构模式
- 使用 RTK 来优化 token 使用
