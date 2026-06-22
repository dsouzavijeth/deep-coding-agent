"use client";

import { useEffect, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

// Map file extensions to Prism language ids for syntax highlighting.
const EXT_LANG: Record<string, string> = {
  py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  json: "json", md: "markdown", mdx: "markdown", css: "css", scss: "scss",
  html: "markup", xml: "markup", yml: "yaml", yaml: "yaml", toml: "toml",
  sh: "bash", bash: "bash", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
  swift: "swift", sql: "sql", dockerfile: "docker", graphql: "graphql",
};

function langFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "docker";
  const ext = name.split(".").pop() ?? "";
  return EXT_LANG[ext] ?? "text";
}

export function FileViewer({
  repoId,
  path,
  refreshSignal,
}: {
  repoId: string;
  path: string | null;
  refreshSignal?: unknown;
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
      <div className="viewer-body">
        <SyntaxHighlighter
          language={langFor(path)}
          style={vscDarkPlus}
          showLineNumbers
          wrapLongLines={false}
          customStyle={{
            margin: 0,
            padding: "14px 16px",
            background: "transparent",
            fontSize: 12.5,
            minHeight: "100%",
          }}
          lineNumberStyle={{ opacity: 0.35, minWidth: "2.5em" }}
          codeTagProps={{ style: { fontFamily: "ui-monospace, monospace" } }}
        >
          {content}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
