# OpenRouter Proxy

> A zero-dependency proxy that unlocks **free Xiaomi MiMo** on OpenRouter for any client, and fixes **SSE streaming** issues with the VS Code Claude Code extension.

**[中文文档](./README_CN.md)**

---

## The Problem

**Free MiMo for any tool** — [Xiaomi MiMo](https://openrouter.ai/xiaomi/mimo-v2-pro) is free on OpenRouter, but only when requests come through the **OpenClaw** channel. Without the right headers, you pay or get nothing. This proxy injects them automatically — works with any HTTP client.

**Claude Code SSE fix** — The VS Code Claude Code extension breaks when consuming OpenRouter's SSE stream due to:
- `unsupported content type: redacted_thinking` errors
- Duplicate or out-of-order events
- Missing content block boundaries

The SSE repair logic specifically targets Claude Code's Anthropic-style event format. Other tools (Continue, Cline, etc.) get the free MiMo access without needing the SSE fix.

**OpenRouter Proxy handles both — transparently, with zero dependencies.**

---

## How It Works

```
┌──────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│   Any AI Tool    │──────▶│  OpenRouter Proxy │──────▶│   OpenRouter    │
│                  │       │  localhost:8899   │       │                 │
│  Claude Code     │◀──────│                  │◀──────│  Xiaomi MiMo    │
│  Continue        │       │  • Inject headers │       │  (free via      │
│  Cline / Aider   │       │  • Repair SSE     │       │   OpenClaw)     │
│  OpenAI SDK      │       │  • WebSocket      │       │                 │
│  Any HTTP client │       │                  │       │                 │
└──────────────────┘       └──────────────────┘       └─────────────────┘
```

| Feature | Detail |
|---------|--------|
| **Header injection** | Adds `HTTP-Referer` + `X-OpenRouter-Title` to qualify for free MiMo — works with **any tool** |
| **SSE repair** | Fixes `redacted_thinking`, block lifecycle, event order — **Claude Code only** |
| **Transparent** | Paths, bodies, and response formats are unchanged — just swap the base URL |
| **WebSocket** | Full upgrade proxy support |
| **Zero deps** | Node.js built-ins only (`http`, `https`, `url`) |

---

## Quick Start

```bash
git clone https://github.com/ahaostudy/openrouter-proxy.git
cd openrouter-proxy
node proxy.js
```

The proxy listens on **`http://127.0.0.1:8899`**. Point your tool's base URL there:

| Before | After |
|--------|-------|
| `https://openrouter.ai` | `http://127.0.0.1:8899` |

Everything else (API key, paths, request body) stays the same.

---

## Configuration

Edit the `CONFIG` object at the top of [`proxy.js`](./proxy.js):

```js
const CONFIG = {
  listen: { host: "127.0.0.1", port: 8899 },
  target: { protocol: "https:", hostname: "openrouter.ai", port: null },
  ssl:    { rejectUnauthorized: true },
  verbose: true,
};
```

| Key | Default | Description |
|-----|---------|-------------|
| `listen.host` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `listen.port` | `8899` | Listen port |
| `target.hostname` | `openrouter.ai` | Upstream OpenRouter host |
| `ssl.rejectUnauthorized` | `true` | Verify TLS certificates |
| `verbose` | `true` | Log every request & SSE event |

---

## SSE Compatibility Fixes

When using Claude Code in VS Code, OpenRouter translates model output into Anthropic-style streaming events. This causes compatibility issues that break Claude Code. The proxy repairs:

| Problem | Fix |
|---------|-----|
| `redacted_thinking` content blocks | Filtered out entirely |
| Missing `content_block_stop` events | Injected at correct positions |
| Missing `signature_delta` for thinking blocks | Synthetic signature injected |
| Duplicate / late `message_stop` | Deduplicated and emitted last |

These fixes are only needed for Claude Code. Other tools (Continue, Cline, Aider, etc.) benefit from the header injection alone and don't require SSE manipulation.

---

## License

[MIT](./LICENSE)
