import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCopilotHookInput, pinRtkHookOutput } from "../rtk-hook.js";

test("normalizes VS Code's terminal tool name for upstream RTK", () => {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "run_in_terminal",
    tool_input: { command: "git status" },
  };
  assert.deepEqual(normalizeCopilotHookInput(input), {
    ...input,
    tool_name: "runTerminalCommand",
  });
  assert.equal(input.tool_name, "run_in_terminal");
});

test("normalizes the camelCase terminal tool name variant", () => {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "runInTerminal",
    tool_input: { command: "git status" },
  };
  assert.deepEqual(normalizeCopilotHookInput(input), {
    ...input,
    tool_name: "runTerminalCommand",
  });
});

test("leaves an already-recognized terminal tool name untouched", () => {
  const input = { tool_name: "runTerminalCommand", tool_input: { command: "ls" } };
  assert.equal(normalizeCopilotHookInput(input), input);
});

test("does not alter non-terminal hook events", () => {
  const input = { tool_name: "read_file", tool_input: { filePath: "README.md" } };
  assert.equal(normalizeCopilotHookInput(input), input);
});

test("pins RTK's rewritten Windows command to the selected binary", () => {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: "rtk git status" },
    },
  });
  const parsed = JSON.parse(
    pinRtkHookOutput(output, "C:\\Users\\test\\Renn Copilot\\rtk.exe", "win32")
  ) as { hookSpecificOutput: { updatedInput: { command: string } } };
  assert.equal(
    parsed.hookSpecificOutput.updatedInput.command,
    '& "C:\\Users\\test\\Renn Copilot\\rtk.exe" git status'
  );
});

test("pins RTK's rewritten POSIX command without a call operator", () => {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: "rtk git status" },
    },
  });
  const parsed = JSON.parse(pinRtkHookOutput(output, "/opt/rtk/rtk", "linux")) as {
    hookSpecificOutput: { updatedInput: { command: string } };
  };
  assert.equal(parsed.hookSpecificOutput.updatedInput.command, "'/opt/rtk/rtk' git status");
});

test("preserves empty and non-JSON RTK output", () => {
  assert.equal(pinRtkHookOutput("", "/opt/rtk", "linux"), "");
  assert.equal(pinRtkHookOutput("not-json", "/opt/rtk", "linux"), "not-json");
});