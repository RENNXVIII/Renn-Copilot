import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUpstreamChatHeaders,
  isClaudeModelId,
  COWORK_USER_AGENT,
  applyCoworkToolCloak,
  reverseCoworkToolNamesInPayload,
  reverseCoworkToolNamesInSseLine,
  COWORK_TOOL_FORWARD_MAP,
  CLAUDE_CODE_TOOL_NAMES,
} from "../src/chat-proxy.js";

test("isClaudeModelId matches Claude-family ids only", () => {
  assert.equal(isClaudeModelId("claude-sonnet-4-5"), true);
  assert.equal(isClaudeModelId("Claude-Opus-4"), true);
  assert.equal(isClaudeModelId("gpt-5"), false);
  assert.equal(isClaudeModelId("gemini-2.5-pro"), false);
  assert.equal(isClaudeModelId(undefined), false);
});

test("buildUpstreamChatHeaders stamps cowork fingerprint only when mode on + Claude", () => {
  const base = buildUpstreamChatHeaders({
    authorization: "Bearer test",
    claudeCoworkMode: false,
    isClaude: true,
  });
  assert.equal(base.Authorization, "Bearer test");
  assert.equal(base["Content-Type"], "application/json");
  assert.equal(base["Accept-Encoding"], "identity");
  assert.equal(base["User-Agent"], undefined);
  assert.equal(base["X-CPA-Claude-Workload"], undefined);

  const offNonClaude = buildUpstreamChatHeaders({
    authorization: undefined,
    claudeCoworkMode: true,
    isClaude: false,
  });
  assert.equal(offNonClaude["User-Agent"], undefined);
  assert.equal(offNonClaude["X-CPA-Claude-Workload"], undefined);
  assert.equal(offNonClaude.Authorization, undefined);

  const on = buildUpstreamChatHeaders({
    authorization: "Bearer test",
    claudeCoworkMode: true,
    isClaude: true,
  });
  assert.equal(on["User-Agent"], COWORK_USER_AGENT);
  assert.equal(on["X-CPA-Claude-Workload"], "cowork");
  // Must not look like the official Claude Code CLI client, or CLIProxyAPI
  // ShouldCloak(auto) skips body cloaking.
  assert.equal(on["User-Agent"].startsWith("claude-cli"), false);
  assert.match(on["User-Agent"], /renn-copilot\/\d+\.\d+\.\d+ \(external,\s*cowork\)/);
});

function fnTool(name, extra = {}) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} desc`,
      parameters: { type: "object", properties: {} },
      ...extra,
    },
  };
}

test("applyCoworkToolCloak renames mapped tools and drops third-party inventory", () => {
  const body = {
    model: "claude-opus-4-8",
    tools: [
      fnTool("run_in_terminal"),
      fnTool("read_file"),
      fnTool("create_file"),
      fnTool("mcp_chrome_devtoo_fill"),
      fnTool("vscode_listCodeUsages"),
      fnTool("replace_string_in_file"),
      fnTool("file_search"),
      fnTool("grep_search"),
      fnTool("list_dir"),
      fnTool("manage_todo_list"),
      fnTool("fetch_webpage"),
      fnTool("runSubagent"),
      fnTool("vscode_askQuestions"),
      fnTool("edit_notebook_file"),
      fnTool("create_directory"),
    ],
  };

  const { body: out, reverseMap, dropped } = applyCoworkToolCloak(body);
  const names = out.tools.map((t) => t.function.name);

  assert.deepEqual(names.sort(), [
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "LS",
    "NotebookEdit",
    "Question",
    "Read",
    "Task",
    "TodoWrite",
    "WebFetch",
    "Write",
  ]);

  // Only Claude Code TitleCase names leave the proxy.
  for (const n of names) {
    assert.ok(CLAUDE_CODE_TOOL_NAMES.includes(n), `unexpected tool ${n}`);
  }

  assert.equal(reverseMap.Bash, "run_in_terminal");
  assert.equal(reverseMap.Read, "read_file");
  assert.equal(reverseMap.Write, "create_file");
  assert.equal(reverseMap.Edit, "replace_string_in_file");
  assert.equal(reverseMap.Glob, "file_search");
  assert.equal(reverseMap.Grep, "grep_search");
  assert.equal(reverseMap.LS, "list_dir");
  assert.equal(reverseMap.TodoWrite, "manage_todo_list");
  assert.equal(reverseMap.WebFetch, "fetch_webpage");
  assert.equal(reverseMap.Task, "runSubagent");
  assert.equal(reverseMap.Question, "vscode_askQuestions");
  assert.equal(reverseMap.NotebookEdit, "edit_notebook_file");

  assert.ok(dropped.includes("mcp_chrome_devtoo_fill"));
  assert.ok(dropped.includes("vscode_listCodeUsages"));
  assert.ok(dropped.includes("create_directory"));
});

test("applyCoworkToolCloak rewrites tool_calls and tool_choice", () => {
  const body = {
    tools: [fnTool("run_in_terminal"), fnTool("read_file")],
    tool_choice: { type: "function", function: { name: "run_in_terminal" } },
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
    ],
  };

  const { body: out, reverseMap } = applyCoworkToolCloak(body);
  assert.equal(out.tool_choice.function.name, "Bash");
  assert.equal(out.messages[0].tool_calls[0].function.name, "Read");
  assert.equal(reverseMap.Bash, "run_in_terminal");
  assert.equal(reverseMap.Read, "read_file");
});

test("applyCoworkToolCloak drops forced tool_choice when tool unmapped", () => {
  const body = {
    tools: [fnTool("run_in_terminal")],
    tool_choice: { type: "function", function: { name: "mcp_secret" } },
  };
  const { body: out } = applyCoworkToolCloak(body);
  assert.equal(out.tool_choice, "auto");
});

test("applyCoworkToolCloak keeps already-TitleCase Claude Code tools without reverse", () => {
  const body = {
    tools: [fnTool("Bash"), fnTool("Read")],
  };
  const { body: out, reverseMap, dropped } = applyCoworkToolCloak(body);
  assert.deepEqual(
    out.tools.map((t) => t.function.name),
    ["Bash", "Read"]
  );
  assert.equal(Object.keys(reverseMap).length, 0);
  assert.equal(dropped.length, 0);
});

test("reverseCoworkToolNamesInPayload restores OpenAI tool_calls", () => {
  const reverseMap = { Bash: "run_in_terminal", Read: "read_file" };
  const payload = {
    choices: [
      {
        message: {
          tool_calls: [
            { id: "1", type: "function", function: { name: "Bash", arguments: "{}" } },
          ],
        },
      },
      {
        delta: {
          tool_calls: [
            { index: 0, function: { name: "Read" } },
          ],
        },
      },
    ],
  };
  reverseCoworkToolNamesInPayload(payload, reverseMap);
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, "run_in_terminal");
  assert.equal(payload.choices[1].delta.tool_calls[0].function.name, "read_file");
});

test("reverseCoworkToolNamesInSseLine rewrites data chunks and leaves [DONE]", () => {
  const reverseMap = { Bash: "run_in_terminal" };
  const line =
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"Bash"}}]}}]}';
  const out = reverseCoworkToolNamesInSseLine(line, reverseMap);
  assert.match(out, /run_in_terminal/);
  assert.doesNotMatch(out, /"Bash"/);
  assert.equal(reverseCoworkToolNamesInSseLine("data: [DONE]", reverseMap), "data: [DONE]");
  assert.equal(reverseCoworkToolNamesInSseLine(": ping", reverseMap), ": ping");
});

test("forward map targets are unique Claude Code tools", () => {
  const targets = Object.values(COWORK_TOOL_FORWARD_MAP);
  assert.equal(new Set(targets).size, targets.length);
  for (const t of targets) {
    assert.ok(CLAUDE_CODE_TOOL_NAMES.includes(t), `bad target ${t}`);
  }
});
