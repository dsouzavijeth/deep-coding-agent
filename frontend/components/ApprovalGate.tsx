"use client";

// Renders deepagents' human-in-the-loop interrupts (gated by `interrupt_on` on
// the backend) as an approve/reject card with a diff for file edits. Mounted
// inside the CopilotKit provider; the card appears in the chat stream.

import { useLangGraphInterrupt } from "@copilotkit/react-core";
import { DiffView } from "./DiffView";

export function ApprovalGate({
  onResolved,
}: {
  onResolved?: (approved: boolean) => void;
}) {
  useLangGraphInterrupt({
    render: ({ event, resolve }) => {
      // deepagents HITL surfaces a list of action requests. The exact shape can
      // vary by version, so read defensively.
      const raw: any = (event as any)?.value;
      const req = (Array.isArray(raw) ? raw[0] : raw) ?? {};
      const action: string = req?.action_request?.action ?? req?.action ?? "action";
      const args: any = req?.action_request?.args ?? req?.args ?? {};

      const approve = () => {
        resolve([{ type: "accept" }]);
        onResolved?.(true);
      };
      const reject = () => {
        resolve([{ type: "ignore" }]);
        onResolved?.(false);
      };

      return (
        <div className="approval">
          <div className="approval-head">
            Approve <code>{action}</code>
            {args.file_path && (
              <>
                {" "}
                on <code>{args.file_path}</code>
              </>
            )}
          </div>

          {action === "edit_file" && (
            <DiffView oldText={args.old_string} newText={args.new_string} />
          )}
          {action === "write_file" && <DiffView newText={args.content} />}
          {action === "execute" && <pre className="cmd">{args.command}</pre>}

          <div className="approval-actions">
            <button className="btn approve" onClick={approve}>
              Approve
            </button>
            <button className="btn reject" onClick={reject}>
              Reject
            </button>
          </div>
        </div>
      );
    },
  });

  return null;
}
