// A tiny module-level store that bridges a deepagents HITL interrupt between the
// chat (ApprovalGate, inside the CopilotKit provider) and the editor (EditorPane,
// outside it). The chat captures the interrupt's actions + resolve and publishes
// them here; the editor subscribes and can resolve the same interrupt. Either
// pane approving/rejecting calls the one shared `resolve`, so they stay in sync.

export type PendingInterrupt = {
  actions: Array<{ name: string; args: Record<string, any>; description?: string }>;
  resolve: (value: any) => void;
};

let state: PendingInterrupt | null = null;
let lastKey = ""; // identifies the current interrupt so repeat renders don't re-fire
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export const interruptStore = {
  // Called from ApprovalGate's render. `key` is derived from the interrupt's
  // content; identical keys are ignored so re-renders don't loop.
  set(pending: PendingInterrupt, key: string) {
    if (key === lastKey) return;
    lastKey = key;
    state = pending;
    notify();
  },
  // Keep lastKey after clearing so the just-resolved interrupt can't reopen.
  clear() {
    if (state === null) return;
    state = null;
    notify();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get(): PendingInterrupt | null {
    return state;
  },
};
