import { Readable, Transform } from "node:stream";
import { createRequire } from "node:module";
import { proxyBaseUrl } from "./settings.js";
import { readState } from "./state.js";

// Read our own version once so the Cowork User-Agent tracks the package
// version automatically instead of drifting whenever we bump. Falls back to
// "0" if package.json can't be read (never expected in a packaged build).
const PKG_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version || "0";
  } catch {
    return "0";
  }
})();

// User-Agent shape CLIProxyAPI's parseEntrypointFromUA understands:
// content inside "(…, <entrypoint>)" becomes cc_entrypoint on the cloaked
// billing header. Must NOT start with "claude-cli" or ShouldCloak(auto)
// skips system-prompt cloaking entirely. Version is informational only.
export const COWORK_USER_AGENT = `renn-copilot/${PKG_VERSION} (external, cowork)`;
const COWORK_WORKLOAD_HEADER = "X-CPA-Claude-Workload";
const COWORK_WORKLOAD = "cowork";

/**
 * Official Claude Code custom tool surface (TitleCase). Anthropic fingerprints
 * OAuth traffic on this inventory; third-party names trigger extra-usage billing.
 * Keep this list aligned with CLIProxyAPI's oauthToolRenameMap targets.
 */
export const CLAUDE_CODE_TOOL_NAMES = Object.freeze([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Task",
  "WebFetch",
  "TodoWrite",
  "Question",
  "Skill",
  "LS",
  "TodoRead",
  "NotebookEdit",
]);

const CLAUDE_CODE_TOOL_NAME_SET = new Set(CLAUDE_CODE_TOOL_NAMES);

/**
 * VS Code Copilot Chat / agent tool → Claude Code tool (1:1 only).
 * Multiple VS Code tools must NOT share a target -- reverse mapping would be
 * ambiguous and break tool execution in the client.
 */
export const COWORK_TOOL_FORWARD_MAP = Object.freeze({
  run_in_terminal: "Bash",
  read_file: "Read",
  create_file: "Write",
  replace_string_in_file: "Edit",
  file_search: "Glob",
  grep_search: "Grep",
  list_dir: "LS",
  manage_todo_list: "TodoWrite",
  fetch_webpage: "WebFetch",
  runSubagent: "Task",
  vscode_askQuestions: "Question",
  edit_notebook_file: "NotebookEdit",
});

/** Pure helper -- exported for unit tests. */
export function isClaudeModelId(model) {
  return typeof model === "string" && /claude/i.test(model);
}

/**
 * Builds the headers renn forwards to CLIProxyAPI for a chat completion.
 * When claudeCoworkMode is on and the model is Claude-family, stamps a
 * Cowork-style entrypoint + workload so CLIProxyAPI's applyCloaking /
 * generateBillingHeader emit cc_entrypoint=cowork and cc_workload=cowork.
 */
export function buildUpstreamChatHeaders({ authorization, claudeCoworkMode, isClaude }) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
  };
  // Pass through whatever Authorization the client sent verbatim --
  // this proxy doesn't own auth, CLIProxyAPI's own proxy-auth setting
  // (see cliproxy-manager.js's setProxyAuthEnabled) still applies.
  if (authorization) headers.Authorization = authorization;

  if (claudeCoworkMode && isClaude) {
    headers["User-Agent"] = COWORK_USER_AGENT;
    headers[COWORK_WORKLOAD_HEADER] = COWORK_WORKLOAD;
  }
  return headers;
}

function toolFunctionName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  if (typeof tool.name === "string") return tool.name;
  return "";
}

function setToolFunctionName(tool, name) {
  if (!tool || typeof tool !== "object") return tool;
  if (tool.function && typeof tool.function === "object") {
    return {
      ...tool,
      function: {
        ...tool.function,
        name,
      },
    };
  }
  return { ...tool, name };
}

function resolveForwardToolName(name) {
  if (!name || typeof name !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(COWORK_TOOL_FORWARD_MAP, name)) {
    return COWORK_TOOL_FORWARD_MAP[name];
  }
  // Already Claude Code TitleCase -- keep as-is (no reverse entry needed).
  if (CLAUDE_CODE_TOOL_NAME_SET.has(name)) return name;
  // Case-insensitive match against official names.
  const titleHit = CLAUDE_CODE_TOOL_NAMES.find((n) => n.toLowerCase() === name.toLowerCase());
  if (titleHit) return titleHit;
  return null;
}

/**
 * Rewrites an OpenAI-style chat body so Anthropic only sees Claude Code tool
 * names. Unmapped tools are dropped (they are the third-party fingerprint).
 *
 * @returns {{ body: object, reverseMap: Record<string, string>, dropped: string[] }}
 *   reverseMap: upstream TitleCase name → original client tool name (only for renames).
 */
export function applyCoworkToolCloak(body) {
  if (!body || typeof body !== "object") {
    return { body, reverseMap: {}, dropped: [] };
  }

  // Shallow-clone top level; deep-clone arrays we mutate.
  const next = { ...body };
  const reverseMap = Object.create(null);
  const dropped = [];
  const seenUpstream = new Set();

  const recordRename = (original, upstream) => {
    if (original === upstream) return;
    if (reverseMap[upstream] === undefined) reverseMap[upstream] = original;
  };

  if (Array.isArray(body.tools)) {
    const kept = [];
    for (const tool of body.tools) {
      const original = toolFunctionName(tool);
      const upstream = resolveForwardToolName(original);
      if (!upstream) {
        if (original) dropped.push(original);
        continue;
      }
      // One client tool per upstream name -- reverse map must stay bijective.
      if (seenUpstream.has(upstream)) {
        if (original) dropped.push(original);
        continue;
      }
      seenUpstream.add(upstream);
      recordRename(original, upstream);
      kept.push(setToolFunctionName(tool, upstream));
    }
    next.tools = kept;
  }

  // tool_choice: { type: "function", function: { name } } or flat { name }
  if (next.tool_choice && typeof next.tool_choice === "object") {
    const tc = { ...next.tool_choice };
    if (tc.function && typeof tc.function === "object" && typeof tc.function.name === "string") {
      const original = tc.function.name;
      const upstream = resolveForwardToolName(original);
      if (!upstream) {
        // Forced tool was dropped -- fall back to auto so the request stays valid.
        next.tool_choice = "auto";
      } else {
        recordRename(original, upstream);
        tc.function = { ...tc.function, name: upstream };
        next.tool_choice = tc;
      }
    } else if (typeof tc.name === "string") {
      const original = tc.name;
      const upstream = resolveForwardToolName(original);
      if (!upstream) next.tool_choice = "auto";
      else {
        recordRename(original, upstream);
        next.tool_choice = { ...tc, name: upstream };
      }
    }
  }

  if (Array.isArray(body.messages)) {
    next.messages = body.messages.map((msg) => rewriteMessageToolNames(msg, recordRename));
  }

  return { body: next, reverseMap, dropped };
}

function rewriteMessageToolNames(msg, recordRename) {
  if (!msg || typeof msg !== "object") return msg;
  let out = msg;

  if (Array.isArray(msg.tool_calls)) {
    out = { ...out, tool_calls: msg.tool_calls.map((tc) => rewriteToolCallName(tc, recordRename)) };
  }

  // OpenAI "function_call" legacy field
  if (msg.function_call && typeof msg.function_call === "object" && typeof msg.function_call.name === "string") {
    const original = msg.function_call.name;
    const upstream = resolveForwardToolName(original);
    if (upstream) {
      recordRename(original, upstream);
      out = {
        ...out,
        function_call: { ...msg.function_call, name: upstream },
      };
    }
  }

  // Anthropic-ish content blocks if a client ever posts them on this path
  if (Array.isArray(msg.content)) {
    let changed = false;
    const content = msg.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "tool_use" && typeof part.name === "string") {
        const upstream = resolveForwardToolName(part.name);
        if (upstream && upstream !== part.name) {
          recordRename(part.name, upstream);
          changed = true;
          return { ...part, name: upstream };
        }
      }
      if (part.type === "tool_reference" && typeof part.tool_name === "string") {
        const upstream = resolveForwardToolName(part.tool_name);
        if (upstream && upstream !== part.tool_name) {
          recordRename(part.tool_name, upstream);
          changed = true;
          return { ...part, tool_name: upstream };
        }
      }
      return part;
    });
    if (changed) out = { ...out, content };
  }

  return out;
}

function rewriteToolCallName(tc, recordRename) {
  if (!tc || typeof tc !== "object") return tc;
  if (tc.function && typeof tc.function === "object" && typeof tc.function.name === "string") {
    const original = tc.function.name;
    const upstream = resolveForwardToolName(original);
    if (!upstream || upstream === original) return tc;
    recordRename(original, upstream);
    return {
      ...tc,
      function: { ...tc.function, name: upstream },
    };
  }
  if (typeof tc.name === "string") {
    const original = tc.name;
    const upstream = resolveForwardToolName(original);
    if (!upstream || upstream === original) return tc;
    recordRename(original, upstream);
    return { ...tc, name: upstream };
  }
  return tc;
}

/**
 * Reverse Claude Code tool names → original VS Code names in an OpenAI
 * chat.completion (or chunk-like) JSON object. Mutates and returns `payload`.
 */
export function reverseCoworkToolNamesInPayload(payload, reverseMap) {
  if (!payload || typeof payload !== "object" || !reverseMap || Object.keys(reverseMap).length === 0) {
    return payload;
  }

  const restore = (name) => {
    if (typeof name !== "string") return name;
    return reverseMap[name] !== undefined ? reverseMap[name] : name;
  };

  const choices = payload.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const message = choice.message;
      if (message && typeof message === "object") {
        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) restoreToolCallInPlace(tc, restore);
        }
        if (message.function_call && typeof message.function_call === "object") {
          if (typeof message.function_call.name === "string") {
            message.function_call.name = restore(message.function_call.name);
          }
        }
      }
      const delta = choice.delta;
      if (delta && typeof delta === "object") {
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) restoreToolCallInPlace(tc, restore);
        }
        if (delta.function_call && typeof delta.function_call === "object") {
          if (typeof delta.function_call.name === "string") {
            delta.function_call.name = restore(delta.function_call.name);
          }
        }
      }
    }
  }

  // Anthropic-style content[] (in case a non-OpenAI response ever lands here)
  if (Array.isArray(payload.content)) {
    for (const part of payload.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_use" && typeof part.name === "string") {
        part.name = restore(part.name);
      }
      if (part.type === "tool_reference" && typeof part.tool_name === "string") {
        part.tool_name = restore(part.tool_name);
      }
    }
  }

  return payload;
}

function restoreToolCallInPlace(tc, restore) {
  if (!tc || typeof tc !== "object") return;
  if (tc.function && typeof tc.function === "object" && typeof tc.function.name === "string") {
    tc.function.name = restore(tc.function.name);
  }
  if (typeof tc.name === "string") {
    tc.name = restore(tc.name);
  }
}

/**
 * Rewrite a single SSE line (`data: {...}` or bare JSON). Non-data lines pass through.
 */
export function reverseCoworkToolNamesInSseLine(line, reverseMap) {
  if (!reverseMap || Object.keys(reverseMap).length === 0) return line;
  if (typeof line !== "string") return line;

  const trimmed = line.trimEnd();
  // Preserve empty keep-alive lines
  if (!trimmed) return line;

  let payloadText = null;
  let prefix = null;
  if (trimmed.startsWith("data:")) {
    prefix = trimmed.slice(0, 5); // "data:"
    payloadText = trimmed.slice(5).trimStart();
  } else if (trimmed.startsWith("{")) {
    payloadText = trimmed;
  } else {
    return line;
  }

  if (!payloadText || payloadText === "[DONE]") return line;

  try {
    const obj = JSON.parse(payloadText);
    reverseCoworkToolNamesInPayload(obj, reverseMap);
    const rewritten = JSON.stringify(obj);
    if (prefix !== null) {
      // Keep a single space after data: (common SSE style); match original if no space was used
      const hadSpace = trimmed.length > 5 && trimmed[5] === " ";
      return `data:${hadSpace ? " " : ""}${rewritten}`;
    }
    return rewritten;
  } catch {
    return line;
  }
}

/**
 * Streaming transform: buffer incomplete SSE lines, reverse tool names per complete line.
 */
export function createCoworkSseReverseTransform(reverseMap) {
  let buffer = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        buffer += chunk.toString("utf8");
        // Split on \n but keep \r handling; re-emit with \n
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        let out = "";
        for (const part of parts) {
          // part may end with \r
          const raw = part.endsWith("\r") ? part.slice(0, -1) : part;
          out += reverseCoworkToolNamesInSseLine(raw, reverseMap) + "\n";
        }
        cb(null, out);
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (buffer) {
          const raw = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
          cb(null, reverseCoworkToolNamesInSseLine(raw, reverseMap));
          return;
        }
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

function copyUpstreamHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Node/Express recomputes these for its own response -- forwarding
    // CLIProxyAPI's original values here would corrupt the stream.
    if (
      lower === "content-length" ||
      lower === "content-encoding" ||
      lower === "transfer-encoding" ||
      lower === "connection"
    ) {
      return;
    }
    res.setHeader(key, value);
  });
}

export async function proxyChatCompletions(req, res) {
  const body = req.body ?? {};
  const isClaude = isClaudeModelId(body.model);
  const claudeCoworkMode = Boolean(readState().claudeCoworkMode);
  const cloak = claudeCoworkMode && isClaude;

  let forwardBody = body;
  let reverseMap = null;

  if (cloak) {
    const cloaked = applyCoworkToolCloak(body);
    forwardBody = cloaked.body;
    reverseMap = cloaked.reverseMap;
    if (cloaked.dropped.length) {
      console.log(
        `[cowork] cloaked tools: kept=${Array.isArray(forwardBody.tools) ? forwardBody.tools.length : 0} dropped=${cloaked.dropped.length}`
      );
    }
  }

  const upstream = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: buildUpstreamChatHeaders({
      authorization: req.headers.authorization,
      claudeCoworkMode,
      isClaude,
    }),
    body: JSON.stringify(forwardBody),
  });

  res.status(upstream.status);
  copyUpstreamHeaders(upstream, res);

  if (!upstream.body) {
    res.end();
    return;
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isEventStream = contentType.includes("text/event-stream") || Boolean(forwardBody.stream);
  const needsReverse = Boolean(cloak && reverseMap && Object.keys(reverseMap).length > 0);

  if (needsReverse && !isEventStream) {
    try {
      const text = await upstream.text();
      try {
        const json = JSON.parse(text);
        reverseCoworkToolNamesInPayload(json, reverseMap);
        res.send(JSON.stringify(json));
      } catch {
        res.send(text);
      }
    } catch (err) {
      console.error(`Claude proxy non-stream error: ${err.message}`);
      if (!res.headersSent) res.status(502);
      res.end();
    }
    return;
  }

  const upstreamStream = Readable.fromWeb(upstream.body);

  // A mid-stream error on the upstream body (CLIProxyAPI dropping the
  // connection, a network blip during a long Claude response) would
  // otherwise be an unhandled stream 'error' event -- which crashes the
  // whole backend process, not just this one request. Tear the response
  // down cleanly instead. Also stop pulling from upstream if the client
  // (VS Code) disconnects first, so an abandoned request doesn't keep a
  // CLIProxyAPI stream open.
  upstreamStream.on("error", (err) => {
    console.error(`Claude proxy stream error: ${err.message}`);
    res.destroy(err);
  });
  res.on("close", () => upstreamStream.destroy());

  if (needsReverse && isEventStream) {
    const rewriter = createCoworkSseReverseTransform(reverseMap);
    rewriter.on("error", (err) => {
      console.error(`Claude proxy SSE rewrite error: ${err.message}`);
      res.destroy(err);
    });
    res.on("close", () => rewriter.destroy());
    upstreamStream.pipe(rewriter).pipe(res);
    return;
  }

  upstreamStream.pipe(res);
}
