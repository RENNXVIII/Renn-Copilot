"use client";

import useSWR from "swr";
import { useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LogViewer } from "@/components/ui/log-viewer";
import { ScrollText } from "lucide-react";

export default function LogsPage() {
  const [source, setSource] = useState<"backend" | "proxy">("proxy");
  const { data: own } = useSWR(source === "backend" ? "own-logs" : null, api.getOwnLogs, {
    refreshInterval: 3000,
  });
  const { data: proxy } = useSWR(source === "proxy" ? "proxy-logs" : null, () => api.getProxyLogs(), {
    refreshInterval: 3000,
  });

  const lines = source === "backend" ? own?.lines ?? [] : proxy?.lines ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Logs</h1>
          <p className="text-sm text-muted-foreground">Live tail, refreshed every few seconds.</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={source === "proxy" ? "default" : "outline"}
            onClick={() => setSource("proxy")}
          >
            CLIProxyAPI
          </Button>
          <Button
            size="sm"
            variant={source === "backend" ? "default" : "outline"}
            onClick={() => setSource("backend")}
          >
            Backend
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            {source === "proxy" ? "CLIProxyAPI request log" : "Backend process log"}
          </CardTitle>
          <CardDescription>Most recent lines at the bottom.</CardDescription>
        </CardHeader>
        <CardContent>
          <LogViewer
            lines={lines}
            downloadFilename={source === "proxy" ? "cliproxyapi-log.txt" : "backend-log.txt"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
