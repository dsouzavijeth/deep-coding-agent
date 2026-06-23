"use client";

// The center pane. Normally a read-only Monaco editor of the selected file.
// When the agent proposes an edit (a pending HITL interrupt in interruptStore),
// it auto-switches to Monaco's inline DiffEditor for that file and shows
// Approve/Reject — resolving the same interrupt the chat is showing.

import { useEffect, useState, useSyncExternalStore } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { interruptStore } from "./interruptStore";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

const EXT_LANG: Record<string, string> = {
  py: "python", ts: "typescript", tsx: "typescript", js: "javascript",
  jsx: "javascript", json: "json", md: "markdown", css: "css", scss: "scss",
  html: "html", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", sh: "shell",
  bash: "shell", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", sql: "sql", dockerfile: "dockerfile",
};

function langFor(path?: string | null): string {
  if (!path) return "plaintext";
  const ext = path.split(/[\\/]/).pop()!.split(".").pop()!.toLowerCase();
  return EXT_LANG[ext] ?? "plaintext";
}

// deepagents file_path is a virtual absolute path ("/supervisor/agent.py");
// strip the leading slash to get a repo-relative path for the file endpoint.
function toRel(p: string): string {
  return p.replace(/^[/\\]+/, "");
}

async function fetchFile(repoId: string, relPath: string): Promise<string> {
  try {
    const r = await fetch(
      `${BACKEND}/repos/${repoId}/file?path=${encodeURIComponent(relPath)}`,
    );
    if (!r.ok) return "";
    const d = await r.json();
    return typeof d?.content === "string" ? d.content : "";
  } catch {
    return "";
  }
}

// Compute the proposed file contents from the pending action.
function applyEdit(original: string, action: { name: string; args: any }): string {
  if (action.name === "write_file") return String(action.args?.content ?? "");
  if (action.name === "edit_file") {
    const oldS = String(action.args?.old_string ?? "");
    const newS = String(action.args?.new_string ?? "");
    if (!oldS) return original;
    return action.args?.replace_all
      ? original.split(oldS).join(newS)
      : original.replace(oldS, newS);
  }
  return original;
}

const MONACO_OPTS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12.5,
  automaticLayout: true,
} as const;

export function EditorPane({
  repoId,
  path,
  refreshSignal,
}: {
  repoId: string;
  path: string | null;
  refreshSignal?: unknown;
}) {
  const pending = useSyncExternalStore(
    interruptStore.subscribe,
    interruptStore.get,
    interruptStore.get,
  );
  const editAction = pending?.actions?.find(
    (a) => a.name === "edit_file" || a.name === "write_file",
  );

  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [modified, setModified] = useState("");

  // Normal view: load the selected file (skip while a diff is showing).
  useEffect(() => {
    if (editAction || !path) return;
    let alive = true;
    fetchFile(repoId, path).then((c) => alive && setContent(c));
    return () => {
      alive = false;
    };
  }, [repoId, path, refreshSignal, editAction]);

  // Diff view: load the target file and compute the proposed contents.
  useEffect(() => {
    if (!editAction) return;
    let alive = true;
    const rel = toRel(String(editAction.args?.file_path ?? ""));
    fetchFile(repoId, rel).then((orig) => {
      if (!alive) return;
      setOriginal(orig);
      setModified(applyEdit(orig, editAction));
    });
    return () => {
      alive = false;
    };
  }, [repoId, editAction]);

  if (editAction && pending) {
    const file = String(editAction.args?.file_path ?? "");
    const decide = (type: "approve" | "reject") => {
      const count = pending.actions.length || 1;
      pending.resolve({
        decisions: Array.from({ length: count }, () => ({ type })),
      });
      interruptStore.clear();
    };
    return (
      <div className="viewer">
        <div className="viewer-head diff-head">
          <span>
            Proposed change · <code>{file}</code>
          </span>
          <span className="diff-actions">
            <button className="btn approve" onClick={() => decide("approve")}>
              Approve
            </button>
            <button className="btn reject" onClick={() => decide("reject")}>
              Reject
            </button>
          </span>
        </div>
        <div className="viewer-body">
          <DiffEditor
            original={original}
            modified={modified}
            language={langFor(file)}
            theme="vs-dark"
            height="100%"
            options={{ ...MONACO_OPTS, renderSideBySide: false }}
          />
        </div>
      </div>
    );
  }

  if (!path) return <div className="empty">Select a file to view it.</div>;

  return (
    <div className="viewer">
      <div className="viewer-head">{path}</div>
      <div className="viewer-body">
        <Editor
          path={path}
          value={content}
          language={langFor(path)}
          theme="vs-dark"
          height="100%"
          options={MONACO_OPTS}
        />
      </div>
    </div>
  );
}
