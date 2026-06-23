"use client";

// Captures deepagents' HITL interrupts and (1) publishes them to interruptStore
// so the editor can show the diff + Approve/Reject, and (2) renders a compact
// chat card. File edits are reviewed in the editor; `execute` shows its command
// here. Approving/rejecting from either place resolves the same interrupt.
//
//   interrupt value -> { action_requests: [{ name, args, description? }], review_configs: [...] }
//   resume value    -> { decisions: [{ type: "approve" | "reject" }, ...] }  (one per action)

import { useLangGraphInterrupt } from "@copilotkit/react-core";
import { interruptStore } from "./interruptStore";

type ActionRequest = {
  name: string;
  args: Record<string, any>;
  description?: string;
};

function normalize(raw: any): ActionRequest[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!v) return [];
  if (Array.isArray(v.action_requests)) return v.action_requests as ActionRequest[];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x: any) => ({
    name: x?.name ?? x?.action_request?.action ?? x?.action ?? "action",
    args: x?.args ?? x?.action_request?.args ?? {},
    description: x?.description ?? x?.action_request?.description,
  }));
}

export function ApprovalGate({
  onResolved,
}: {
  onResolved?: (approved: boolean) => void;
}) {
  useLangGraphInterrupt({
    render: ({ event, resolve }) => {
      const actions = normalize((event as any)?.value);
      const count = actions.length || 1;

      // Publish to the store (deferred so we don't set state during render) so
      // the editor can render the diff. Keyed by content to avoid re-fires.
      const key = JSON.stringify(actions);
      queueMicrotask(() => interruptStore.set({ actions, resolve }, key));

      const decide = (type: "approve" | "reject") => {
        resolve({ decisions: Array.from({ length: count }, () => ({ type })) });
        interruptStore.clear();
        onResolved?.(type === "approve");
      };

      const fileEdits = actions.filter(
        (a) => a.name === "edit_file" || a.name === "write_file",
      );
      const commands = actions.filter((a) => a.name === "execute");

      return (
        <div className="approval">
          {fileEdits.map((a, i) => (
            <div key={`f${i}`} className="approval-head">
              ✎ <code>{a.name}</code> on <code>{String(a.args?.file_path ?? "")}</code>{" "}
              — review the diff in the editor →
            </div>
          ))}
          {commands.map((a, i) => (
            <div key={`c${i}`}>
              <div className="approval-head">
                <code>run command</code>
              </div>
              <pre className="cmd">{String(a.args?.command ?? "")}</pre>
            </div>
          ))}

          <div className="approval-actions">
            <button className="btn approve" onClick={() => decide("approve")}>
              Approve
            </button>
            <button className="btn reject" onClick={() => decide("reject")}>
              Reject
            </button>
          </div>
        </div>
      );
    },
  });

  return null;
}
