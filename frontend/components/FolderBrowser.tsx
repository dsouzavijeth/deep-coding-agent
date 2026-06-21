"use client";

// A server-side folder picker. Navigates the host's directories via the
// backend's /fs/list endpoint (the backend runs locally, so it can see the real
// filesystem that the browser cannot). Returns the chosen absolute path.

import { useEffect, useState } from "react";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

type Entry = { name: string; path: string };
type Listing = { path: string; parent: string | null; entries: Entry[] };

export function FolderBrowser({
  onPick,
  onClose,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (path: string | null) => {
    setError(null);
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    fetch(`${BACKEND}/fs/list${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setListing)
      .catch(() => setError("Could not read that folder."));
  };

  // Start at the default workspaces dir's location, falling back to root.
  useEffect(() => {
    fetch(`${BACKEND}/config`)
      .then((r) => r.json())
      .then((c) => load(c.workspaces_dir || null))
      .catch(() => load(null));
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Choose a folder to clone into</strong>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="modal-path">{listing?.path || "This PC"}</div>

        <div className="modal-list">
          {listing?.parent !== null && listing?.parent !== undefined && (
            <div className="modal-row up" onClick={() => load(listing.parent || null)}>
              ⬆ ..
            </div>
          )}
          {listing?.entries.map((e) => (
            <div key={e.path} className="modal-row" onClick={() => load(e.path)}>
              📁 {e.name}
            </div>
          ))}
          {listing && listing.entries.length === 0 && (
            <div className="modal-empty">No subfolders.</div>
          )}
          {error && <div className="modal-empty">{error}</div>}
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!listing?.path}
            onClick={() => listing?.path && onPick(listing.path)}
          >
            Clone here
          </button>
        </div>
      </div>
    </div>
  );
}
