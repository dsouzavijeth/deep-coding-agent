"use client";

// Subscribe to real filesystem changes for a repo over a WebSocket. Calls
// onChanges(paths) whenever files under the workspace are added/modified/deleted
// — by the agent, by shell commands, or externally. Reconnects automatically.

import { useEffect, useRef } from "react";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export function useRepoWatch(
  repoId: string | null | undefined,
  onChanges: (paths: string[]) => void
) {
  const cb = useRef(onChanges);
  cb.current = onChanges;

  useEffect(() => {
    if (!repoId) return;

    const wsUrl =
      BACKEND.replace(/^http/, "ws") + `/repos/${repoId}/watch`;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          const paths: string[] = (data.changes ?? []).map((c: any) => c.path);
          if (paths.length) cb.current(paths);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1500); // auto-reconnect
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [repoId]);
}
