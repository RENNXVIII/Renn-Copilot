"use client";

import useSWR from "swr";
import { useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { LogViewer } from "@/components/ui/log-viewer";
import { Puzzle, Terminal } from "lucide-react";
import { shortenPath } from "@/lib/utils";

const ACTION_LABELS: Record<string, string> = {
  compile: "Compile finished",
  package: "Package built (.vsix)",
  install: "Installed to VS Code",
};

export default function ExtensionPage() {
  const { data: status, mutate: mutateStatus } = useSWR("extension-status", api.getExtensionStatus, {
    refreshInterval: 1500,
  });
  const { data: logsData } = useSWR("extension-logs", api.getExtensionLogs, { refreshInterval: 1500 });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const lines = logsData?.lines ?? [];
  const running = status?.busy ?? false;

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusyAction(action);
    setError(null);
    try {
      await fn();
      toast({ title: ACTION_LABELS[action] ?? action, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: `${action} failed`, description: message, variant: "error" });
    } finally {
      setBusyAction(null);
      mutateStatus();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Extension</h1>
        <p className="text-sm text-muted-foreground">
          Build, package, and install the VS Code bridge extension — straight from here, no separate
          terminal needed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Puzzle className="h-4 w-4 text-muted-foreground" />
              extension/
            </CardTitle>
            {status && (
              <Badge variant={running ? "secondary" : status.lastError ? "destructive" : "success"}>
                {running ? `Running: ${status.lastTask}` : status.lastError ? "Last run failed" : "Idle"}
              </Badge>
            )}
          </div>
          <CardDescription>{status?.extensionDir ? shortenPath(status.extensionDir) : "-"}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <Info label="Folder found" value={status?.dirExists ? "Yes" : "No"} />
          <Info label="Last task" value={status?.lastTask ?? "-"} />
          <Info label="Last exit code" value={status?.lastExitCode === null ? "-" : String(status?.lastExitCode)} />
          <Info label="Last .vsix" value={status?.lastVsix ? shortenPath(status.lastVsix) : "Not built yet"} />
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={running || busyAction !== null}
            onClick={() => run("compile", api.compileExtension)}
          >
            {busyAction === "compile" ? "Compiling..." : "Compile (type-check only)"}
          </Button>
          <Button
            disabled={running || busyAction !== null}
            onClick={() => run("package", api.packageExtension)}
          >
            {busyAction === "package" ? "Packaging..." : "Build & Package (.vsix)"}
          </Button>
          <Button
            variant="outline"
            disabled={running || busyAction !== null || !status?.lastVsix}
            onClick={() => run("install", api.installExtension)}
          >
            {busyAction === "install" ? "Installing..." : "Install to VS Code"}
          </Button>
        </CardFooter>
      </Card>

      {(error || status?.lastError) && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error || status?.lastError}
        </div>
      )}

      <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        &quot;Package&quot; always compiles first (via <code>vscode:prepublish</code>), so it&apos;s safe
        to use on its own. After installing, reload the VS Code window (Command Palette →
        &quot;Developer: Reload Window&quot;) to activate the new build.
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            Build log
          </CardTitle>
          <CardDescription>Streamed from npm/tsc/vsce, most recent lines at the bottom.</CardDescription>
        </CardHeader>
        <CardContent>
          <LogViewer lines={lines} heightClass="h-[360px]" emptyMessage="No build output yet." downloadFilename="extension-build-log.txt" />
        </CardContent>
      </Card>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-medium">{value}</p>
    </div>
  );
}
