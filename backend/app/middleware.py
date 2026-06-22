"""Surface CopilotKit readable context to the model.

The AG-UI adapter parks frontend readables (e.g. the file the user has open in
the viewer — see frontend OpenFileContext.tsx) in graph state under
`state["ag-ui"]["context"]`, but it never injects them into the prompt. That
injection is normally CopilotKit middleware's job, and a plain deepagents agent
has none — which is why the model otherwise has no idea what file is open.

This middleware closes that gap:
  1. it extends the agent state so LangGraph keeps the "ag-ui" channel (unknown
     input keys are otherwise dropped before a node ever sees them), and
  2. it appends those readables to the system prompt before each model call.
"""

from __future__ import annotations

from typing import Callable

from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import SystemMessage
from typing_extensions import TypedDict

# Declaring the (hyphenated) key keeps LangGraph from discarding the channel.
AgUiContextState = TypedDict("AgUiContextState", {"ag-ui": dict}, total=False)


class CopilotContextMiddleware(AgentMiddleware):
    """Inject `state['ag-ui']['context']` (CopilotKit readables) into the prompt."""

    state_schema = AgUiContextState

    def _with_context(self, request: ModelRequest) -> ModelRequest:
        context = (request.state.get("ag-ui") or {}).get("context") or []
        if not context:
            return request

        def field(item: object, name: str) -> str:
            # Items may be ag-ui Context pydantic objects or plain dicts.
            if isinstance(item, dict):
                return str(item.get(name, ""))
            return str(getattr(item, name, ""))

        lines = [
            f"- {field(item, 'description')}: {field(item, 'value')}"
            for item in context
        ]
        addendum = "\n\n## Live context from the user's UI\n" + "\n".join(lines)
        base = request.system_message
        base_text = (
            ""
            if base is None
            else (base.content if isinstance(base.content, str) else str(base.content))
        )
        return request.override(
            system_message=SystemMessage(content=base_text + addendum)
        )

    def wrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]
    ) -> ModelResponse:
        return handler(self._with_context(request))

    async def awrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]
    ) -> ModelResponse:
        return await handler(self._with_context(request))
