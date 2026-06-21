"use client";

import { useState } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { RepoOpener } from "../components/RepoOpener";
import { FileTree, type RepoSession } from "../components/FileTree";
import { FileViewer } from "../components/FileViewer";
import { ApprovalGate } from "../components/ApprovalGate";
import { ToolRender } from "../components/ToolRender";
import { useRepoWatch } from "../components/useRepoWatch";

export default function Home() {
  const [session, setSession] = useState<RepoSession | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // Bumped whenever files actually change on disk; drives tree + viewer refetch.
  const [refreshTick, setRefreshTick] = useState(0);

  // Real file-change events from the backend watcher (agent edits, shell output,
  // external changes). Refresh on anything that isn't filtered out server-side.
  useRepoWatch(session?.repoId, () => setRefreshTick((t) => t + 1));

  return (
    <div className="workbench">
      <aside className="sidebar">
        <h3 style={{ marginTop: 0 }}>Deep Coding Agent</h3>
        <RepoOpener onOpen={setSession} />
        {session && (
          <>
            <div className="repo-meta">
              <div title={session.location} className="repo-loc">
                📁 {session.location}
              </div>
              <div className="repo-graph">
                {session.graphify ? "🔗 graphify graph attached" : "graphify: off"}
              </div>
            </div>
            <FileTree
              repoId={session.repoId}
              initialTree={session.tree}
              refreshSignal={refreshTick}
              onOpenFile={setSelectedFile}
              activePath={selectedFile}
            />
          </>
        )}
      </aside>

      <section className="center">
        {session ? (
          <FileViewer
            repoId={session.repoId}
            path={selectedFile}
            refreshSignal={refreshTick}
          />
        ) : (
          <div className="empty">Open a repo to start.</div>
        )}
      </section>

      <section className="chat">
        {session ? (
          <CopilotKit
            runtimeUrl="/api/copilotkit"
            agent={session.repoId}
            headers={{ "x-agent-id": session.repoId }}
          >
            {/* Renders edit/exec approval cards in the chat. The tree + viewer
                update from the filesystem watcher, not from the approval click. */}
            <ApprovalGate />
            <ToolRender />
            <CopilotChat
              labels={{
                title: `Agent · ${session.repoId}`,
                initial:
                  "I'm scoped to this repository. Ask me to explore, explain, or change the code — edits and commands will pause for your approval.",
              }}
              className="copilot-chat"
            />
          </CopilotKit>
        ) : (
          <div className="empty">Clone a URL or load a local path.</div>
        )}
      </section>
    </div>
  );
}
