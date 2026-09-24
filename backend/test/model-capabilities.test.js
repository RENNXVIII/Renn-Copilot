import test from "node:test";
import assert from "node:assert/strict";
import {
    applyCapabilityOverrides,
    normalizeDetectedTokenLimits,
    resolveCapabilityConfiguration,
} from "../src/model-capabilities.js";

const detectedReasoning = {
    supported: true,
    levels: ["low", "medium", "high"],
    source: "model-definitions",
};

test("normalizes token limits from CLIProxyAPI model definitions", () => {
    assert.deepEqual(
        normalizeDetectedTokenLimits({
            context_length: 200000,
            max_input_tokens: 180000,
            max_output_tokens: 20000,
        }),
        {
            contextTokens: 200000,
            inputTokens: 180000,
            outputTokens: 20000,
        }
    );
});

test("manual capability overrides take precedence over detected metadata", () => {
    const resolved = resolveCapabilityConfiguration(
        detectedReasoning,
        { contextTokens: 128000, inputTokens: 120000, outputTokens: 8000 },
        {
            reasoningSupported: true,
            reasoningLevels: ["high", "max"],
            contextTokens: 256000,
            inputTokens: 240000,
            outputTokens: 16000,
        }
    );

    assert.deepEqual(resolved.reasoning.levels, ["high", "max"]);
    assert.equal(resolved.reasoning.source, "manual");
    assert.deepEqual(resolved.limits.effective, {
        contextTokens: 256000,
        inputTokens: 240000,
        outputTokens: 16000,
    });
    assert.deepEqual(resolved.limits.sources, {
        contextTokens: "manual",
        inputTokens: "manual",
        outputTokens: "manual",
    });
});

test("resetting overrides restores detected values", () => {
    const overrides = applyCapabilityOverrides(
        {
            vision: true,
            reasoningSupported: false,
            reasoningLevels: ["max"],
            contextTokens: 64000,
            inputTokens: 60000,
            outputTokens: 4000,
        },
        {
            vision: null,
            reasoningSupported: null,
            reasoningLevels: null,
            contextTokens: null,
            inputTokens: null,
            outputTokens: null,
        },
        detectedReasoning,
        { contextTokens: 128000, inputTokens: 120000, outputTokens: 8000 }
    );

    assert.deepEqual(overrides, {});
});

test("input and output overrides are not constrained by detected context size", () => {
    const overrides = applyCapabilityOverrides(
        {},
        { contextTokens: null, inputTokens: 1000000, outputTokens: 128000 },
        null,
        { contextTokens: 1000000 }
    );
    assert.deepEqual(overrides, { inputTokens: 1000000, outputTokens: 128000 });
});

test("rejects invalid token limits and reasoning levels", () => {
    assert.throws(
        () =>
            applyCapabilityOverrides(
                {},
                { reasoningSupported: true, reasoningLevels: [] },
                null,
                {}
            ),
        /at least one reasoning level/
    );
    assert.throws(
        () =>
            applyCapabilityOverrides(
                {},
                { outputTokens: -1 },
                null,
                {}
            ),
        /positive integer/
    );
});