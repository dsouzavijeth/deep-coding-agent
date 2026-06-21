// app/api/copilotkit/route.ts
//
// The CopilotKit runtime brokers between the React app and the backend agent.
// Each repo is its own AG-UI endpoint at /agent/{repo_id}, so we build the
// agent dynamically from an `x-agent-id` header the client forwards.
//
// IMPORTANT (self-hosted FastAPI): use LangGraphHttpAgent pointed at the URL.
// Do NOT use LangGraphAgent({ deploymentUrl, graphId }) — that form is only for
// LangGraph Platform deployments and will fail against a plain FastAPI endpoint.

import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { LangGraphHttpAgent } from "@ag-ui/langgraph";
import { NextRequest } from "next/server";

const BACKEND =
  process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export const POST = async (req: NextRequest) => {
  const agentId = req.headers.get("x-agent-id") ?? "default";

  const runtime = new CopilotRuntime({
    agents: {
      [agentId]: new LangGraphHttpAgent({
        url: `${BACKEND}/agent/${agentId}`,
      }),
    },
  });

  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
};
