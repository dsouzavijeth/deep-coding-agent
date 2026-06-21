"use client";

// Render a cloned or local repo's directory, and kick off the clone/load.

import { useState, useCallback, useEffect } from "react";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export type Node = {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: Node[];
};

export type RepoSession = {
  repoId: string;
  agentPath: string;
  tree: Node;
  location?: string;
  graphify?: boolean;
};

// POST /repos with a gitUrl or localPath (and optional clone dest); returns what
// the app needs to wire up.
export async function openRepo(input: {
  gitUrl?: string;
  localPath?: string;
  dest?: string;
}): Promise<RepoSession> {
  const res = await fetch(`${BACKEND}/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      git_url: input.gitUrl,
      local_path: input.localPath,
      dest: input.dest,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`openRepo failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return {
    repoId: data.repo_id,
    agentPath: data.agent_path,
    tree: data.tree,
    location: data.location,
    graphify: data.graphify,
  };
}

function TreeNode({
  node,
  depth,
  onOpenFile,
  activePath,
}: {
  node: Node;
  depth: number;
  onOpenFile?: (path: string) => void;
  activePath?: string | null;
}) {
  const [open, setOpen] = useState(depth < 1);
  const indent = { paddingLeft: depth * 14 };

  if (node.type === "file") {
    const active = activePath === node.path;
    return (
      <div
        className={`tree-file${active ? " active" : ""}`}
        style={{ ...indent, padding: "2px 4px", cursor: "pointer" }}
        title={node.path}
        onClick={() => onOpenFile?.(node.path)}
      >
        <span style={{ opacity: 0.4 }}>·</span> {node.name}
      </div>
    );
  }
  return (
    <div>
      <div
        style={{ ...indent, padding: "2px 4px", cursor: "pointer", fontWeight: 500 }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} {node.name}
      </div>
      {open &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onOpenFile={onOpenFile}
            activePath={activePath}
          />
        ))}
    </div>
  );
}

export function FileTree({
  repoId,
  initialTree,
  refreshSignal,
  onOpenFile,
  activePath,
}: {
  repoId: string;
  initialTree: Node;
  refreshSignal?: unknown; // bump to refetch (e.g. after an agent file write)
  onOpenFile?: (path: string) => void;
  activePath?: string | null;
}) {
  const [tree, setTree] = useState<Node>(initialTree);

  const refresh = useCallback(async () => {
    const res = await fetch(`${BACKEND}/repos/${repoId}/tree`);
    if (res.ok) setTree(await res.json());
  }, [repoId]);

  useEffect(() => {
    setTree(initialTree);
  }, [initialTree]);

  useEffect(() => {
    if (refreshSignal !== undefined) refresh();
  }, [refreshSignal, refresh]);

  return (
    <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <strong style={{ wordBreak: "break-all" }}>{repoId}</strong>
        <button onClick={refresh} style={{ fontSize: 12, cursor: "pointer" }}>
          refresh
        </button>
      </div>
      <TreeNode
        node={tree}
        depth={0}
        onOpenFile={onOpenFile}
        activePath={activePath}
      />
    </div>
  );
}
