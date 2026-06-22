"use client";

// Renders deepagents' human-in-the-loop interrupts (gated by `interrupt_on` on
// the backend) as an approve/reject card that shows a diff/preview BEFORE you
// decide. Mounted inside the CopilotKit provider; the card appears in the chat.
//
// Schema (deepagents HumanInTheLoopMiddleware):
//   interrupt value  -> { action_requests: [{ name, args, description? }], review_configs: [...] }
//   resume value     -> { decisions: [{ type: "approve" } | { type: "reject" }, ...] }  (one per action)

import { useLangGraphInterrupt } from "@copilotkit/react-core";
import { DiffView } from "./DiffView";

type ActionRequest = {
  name: string;
  args: Record<string, any>;
  description?: string;
};

// The interrupt value may arrive as an object or a JSON string; older/alternate
// shapes are normalized to the current action_requests form.
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

function ActionPreview({ name, args }: { name: string; args: Record<string, any> }) {
  if (name === "edit_file") {
    return <DiffView oldText={String(args.old_string ?? "")} newText={String(args.new_string ?? "")} />;
  }
  if (name === "write_file") {
    return <DiffView newText={String(args.content ?? "")} />;
  }
  if (name === "execute") {
    return <pre className="cmd">{String(args.command ?? "")}</pre>;
  }
  return <pre className="cmd">{JSON.stringify(args, null, 2)}</pre>;
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

      const decide = (type: "approve" | "reject") => {
        // One decision per action request, in order.
        resolve({ decisions: Array.from({ length: count }, () => ({ type })) });
        onResolved?.(type === "approve");
      };

      return (
        <div className="approval">
          {actions.length === 0 && (
            <div className="approval-head">Approve this action?</div>
          )}
          {actions.map((a, i) => (
            <div key={i} className="approval-item">
              <div className="approval-head">
                <code>{a.name === "execute" ? "run command" : a.name}</code>
                {a.args?.file_path && (
                  <>
                    {" "}
                    on <code>{String(a.args.file_path)}</code>
                  </>
                )}
              </div>
              <ActionPreview name={a.name} args={a.args ?? {}} />
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
