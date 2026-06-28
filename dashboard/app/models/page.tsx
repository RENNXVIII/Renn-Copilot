"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import { api, type ModelEntry } from "@/lib/api";
import { loadCustomGroups } from "@/lib/custom-groups";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Blocks, Search } from "lucide-react";
import type { IconComponent } from "@/components/ui/icon-badge";
import { AntigravityIcon, ClaudeIcon, CodexIcon } from "@/components/ui/provider-icons";

// Same brand icons as the Providers page (shared via provider-icons.tsx), kept
// light here (just an inline icon, no colored badge) so the model groups are
// recognizable without competing for attention with the Providers page itself.
const PROVIDER_ICONS: Record<string, IconComponent> = {
  antigravity: AntigravityIcon,
  claude: ClaudeIcon,
  codex: CodexIcon,
  other: Blocks,
};

// Fixed tab order so the three OAuth login providers always show up in the
// same place as on the Providers page, even if a model list briefly has none
// of one provider's models in it. Any provider id we encounter that isn't one
// of these (e.g. "other", for ids we couldn't confidently guess) gets
// appended after, dynamically.
const PINNED_PROVIDERS = ["antigravity", "claude", "codex"];
const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  other: "Other",
};

export default function ModelsPage() {
  const { data, mutate, isLoading } = useSWR("models", api.getModels);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [customGroups, setCustomGroups] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");

  // Custom-provider grouping is set on the Providers page and stored in
  // localStorage (never sent to the backend) -- read it here too so a model
  // served by e.g. a "tokenrouter" custom provider shows under that label
  // instead of the raw openai-compatibility entry name.
  useEffect(() => {
    setCustomGroups(loadCustomGroups());
  }, []);

  function labelFor(provider: string): string {
    return PROVIDER_LABELS[provider] ?? customGroups[provider] ?? provider;
  }

  const models = data?.models ?? [];

  // Only show a provider tab/group if it actually has models -- a provider
  // with no stored credentials simply never appears, instead of showing up
  // as an empty "0 enabled" card.
  const presentProviders = new Set(models.map((m) => m.provider));
  const tabs = [
    "all",
    ...PINNED_PROVIDERS.filter((p) => presentProviders.has(p)),
    ...Array.from(presentProviders).filter((p) => !PINNED_PROVIDERS.includes(p)),
  ];

  const tabModels = activeTab === "all" ? models : models.filter((m) => m.provider === activeTab);
  const q = query.trim().toLowerCase();
  const visibleModels = q
    ? tabModels.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    : tabModels;
  const grouped = groupBy(visibleModels, (m) => m.provider);

  // Shared by the single switch, per-provider "Enable/Disable all", and the
  // global "Enable/Disable all" -- just takes the final set of ids that
  // should end up enabled and pushes it, with an optimistic local update.
  async function applyEnabledIds(nextIds: string[]) {
    const nextIdSet = new Set(nextIds);
    mutate(
      {
        models: models.map((m) => ({ ...m, enabled: nextIdSet.has(m.id) })),
        source: data?.source ?? "live",
        liveError: data?.liveError ?? null,
      },
      false
    );
    setSaving(true);
    try {
      await api.setEnabledModels(nextIds);
    } finally {
      setSaving(false);
      mutate();
    }
  }

  function toggle(model: ModelEntry, enabled: boolean) {
    const nextIds = enabled
      ? [...models.filter((m) => m.enabled).map((m) => m.id), model.id]
      : models.filter((m) => m.enabled && m.id !== model.id).map((m) => m.id);
    return applyEnabledIds(nextIds);
  }

  // Enable/disable every model within one provider group, leaving other
  // providers' selections untouched.
  function setGroupEnabled(items: ModelEntry[], enabled: boolean) {
    const groupIds = new Set(items.map((m) => m.id));
    const others = models.filter((m) => !groupIds.has(m.id) && m.enabled).map((m) => m.id);
    const nextIds = enabled ? [...others, ...items.map((m) => m.id)] : others;
    return applyEnabledIds(nextIds);
  }

  function setAllEnabled(enabled: boolean) {
    return applyEnabledIds(enabled ? models.map((m) => m.id) : []);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Models</h1>
          <p className="text-sm text-muted-foreground">
            Toggle which models get pushed into Copilot Chat&apos;s BYOK list. The VS Code extension
            picks these up automatically (or run &quot;Renn Copilot: Sync Models&quot; manually).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <Badge variant="secondary">Saving...</Badge>}
          <Button size="sm" variant="outline" disabled={!models.length} onClick={() => setAllEnabled(false)}>
            Disable all
          </Button>
          <Button size="sm" disabled={!models.length} onClick={() => setAllEnabled(true)}>
            Enable all
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const count = tab === "all" ? models.length : models.filter((m) => m.provider === tab).length;
            return (
              <Button
                key={tab}
                size="sm"
                variant={activeTab === tab ? "default" : "ghost"}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "all" ? "All" : labelFor(tab)} ({count})
              </Button>
            );
          })}
        </div>
        {models.length > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 sm:w-64">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading models...</p>}

      {!isLoading && !visibleModels.length && (
        <p className="text-sm text-muted-foreground">
          {q ? "No models match your search." : "No models for this provider yet."}
        </p>
      )}

      {!isLoading && data?.source === "empty" && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          Couldn&apos;t fetch the live model list from CLIProxyAPI
          ({data.liveError || "is the server running and is at least one account logged in?"}).
          Start the server and log in to a provider, then this list will populate automatically.
        </div>
      )}

      {Object.entries(grouped).map(([provider, items]) => {
        const enabledCount = items.filter((m) => m.enabled).length;
        const ProviderIcon = PROVIDER_ICONS[provider] ?? Blocks;
        return (
          <Card key={provider}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <ProviderIcon className="h-4 w-4 text-muted-foreground" />
                    {labelFor(provider)}
                  </CardTitle>
                  <CardDescription>
                    {enabledCount}/{items.length} enabled
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enabledCount === 0}
                    onClick={() => setGroupEnabled(items, false)}
                  >
                    Disable all
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={enabledCount === items.length}
                    onClick={() => setGroupEnabled(items, true)}
                  >
                    Enable all
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {items.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm font-medium">{m.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.id} {m.thinking && "· thinking"}
                    </p>
                  </div>
                  <Switch checked={m.enabled} onCheckedChange={(v) => toggle(m, v)} />
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        After changing models here, reload VS Code and enable them via Copilot Chat&apos;s model
        picker → &quot;Manage Models...&quot; → click the eye icon. That last step has to be manual —
        VS Code doesn&apos;t expose an API to enable BYOK models programmatically yet.
      </div>
    </div>
  );
}

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
}
