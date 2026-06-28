"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Shuffle, FileCog } from "lucide-react";

const STRATEGY_OPTIONS = [
  {
    id: "round-robin" as const,
    label: "Round-robin",
    description: "Cycle through every matching credential evenly.",
  },
  {
    id: "fill-first" as const,
    label: "Fill-first",
    description: "Exhaust one credential's quota before moving to the next.",
  },
];

export default function ConfigPage() {
  const { data, isLoading } = useSWR("config-yaml", api.getConfigYaml);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { toast } = useToast();

  const { data: routing, mutate: mutateRouting } = useSWR("routing-strategy", api.getRoutingStrategy);
  const [routingSaving, setRoutingSaving] = useState(false);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  async function save() {
    setSaving(true);
    try {
      await api.putConfigYaml(draft);
      toast({
        title: "config.yaml saved",
        description: "CLIProxyAPI hot-reloads config changes automatically.",
        variant: "success",
      });
      mutateRouting();
    } catch (err) {
      toast({
        title: "Failed to save config",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  async function setStrategy(strategy: "round-robin" | "fill-first") {
    if (routing?.strategy === strategy) return;
    setRoutingSaving(true);
    try {
      await api.setRoutingStrategy(strategy);
      toast({ title: `Routing strategy: ${strategy}`, variant: "success" });
      mutateRouting();
      // The raw textarea below holds a separate fetch of the same file --
      // refresh it too so it doesn't silently drift out of sync.
      const fresh = await api.getConfigYaml();
      setDraft(fresh);
    } catch (err) {
      toast({
        title: "Failed to update routing strategy",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setRoutingSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Config</h1>
        <p className="text-sm text-muted-foreground">
          Raw config.yaml, edited through CLIProxyAPI&apos;s Management API. Validated server-side before saving.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shuffle className="h-4 w-4 text-muted-foreground" />
            Routing strategy
          </CardTitle>
          <CardDescription>How CLIProxyAPI picks among multiple matching credentials for a request.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          {STRATEGY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              disabled={routingSaving}
              onClick={() => setStrategy(opt.id)}
              className={cn(
                "flex-1 rounded-md border p-3 text-left text-sm transition-colors disabled:opacity-50",
                routing?.strategy === opt.id ? "border-primary bg-accent" : "border-border hover:bg-accent"
              )}
            >
              <p className="font-medium">{opt.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{opt.description}</p>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCog className="h-4 w-4 text-muted-foreground" />
            config.yaml
          </CardTitle>
          <CardDescription>
            Be careful: this replaces the entire file. Contains plaintext API keys -- hidden by default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <div className="relative">
              <Textarea
                rows={24}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className={cn(!revealed && "select-none blur-sm")}
                readOnly={!revealed}
                tabIndex={revealed ? undefined : -1}
                aria-hidden={!revealed}
              />
              {!revealed && (
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/40">
                  <Button type="button" variant="outline" onClick={() => setRevealed(true)}>
                    Click to reveal & edit
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || !revealed || draft === data}>
            {saving ? "Saving..." : "Save"}
          </Button>
          {revealed && (
            <Button
              type="button"
              variant="outline"
              disabled={saving || draft === data}
              onClick={() => data && setDraft(data)}
            >
              Discard changes
            </Button>
          )}
          {revealed && (
            <Button type="button" variant="outline" onClick={() => setRevealed(false)}>
              Hide
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
