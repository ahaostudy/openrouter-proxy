// OpenRouter Proxy
// A transparent HTTP/WebSocket proxy for OpenRouter that:
//  1. Injects required headers to unlock free Xiaomi MiMo model access (any client)
//  2. Fixes SSE streaming compatibility for the VS Code Claude Code extension
//
// Usage:
//   node proxy.js
//   Then replace your base URL from https://openrouter.ai → http://127.0.0.1:8899

const http = require("http");
const https = require("https");
const { Transform } = require("stream");
const { URL } = require("url");

// ═══════════════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  listen: { host: "127.0.0.1", port: 8899 },
  target: { protocol: "https:", hostname: "openrouter.ai", port: null },
  ssl: { rejectUnauthorized: true },
  verbose: true,
  sseFixUserAgents: ["claude-vscode"],
};

// Headers injected into every proxied request to unlock free MiMo access.
const HEADERS_OVERRIDE = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-OpenRouter-Title": "OpenClaw",
};

// Headers that are stripped from the client request (rebuilt by the proxy).
const HEADERS_REMOVE = new Set(["host", "x-forwarded-for"]);

// Hop-by-hop headers that must not be forwarded.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers",
  "transfer-encoding", "upgrade",
]);

// ═══════════════════════════════════════════════════════════════
//  Logging
// ═══════════════════════════════════════════════════════════════

const CLR = {
  reset: "\x1b[0m",  dim: "\x1b[2m",
  red: "\x1b[31m",   green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m",  magenta: "\x1b[35m", cyan: "\x1b[36m",
};

const LOG_ICONS = {
  info: `${CLR.green}●${CLR.reset}`,
  warn: `${CLR.yellow}●${CLR.reset}`,
  error: `${CLR.red}●${CLR.reset}`,
  proxy: `${CLR.cyan}→${CLR.reset}`,
  sse: `${CLR.magenta}≋${CLR.reset}`,
  ws: `${CLR.blue}◎${CLR.reset}`,
};

function log(level, msg, extra) {
  const ts = new Date().toISOString().slice(11, 23);
  const icon = LOG_ICONS[level] || " ";
  const line = `${CLR.dim}${ts}${CLR.reset} ${icon} ${msg}`;
  console.log(line, ...(extra ? [extra] : []));
}

// ═══════════════════════════════════════════════════════════════
//  Header Helpers
// ═══════════════════════════════════════════════════════════════

function buildProxyHeaders(original) {
  const h = { ...original };

  for (const key of HEADERS_REMOVE) delete h[key];
  for (const key of HOP_BY_HOP)     delete h[key];
  for (const [k, v] of Object.entries(HEADERS_OVERRIDE)) h[k.toLowerCase()] = v;

  return h;
}

// ═══════════════════════════════════════════════════════════════
//  SSE Utilities
// ═══════════════════════════════════════════════════════════════

function isSSEResponse(headers) {
  return (headers["content-type"] || "").includes("text/event-stream");
}

function isStreamingRequest(headers) {
  return (headers["accept"] || "").includes("text/event-stream");
}

/** Parse a raw SSE event block into { event, data } */
function parseSSEBlock(block) {
  let event = "";
  let data = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      try { data = JSON.parse(line.slice(5).trim()); } catch { /* ignore */ }
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }
  return { event, data };
}

/** Write an SSE event to the response (or suppress if tagged as filter). */
function writeSSE(res, eventData, tag) {
  if (CONFIG.verbose) {
    const color = tag.includes("filter") ? CLR.red
                : tag.includes("insert") ? CLR.blue
                : CLR.dim;
    const preview = eventData.replace(/\n/g, " ").slice(0, 120);
    log("sse", `${color}${tag}:${CLR.reset} ${CLR.dim}${preview}${CLR.reset}`);
  }
  if (tag.includes("filter")) return;
  res.write(eventData + "\n\n");
}

/** Flush pending content_block_stop events for accumulated indexes. */
function flushStopEvents(res, indexes) {
  for (const idx of indexes) {
    const evt = `event: content_block_stop\ndata: {"type":"content_block_stop","index":${idx}}`;
    writeSSE(res, evt, "insert");
  }
  indexes.length = 0;
}

// ═══════════════════════════════════════════════════════════════
//  SSE Stream Processor
// ═══════════════════════════════════════════════════════════════

/**
 * Creates handlers for processing an SSE response stream.
 * Fixes compatibility issues specific to the VS Code Claude Code extension:
 *  - Filters out redacted_thinking blocks
 *  - Manages content_block_start/stop lifecycle
 *  - Injects synthetic signature_delta for thinking blocks
 *  - Ensures message_stop is emitted last
 */
function createVSCodeSSEFixer(res) {
  let buffer = "";
  let isThinking = false;
  let isRedactedThinking = false;
  const pendingIndexes = [];

  function processChunk(chunk) {
    buffer += chunk.toString();
    const events = buffer.split("\n\n");
    buffer = events.pop();

    for (const raw of events) {
      const { event, data } = parseSSEBlock(raw);

      // Filter redacted_thinking blocks (toggle state on each occurrence).
      if (raw.includes('"redacted_thinking"') || isRedactedThinking) {
        writeSSE(res, raw, "filter");
        isRedactedThinking = !isRedactedThinking;
        continue;
      }

      // When a thinking block ends, inject a synthetic signature_delta.
      if (isThinking && !raw.includes('"thinking"')) {
        isThinking = false;
        const sig = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"dd9960d18582b741463f3ba1347853ee2ad01144306d9b1e07fd45808d81b171"}}';
        writeSSE(res, sig, "insert");
      }

      if (event === "content_block_start") {
        if (raw.includes('"thinking"')) isThinking = true;
        flushStopEvents(res, pendingIndexes);
        pendingIndexes.push(data?.index);
        writeSSE(res, raw, "data");

      } else if (event === "content_block_stop") {
        writeSSE(res, raw, "filter");

      } else if (event === "message_stop" || raw.trimEnd().endsWith("[DONE]")) {
        writeSSE(res, raw, "filter");

      } else {
        writeSSE(res, raw, "data");
      }
    }
  }

  function finish() {
    if (buffer.length > 0) res.write(buffer);
    flushStopEvents(res, pendingIndexes);
    writeSSE(res, `event: message_stop\ndata: {"type":"message_stop"}\n\n`, "insert");
    writeSSE(res, `event: data\ndata: [DONE]\n\n`, "insert");
    res.end();
  }

  return { processChunk, finish };
}

/** Creates a Transform stream that logs SSE events while passing data through. */
function createSSELogger() {
  let buf = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString();
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const raw of events) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const { event } = parseSSEBlock(raw);
        const tag = event || "data";
        const preview = trimmed.replace(/\n/g, " ").slice(0, 120);
        log("sse", `${CLR.dim}pipe:${CLR.reset} ${CLR.dim}${tag} ${preview}${CLR.reset}`);
      }
      this.push(chunk);
      cb();
    },
    flush(cb) {
      if (buf.trim()) {
        const { event } = parseSSEBlock(buf);
        log("sse", `${CLR.dim}pipe:${CLR.reset} ${CLR.dim}${event || "data"} ${buf.trim().replace(/\n/g, " ").slice(0, 120)}${CLR.reset}`);
      }
      cb();
    },
  });
}

// ═══════════════════════════════════════════════════════════════
//  HTTP Proxy
// ═══════════════════════════════════════════════════════════════

/** Split user messages that mix tool_result blocks with text blocks.
 *  When OpenRouter translates these to OpenAI format for providers like
 *  DeepSeek, the tool response must land before the next user message or
 *  the provider rejects the request ("insufficient tool messages following
 *  tool_calls message"). */
function splitMixedMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const toolBlocks = msg.content.filter(b => b.type === "tool_result");
    const otherBlocks = msg.content.filter(b => b.type !== "tool_result");
    if (toolBlocks.length > 0 && otherBlocks.length > 0) {
      msg.content = toolBlocks;
      messages.splice(i + 1, 0, { role: "user", content: otherBlocks });
    }
  }
}

function proxyRequest(clientReq, clientRes) {
  const { protocol: tgtProto, hostname, port } = CONFIG.target;
  const targetUrl = new URL(clientReq.url, `${tgtProto}//${hostname}`);
  if (port) targetUrl.port = port;

  // Rewrite /v1/* → /api/v1/* so clients that omit the /api prefix (e.g. VS
  // Code Claude Code extension) are forwarded to the correct OpenRouter endpoint.
  if (targetUrl.pathname.startsWith("/v1/") || targetUrl.pathname === "/v1") {
    targetUrl.pathname = "/api" + targetUrl.pathname;
  }

  const headers = buildProxyHeaders(clientReq.headers);
  headers["host"] = hostname + (port ? `:${port}` : "");
  headers["x-forwarded-for"] = clientReq.socket.remoteAddress || "unknown";
  headers["x-forwarded-host"] = clientReq.headers.host || "";
  headers["x-forwarded-proto"] = "http";

  const isClaudeVSCode = CONFIG.sseFixUserAgents.some(ua => (clientReq.headers["user-agent"] || "").includes(ua));
  const wantSSE = isStreamingRequest(clientReq.headers);
  const proto = targetUrl.protocol === "https:" ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: clientReq.method,
    headers,
    rejectUnauthorized: CONFIG.ssl.rejectUnauthorized,
  };

  if (CONFIG.verbose) {
    const tag = wantSSE ? `${CLR.magenta}[SSE]${CLR.reset} ` : "";
    const ua = isClaudeVSCode ? `${CLR.yellow}[vscode]${CLR.reset} ` : "";
    log("proxy", `${tag}${ua}${clientReq.method} ${CLR.cyan}${targetUrl.hostname}${CLR.reset}${targetUrl.pathname}${targetUrl.search}`);
  }

  const proxyReq = proto.request(options, (proxyRes) => {
    const sse = isSSEResponse(proxyRes.headers);
    const resHeaders = { ...proxyRes.headers };

    if (sse) {
      delete resHeaders["content-length"];
      delete resHeaders["content-encoding"];
      delete resHeaders["cache-control"];
      resHeaders["cache-control"] = "no-cache, no-transform";
      resHeaders["connection"] = "keep-alive";
      resHeaders["x-accel-buffering"] = "no";
      if (CONFIG.verbose) log("sse", `SSE stream opened — ${proxyRes.statusCode}`);
    }

    clientRes.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders);

    if (sse && isClaudeVSCode) {
      const fixer = createVSCodeSSEFixer(clientRes);
      proxyRes.on("data", fixer.processChunk);
      proxyRes.on("end", fixer.finish);
    } else if (sse) {
      proxyRes.pipe(createSSELogger()).pipe(clientRes);
    } else {
      proxyRes.pipe(clientRes);
    }

    proxyRes.on("end", () => {
      if (CONFIG.verbose) {
        log("info", `Response complete — ${proxyRes.statusCode} ${clientReq.method} ${targetUrl.pathname}`);
      }
    });

    proxyRes.on("error", (err) => {
      log("error", `Upstream response error: ${err.message}`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end("Bad Gateway: upstream response error");
    });
  });

  // Buffer the request body so we can split mixed-content user messages
  // before forwarding (see splitMixedMessages comment above).
  const chunks = [];
  clientReq.on("data", (chunk) => chunks.push(chunk));
  clientReq.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    let body = raw;
    try {
      const obj = JSON.parse(raw);
      if (obj.messages) {
        splitMixedMessages(obj.messages);
        body = JSON.stringify(obj);
      }
    } catch { /* pass non-JSON bodies through unmodified */ }
    proxyReq.setHeader("Content-Length", Buffer.byteLength(body));
    proxyReq.write(body);
    proxyReq.end();
  });

  clientReq.on("error", (err) => {
    log("error", `Client request error: ${err.message}`);
    proxyReq.destroy();
  });

  proxyReq.on("error", (err) => {
    log("error", `Upstream request error: ${err.message}`);
    if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "text/plain" });
    clientRes.end(`Bad Gateway: ${err.message}`);
  });

  proxyReq.setTimeout(wantSSE ? 0 : 60000, () => {
    log("warn", "Upstream request timeout");
    proxyReq.destroy();
  });
}

// ═══════════════════════════════════════════════════════════════
//  WebSocket Proxy
// ═══════════════════════════════════════════════════════════════

function proxyWebSocket(clientReq, clientSocket, clientHead) {
  const { hostname, port } = CONFIG.target;
  const targetUrl = new URL(clientReq.url, `ws://${hostname}`);
  if (port) targetUrl.port = port;

  const headers = buildProxyHeaders(clientReq.headers);
  headers["host"] = hostname + (port ? `:${port}` : "");

  const proto = targetUrl.protocol === "wss:" ? https : http;

  const proxyReq = proto.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "wss:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: "GET",
    headers: {
      ...headers,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": clientReq.headers["sec-websocket-key"] || "",
      "sec-websocket-version": clientReq.headers["sec-websocket-version"] || "13",
      "sec-websocket-extensions": clientReq.headers["sec-websocket-extensions"] || "",
    },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket) => {
    if (CONFIG.verbose) log("ws", `WebSocket connected → ${targetUrl.hostname}${targetUrl.pathname}`);

    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      "\r\n\r\n"
    );

    if (clientHead?.length) proxySocket.write(clientHead);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
    proxySocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    log("error", `WebSocket proxy error: ${err.message}`);
    clientSocket.end();
  });

  proxyReq.end();
}

// ═══════════════════════════════════════════════════════════════
//  Server
// ═══════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => proxyRequest(req, res));

server.on("upgrade", (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() === "websocket") {
    proxyWebSocket(req, socket, head);
  } else {
    socket.end();
  }
});

server.on("clientError", (err, socket) => {
  if (err.code === "ECONNRESET" || !socket.writable) return;
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

const { host, port } = CONFIG.listen;
server.listen(port, host, () => {
  const target = `${CONFIG.target.protocol}//${CONFIG.target.hostname}`;
  console.log(`
${CLR.cyan}╔══════════════════════════════════════════════════╗
║              OpenRouter Proxy                    ║
╚══════════════════════════════════════════════════╝${CLR.reset}
  ${CLR.green}●${CLR.reset} Listening:  ${CLR.yellow}http://${host}:${port}${CLR.reset}
  ${CLR.green}●${CLR.reset} Target:     ${CLR.cyan}${target}${CLR.reset}
  ${CLR.dim}Test: curl http://localhost:${port}${CLR.reset}
`);
});

const shutdown = () => {
  log("info", "Shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
