import type { OpenAiCompatEntry } from "../api/client";

export function updateCustomProvider(previous: OpenAiCompatEntry | undefined, name: string, baseUrl: string, apiKey: string, models: OpenAiCompatEntry["models"]): OpenAiCompatEntry {
    const keys = previous?.["api-key-entries"] ?? [];
    return {
        ...previous,
        name,
        "base-url": baseUrl,
        "api-key-entries": [{ ...keys[0], "api-key": apiKey }, ...keys.slice(1)],
        models: models ?? [],
    };
}

export function updateXaiProvider(previous: OpenAiCompatEntry | null, editIndex: number | undefined, apiKey: string, models: OpenAiCompatEntry["models"]): OpenAiCompatEntry {
    const keys = previous?.["api-key-entries"] ?? [];
    return {
        ...previous,
        name: "xai",
        "base-url": "https://api.x.ai/v1",
        "api-key-entries": editIndex === undefined
            ? [...keys, { "api-key": apiKey }]
            : keys.map((key, i) => i === editIndex ? { ...key, "api-key": apiKey } : key),
        models: models ?? [],
    };
}