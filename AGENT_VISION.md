# Akemon Agent Vision

> 2026-03-22 讨论记录

## 核心洞察

MCP 协议是单向的：client 调 server，server 不能调别人。所有协调逻辑必须由上层 AI client 驱动。

**Akemon 的定位**：让 agent（MCP server）本身具备调用其他 agent 的能力，不依赖 AI 编排层。

> MCP 让 AI 能调用工具。Akemon 让工具能调用工具。

## Agent 类型分层

### 第一层：任意程序当 engine（已支持）

`--engine` 接受任意 CLI，覆盖：
- AI Agent（claude, codex, gemini）
- Script Agent（bash 脚本、Python 脚本）
- API Wrapper（天气、数据库、SaaS）
- IoT（米家、HomeKit、树莓派 GPIO）
- Human（人工回复）

这些不需要额外开发，只需要文档和示例。用户写一个脚本作为 engine 即可。

### 第二层：Terminal Agent（待做，P0）

内置 `--engine terminal`，把远程终端作为 agent。

特性：
- 不需要 SSH、不需要端口转发，穿透内网靠 relay WebSocket
- `--approve` 模式：owner 审批每条命令
- 零 API 成本，毫秒级响应
- **Terminal agent 就是 daemon** —— 通过它可以远程启动/关闭其他 agent，不需要单独做守护进程

能力矩阵：

| 模式 | engine | 费用 | 安全 |
|---|---|---|---|
| AI 终端 | claude --allow-all | API 费 | AI 理解意图 |
| 裸终端 + 审批 | terminal + --approve | 免费 | owner 审批 |
| 裸终端 | terminal | 免费 | 仅自用+私密 |

### 第三层：Agent 互调 — agent_call（待做，P1）

每个 akemon agent 不只是 server（被调用），也是 client（能发起调用）。

实现方式：agent 进程已经通过 WebSocket 连着 relay。加一个方向——通过 relay 发起任务给其他 agent。

```
Agent A ←WebSocket→ Relay ←WebSocket→ Agent B
                     双向
```

relay 加一个 message type：
```json
{"type": "agent_call", "target": "agent-b", "task": "...", "call_id": "xxx"}
{"type": "agent_call_result", "call_id": "xxx", "result": "..."}
```

agent SDK 暴露 `callAgent(name, task)` 函数，任何 engine（脚本、AI、MCP server）都能用。

### 第四层：MCP Server Adapter（P2，可以用 terminal 替代 MVP）

把社区现有 MCP server 一键发布到 akemon marketplace。两种方案：

方案 A（简单）：用 terminal agent 远程启动 MCP server
方案 B（透传）：`--mcp-server` 选项，akemon 透传底层 MCP server 的所有 tools 给 publisher

方案 B 架构：
```
Publisher 的 Claude → tools/list → 看到底层 MCP 的所有原生 tools
    ↓ tools/call
  relay → WebSocket → akemon serve → stdio → 底层 MCP server
```

### 第五层：Composite Agent / 工作流（P2）

agent 组合形成 workflow：
- 翻译 agent → 写作 agent → 审核 agent
- 完全无 AI 编排层，agent 自主委托

这产生网络效应——一个 agent 有用带动其他 agent 也有用。

## 竞品差异

| 平台 | Agent 互调 |
|---|---|
| MCP 协议 | 不支持，server 不能调 server |
| Claude Channels | 不支持，只跟一个 session 对话 |
| LangChain/CrewAI | 同一进程内，不跨机器 |
| **Akemon** | **跨机器、跨引擎、通过 relay 互调** |

## IoT 场景

技术上可行（树莓派上跑 akemon serve + Python 脚本控制 GPIO/米家/HomeKit），但：
- 不是核心卖点（用户装米家 App 更方便）
- 没有网络效应
- 适合作为"One More Thing"展示架构灵活性

## 发帖策略

核心叙事调整：不再是"远程控制 AI"，而是"agent 互联网络"。

卖点排序：
1. Agent 互调（跨机器、跨引擎的分布式 agent 协作）
2. Terminal Agent（不需要 SSH 的远程终端）
3. MCP marketplace（共享 agent 能力给所有人）
4. 不绑定 Claude，任何 AI/任何脚本都能当 agent

## 风险

- 需求未验证——"agent 调 agent"还没有真实用户在喊
- 冷启动——marketplace agent 不多，互调谁？
- 做太久没发出去比做错了风险更大

**策略：半天做完 terminal + agent_call，跑通 demo，发帖看反馈。**
