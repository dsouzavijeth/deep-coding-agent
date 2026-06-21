"use client";

import { useEffect, useState } from "react";
import { openRepo, type RepoSession } from "./FileTree";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export function RepoOpener({
  onOpen,
}: {
  onOpen: (session: RepoSession) => void;
}) {
  const [value, setValue] = useState("");
  const [dest, setDest] = useState("");
  const [defaultDir, setDefaultDir] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the suggested clone directory as a hint.
  useEffect(() => {
    fetch(`${BACKEND}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => c && setDefaultDir(c.workspaces_dir))
      .catch(() => {});
  }, []);

  const open = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const isUrl = /^(https?:\/\/|git@)/.test(v);
      const session = await openRepo({
        ...(isUrl ? { gitUrl: v } : { localPath: v }),
        // Destination only applies to clones; local paths load in place.
        ...(isUrl && dest.trim() ? { dest: dest.trim() } : {}),
      });
      onOpen(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const looksLikeUrl = /^(https?:\/\/|git@)/.test(value.trim());

  return (
    <div>
      <div className="repo-opener">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && open()}
          placeholder="GitHub URL or local path"
        />
        <button onClick={open} disabled={busy}>
          {busy ? "Opening…" : "Open"}
        </button>
      </div>

      {looksLikeUrl && (
        <input
          className="dest-input"
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          placeholder={`clone into… (default: ${defaultDir || "./workspaces"}/<id>)`}
        />
      )}

      {error && (
        <div style={{ color: "#b00", fontSize: 12, margin: "8px 0 12px" }}>
          {error}
        </div>
      )}
    </div>
  );
}
