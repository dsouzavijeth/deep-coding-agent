"""Build a deepagents agent rooted at a single repository.

The `root_dir` of the backend is the entire mechanism that makes the agent work
on *any* repo: point it at a cloned or local path and the agent's file tools
(ls, read_file, write_file, edit_file, glob, grep) and shell (execute) all
resolve under that directory.

SECURITY: LocalShellBackend runs unrestricted shell + filesystem operations on
THIS host. Acceptable for trusted local development only. For arbitrary or
untrusted repositories, replace it with a sandbox backend (E2B, Daytona, Modal,
Vercel, AgentCore) so each repo executes in isolation.
"""

from __future__ import annotations

from pathlib import Path

from deepagents import create_deep_agent
from deepagents.backends import LocalShellBackend

from .config import settings
from .middleware import CopilotContextMiddleware

SYSTEM_PROMPT = (
    "You are a coding assistant working inside a single repository. "
    "Plan before acting using your todo tool, read files before editing them, "
    "and explain what you changed. Prefer small, verifiable steps. "
    "If knowledge-graph tools (query_graph, shortest_path, get_neighbors) are "
    "available, prefer them over grepping to understand how the code connects. "
    "Only use tools that are actually available to you — never invent or guess a "
    "tool name. Once you have gathered enough context, always finish your turn "
    "with a clear written answer or recommendation; do not stop after tool calls."
)


def _model():
    """Return the chat model. Nebius (OpenAI-compatible) if configured."""
    if settings.nebius_api_key:
        # Imported lazily so Anthropic-only setups don't need langchain-openai.
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=settings.nebius_model,
            base_url=settings.nebius_base_url,
            api_key=settings.nebius_api_key,
            temperature=settings.nebius_temperature,
            top_p=settings.nebius_top_p,
        )
    return settings.model  # e.g. "anthropic:claude-sonnet-4-6"


def build_agent(workspace: Path, checkpointer=None, tools: list | None = None):
    """A compiled deepagents graph scoped to `workspace`.

    `tools` are extra tools (e.g. graphify's knowledge-graph MCP tools) on top of
    the built-in filesystem + shell tools.
    """
    # DEV backend (trusted repos only). virtual_mode=True confines the file
    # tools (read/write/edit/ls/glob/grep) to the repo by blocking absolute
    # paths and '..'. NOTE: it does NOT sandbox `execute` — shell still runs on
    # the host. For untrusted repos, swap in a sandbox backend instead.
    backend = LocalShellBackend(root_dir=str(workspace), virtual_mode=True)

    # PROD: isolate each repo instead, e.g.
    #   from langchain_e2b import E2BSandbox
    #   from e2b import Sandbox
    #   backend = E2BSandbox(sandbox=Sandbox.create())

    return create_deep_agent(
        model=_model(),
        backend=backend,
        tools=tools or [],
        system_prompt=SYSTEM_PROMPT,
        # Inject CopilotKit readables (e.g. the file open in the viewer) into the
        # prompt — the AG-UI adapter only parks them in state otherwise.
        middleware=[CopilotContextMiddleware()],
        # Pause for human approval before mutating files or shelling out. The
        # frontend renders these as a diff/approval card (see ApprovalGate).
        interrupt_on={"execute": True, "write_file": True, "edit_file": True},
        checkpointer=checkpointer,
    )
