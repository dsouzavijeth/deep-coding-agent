"use client";

// Render every agent tool call (ls, read_file, edit_file, execute, graphify
// query_graph, …) as a compact chip instead of CopilotKit's big default card.

import { useCopilotAction } from "@copilotkit/react-core";

export function ToolRender() {
  useCopilotAction({
    name: "*", // catch-all: applies to any tool the agent calls
    render: ({ name, status, args }: any) => {
      const detail =
        args?.file_path || args?.path || args?.command || args?.query || "";
      const done = status === "complete";
      return (
        <div className={`tool-chip ${done ? "done" : "running"}`}>
          <span className="tool-icon">{done ? "✓" : "⋯"}</span>
          <span className="tool-name">{name}</span>
          {detail ? <span className="tool-detail">{String(detail)}</span> : null}
        </div>
      );
    },
  });
  return null;
}
