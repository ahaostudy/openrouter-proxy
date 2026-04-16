# OpenRouter Proxy

> 零依赖代理，为任意客户端解锁 OpenRouter 上的**免费 Xiaomi MiMo**，并修复 VS Code Claude Code 插件的 **SSE 流式**兼容性问题。

**[English](./README.md)**

---

## 解决什么问题

**为任意工具解锁免费 MiMo** — [Xiaomi MiMo](https://openrouter.ai/xiaomi/mimo-v2-pro) 在 OpenRouter 上免费提供，但仅限通过 **OpenClaw** 渠道的请求。本代理自动注入所需请求头——适用于任何 HTTP 客户端。

**Claude Code SSE 修复** — VS Code 的 Claude Code 插件在消费 OpenRouter 的 SSE 流时会出现以下问题：
- `unsupported content type: redacted_thinking` 报错
- 事件重复或乱序
- content block 边界缺失

SSE 修复逻辑专门针对 Claude Code 的 Anthropic 风格事件格式。其他工具（Continue、Cline 等）通过代理获得免费 MiMo 访问即可，不需要 SSE 修复。

**OpenRouter Proxy 同时处理以上两个问题——透明地，且零依赖。**

---

## 工作原理

```
┌──────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│   任意 AI 工具    │──────▶│  OpenRouter 代理  │──────▶│   OpenRouter    │
│                  │       │  localhost:8899   │       │                 │
│  Claude Code     │◀──────│                  │◀──────│  Xiaomi MiMo    │
│  Continue        │       │  • 注入请求头     │       │  (通过 OpenClaw │
│  Cline / Aider   │       │  • 修复 SSE 流    │       │   免费访问)     │
│  OpenAI SDK      │       │  • WebSocket 代理 │       │                 │
│  任意 HTTP 客户端 │       │                  │       │                 │
└──────────────────┘       └──────────────────┘       └─────────────────┘
```

| 特性 | 说明 |
|------|------|
| **请求头注入** | 自动添加 `HTTP-Referer` + `X-OpenRouter-Title`，解锁免费 MiMo——**适用于任意工具** |
| **SSE 修复** | 过滤 `redacted_thinking`、管理 content block 生命周期、修复事件顺序——**仅 Claude Code** |
| **透明转发** | 路径、请求体、响应格式完全不变——只需替换 base URL |
| **WebSocket** | 完整的升级代理支持 |
| **零依赖** | 仅使用 Node.js 内置模块（`http`、`https`、`url`） |

---

## 快速开始

```bash
git clone https://github.com/ahaostudy/openrouter-proxy.git
cd openrouter-proxy
node proxy.js
```

代理监听在 **`http://127.0.0.1:8899`**，将你工具的 base URL 指向它：

| 修改前 | 修改后 |
|--------|--------|
| `https://openrouter.ai` | `http://127.0.0.1:8899` |

API Key、路径、请求体均保持不变。

---

## 配置

编辑 [`proxy.js`](./proxy.js) 顶部的 `CONFIG` 对象：

```js
const CONFIG = {
  listen: { host: "127.0.0.1", port: 8899 },
  target: { protocol: "https:", hostname: "openrouter.ai", port: null },
  ssl:    { rejectUnauthorized: true },
  verbose: true,
};
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `listen.host` | `127.0.0.1` | 监听地址（设为 `0.0.0.0` 可供局域网访问） |
| `listen.port` | `8899` | 监听端口 |
| `target.hostname` | `openrouter.ai` | 上游 OpenRouter 主机 |
| `ssl.rejectUnauthorized` | `true` | 是否验证 TLS 证书 |
| `verbose` | `true` | 是否记录请求和 SSE 事件日志 |

---

## SSE 兼容性修复

当在 VS Code 中使用 Claude Code 时，OpenRouter 将模型输出转换为 Anthropic 风格的流式事件，导致兼容性问题。本代理修复以下问题：

| 问题 | 修复方式 |
|------|----------|
| `redacted_thinking` 内容块 | 完全过滤 |
| 缺少 `content_block_stop` 事件 | 在正确位置注入 |
| 思维块缺少 `signature_delta` | 注入合成签名 |
| 重复或延迟的 `message_stop` | 去重并确保最后发送 |

这些修复仅对 Claude Code 必要。其他工具（Continue、Cline、Aider 等）仅通过请求头注入即可获得免费 MiMo 访问，不需要 SSE 处理。

---

## 许可证

[MIT](./LICENSE)
