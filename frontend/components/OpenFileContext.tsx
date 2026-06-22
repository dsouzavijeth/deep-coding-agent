"use client";

// Tells the agent which file the user has open in the viewer, so "this file",
// "the open file", etc. resolve to it. Shared via CopilotKit's readable context,
// which flows to the LangGraph agent as AG-UI context.

import { useEffect, useState } from "react";
import { useCopilotReadable } from "@copilotkit/react-core";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export function OpenFileContext({
  repoId,
  path,
}: {
  repoId: string;
  path: string | null;
}) {
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!path) {
      setContent("");
      return;
    }
    fetch(`${BACKEND}/repos/${repoId}/file?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : null))
      // Cap the snippet so a huge file doesn't blow up the agent's context.
      .then((d) => setContent(d?.content ? String(d.content).slice(0, 8000) : ""))
      .catch(() => setContent(""));
  }, [repoId, path]);

  useCopilotReadable({
    description:
      "The file the user currently has open in the editor pane. When they say " +
      "'this file', 'the open file', or 'here', they mean this one. Prefer your " +
      "own read_file tool if you need the full, current contents.",
    value: path ? { path, snippet: content } : "No file is currently open.",
  });

  return null;
}
