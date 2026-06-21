"""Connect graphify to the agent, per codebase.

Pipeline for one repo:
  1. `graphify extract <workspace>`  -> writes <workspace>/graphify-out/graph.json
  2. `python -m graphify.serve graph.json --transport http --port <p>`
     -> a per-repo MCP server exposing query_graph, get_node, get_neighbors,
        shortest_path at http://127.0.0.1:<p>/mcp
  3. load those MCP tools via langchain-mcp-adapters and hand them to the repo's
     deepagents agent, so it queries the graph instead of grepping.

Requires graphify installed in THIS environment:  pip install "graphifyy[mcp]"
"""

from __future__ import annotations

import socket
import subprocess
import sys
from pathlib import Path

from .config import settings

# repo_id -> running graphify MCP server process (so we can stop them later).
_SERVERS: dict[str, subprocess.Popen] = {}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# File types graphify can only process with an LLM backend (docs, images, …).
# When no backend is configured we exclude them so extraction runs key-free on
# code alone, instead of graphify aborting the whole run.
_SEMANTIC_GLOBS = [
    "*.md", "*.mdx", "*.qmd", "*.rst", "*.txt", "*.html", "*.yaml", "*.yml",
    "*.pdf", "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif",
    "*.docx", "*.xlsx", "*.mp4", "*.mov", "*.mp3", "*.wav",
]


def _ensure_code_only(workspace: Path) -> None:
    """Write a .graphifyignore excluding files that need an LLM, so extraction
    needs no API key. Skipped for symlinked (local) repos to avoid writing into
    your real project."""
    if workspace.is_symlink():
        return
    ignore = workspace / ".graphifyignore"
    if not ignore.exists():
        ignore.write_text("\n".join(_SEMANTIC_GLOBS) + "\n", encoding="utf-8")


def build_graph(workspace: Path) -> Path | None:
    """Run `graphify extract` on the workspace; return graph.json or None."""
    cmd = [sys.executable, "-m", "graphify", "extract", str(workspace)]
    if settings.graphify_extract_backend:
        # An LLM backend is configured → extract docs/images too. The subprocess
        # inherits this process's env, so export e.g. OPENAI_API_KEY before
        # launching uvicorn for graphify to pick it up.
        cmd += ["--backend", settings.graphify_extract_backend]
    else:
        _ensure_code_only(workspace)  # keyless: code only

    try:
        result = subprocess.run(
            cmd, check=False, capture_output=True, text=True, timeout=900
        )
    except Exception as exc:
        print(f"[graphify] extract failed to run: {exc}")
        return None

    graph = workspace / "graphify-out" / "graph.json"
    if not graph.exists():
        print(f"[graphify] no graph produced. stderr: {result.stderr.strip()[:500]}")
        return None
    return graph


def start_server(repo_id: str, graph: Path) -> str | None:
    """Start a per-repo graphify MCP server over HTTP; return its /mcp URL."""
    port = _free_port()
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "graphify.serve", str(graph),
            "--transport", "http", "--host", "127.0.0.1",
            "--port", str(port), "--path", "/mcp",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _SERVERS[repo_id] = proc
    return f"http://127.0.0.1:{port}/mcp"


async def load_tools(url: str) -> list:
    """Load the graphify MCP tools as LangChain tools (retries until ready)."""
    import asyncio

    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient(
        {"graphify": {"url": url, "transport": "streamable_http"}}
    )
    last_err: Exception | None = None
    for _ in range(10):  # server takes a moment to bind
        try:
            return await client.get_tools()
        except Exception as exc:
            last_err = exc
            await asyncio.sleep(1)
    print(f"[graphify] could not load tools from {url}: {last_err}")
    return []


def stop_all() -> None:
    for proc in _SERVERS.values():
        proc.terminate()
    _SERVERS.clear()


async def attach(repo_id: str, workspace: Path) -> list:
    """Build the graph, serve it, and return MCP tools for this repo."""
    graph = build_graph(workspace)
    if graph is None:
        return []
    url = start_server(repo_id, graph)
    return await load_tools(url) if url else []
