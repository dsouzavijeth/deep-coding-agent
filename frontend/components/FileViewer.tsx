"use client";

import { useEffect, useState } from "react";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export function FileViewer({
  repoId,
  path,
  refreshSignal,
}: {
  repoId: string;
  path: string | null;
  refreshSignal?: unknown; // bump to re-read (e.g. after the agent edits it)
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    fetch(`${BACKEND}/repos/${repoId}/file?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setContent(d.content))
      .catch(() => setContent("// could not load file"))
      .finally(() => setLoading(false));
  }, [repoId, path, refreshSignal]);

  if (!path) return <div className="empty">Select a file to view it.</div>;

  return (
    <div className="viewer">
      <div className="viewer-head">
        {path}
        {loading ? " · loading…" : ""}
      </div>
      <pre className="viewer-body">
        <code>{content}</code>
      </pre>
    </div>
  );
}
