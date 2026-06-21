"""Per-repo workspaces: clone a GitHub URL or link a local path, give each repo
its own deepagents agent mounted at /agent/{repo_id}, and serve its file tree.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import string
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from watchfiles import awatch

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent

from .agent import build_agent
from .config import settings

WORKSPACES = Path(settings.workspaces_dir).resolve()
WORKSPACES.mkdir(parents=True, exist_ok=True)

# Directories hidden from the rendered tree.
IGNORE = {".git", "node_modules", ".venv", "__pycache__", "dist", "build", "graphify-out"}

# repo_id -> workspace path
_REGISTRY: dict[str, Path] = {}

router = APIRouter()


class NewRepo(BaseModel):
    git_url: str | None = None      # clone this...
    local_path: str | None = None   # ...or use a repo already on disk
    repo_id: str | None = None      # optional stable id; otherwise generated
    dest: str | None = None         # optional clone destination (overrides default)


def _clear(dest: Path) -> None:
    if dest.is_symlink():
        dest.unlink()
    elif dest.exists():
        shutil.rmtree(dest)


def _materialize(req: NewRepo) -> tuple[str, Path]:
    repo_id = req.repo_id or uuid.uuid4().hex[:12]
    # Default location is WORKSPACES/<repo_id>; a user-supplied `dest` overrides it.
    dest = Path(req.dest).expanduser().resolve() if req.dest else WORKSPACES / repo_id
    _clear(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    if req.git_url:
        # --depth 1 keeps clones fast; drop it if the agent needs full history.
        result = subprocess.run(
            ["git", "clone", "--depth", "1", req.git_url, str(dest)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise HTTPException(400, f"git clone failed: {result.stderr.strip()}")
    elif req.local_path:
        src = Path(req.local_path).expanduser().resolve()
        if not src.is_dir():
            raise HTTPException(400, f"not a directory: {src}")
        # Symlink so the agent edits the real repo in place. Use
        # shutil.copytree(src, dest) instead for an isolated working copy.
        dest.symlink_to(src, target_is_directory=True)
    else:
        raise HTTPException(400, "provide either git_url or local_path")

    return repo_id, dest


def tree(root: Path, base: Path | None = None) -> dict:
    base = base or root
    rel = "." if root == base else str(root.relative_to(base))
    node = {"name": root.name or str(root), "path": rel, "type": "dir", "children": []}
    try:
        entries = sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except (PermissionError, FileNotFoundError):
        return node
    for entry in entries:
        if entry.name in IGNORE:
            continue
        if entry.is_dir():
            node["children"].append(tree(entry, base))
        else:
            node["children"].append(
                {"name": entry.name, "path": str(entry.relative_to(base)), "type": "file"}
            )
    return node


def mount_default_agent(app, checkpointer) -> None:
    """A scratch agent at /agent/default so the UI works before a repo opens."""
    scratch = WORKSPACES / "default"
    scratch.mkdir(parents=True, exist_ok=True)
    _REGISTRY["default"] = scratch
    agent = build_agent(scratch, checkpointer)
    add_langgraph_fastapi_endpoint(
        app,
        agent=LangGraphAGUIAgent(
            name="default",
            description="default agent",
            graph=agent,
            config={"recursion_limit": settings.agent_recursion_limit},
        ),
        path="/agent/default",
    )


@router.post("/repos")
async def create_repo(req: NewRepo, request: Request) -> dict:
    checkpointer = request.app.state.checkpointer
    repo_id, workspace = _materialize(req)
    _REGISTRY[repo_id] = workspace

    # Build + serve a per-repo graphify knowledge graph, and load its MCP tools.
    tools: list = []
    if settings.enable_graphify:
        from . import graphify
        tools = await graphify.attach(repo_id, workspace)

    agent = build_agent(workspace, checkpointer, tools=tools)
    add_langgraph_fastapi_endpoint(
        request.app,
        agent=LangGraphAGUIAgent(
            name=repo_id,
            description=f"agent for {repo_id}",
            graph=agent,
            config={"recursion_limit": settings.agent_recursion_limit},
        ),
        path=f"/agent/{repo_id}",
    )
    request.app.openapi_schema = None  # surface the new route in the schema

    return {
        "repo_id": repo_id,
        "agent_path": f"/agent/{repo_id}",  # frontend LangGraphHttpAgent url
        "location": str(workspace),         # where the repo lives on disk
        "graphify": bool(tools),            # whether the graph tool is attached
        "tree": tree(workspace),
    }


@router.get("/config")
async def get_config() -> dict:
    """Defaults the UI can show (e.g. the suggested clone directory)."""
    return {"workspaces_dir": str(WORKSPACES), "graphify": settings.enable_graphify}


@router.get("/fs/list")
async def fs_list(path: str | None = None) -> dict:
    """List directories on the host, to power a server-side folder picker.

    SECURITY: this exposes the host's directory structure to anything that can
    reach the backend. It's fine for local single-user dev (the agent already
    has full host access), but REMOVE or lock this down for any networked or
    multi-user deployment.
    """
    # No path → top level: Windows drive letters, or "/" on POSIX.
    if not path:
        if os.name == "nt":
            roots = [f"{d}:\\" for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
            return {
                "path": "",
                "parent": None,
                "entries": [{"name": r, "path": r} for r in roots],
            }
        path = "/"

    p = Path(path).expanduser()
    if not p.is_dir():
        raise HTTPException(400, "not a directory")
    p = p.resolve()

    entries = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                entries.append({"name": child.name, "path": str(child)})
    except PermissionError:
        pass

    # "" parent means "go back to the drive list / root".
    parent = "" if p.parent == p else str(p.parent)
    return {"path": str(p), "parent": parent, "entries": entries}


@router.get("/browse")
async def browse(path: str | None = None) -> dict:
    """List subdirectories of a path, for the UI folder picker.

    The backend runs on your machine, so this browses your real filesystem —
    fine for local dev. Do NOT expose this server to untrusted networks.
    """
    base = (Path(path).expanduser() if path else Path.home()).resolve()
    if not base.is_dir():
        raise HTTPException(400, "not a directory")
    dirs: list[str] = []
    try:
        for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if entry.is_dir() and not entry.name.startswith("."):
                dirs.append(entry.name)
    except PermissionError:
        pass
    parent = str(base.parent) if base.parent != base else None
    return {"path": str(base), "parent": parent, "dirs": dirs}


@router.get("/repos/{repo_id}/tree")
async def get_tree(repo_id: str) -> dict:
    workspace = _REGISTRY.get(repo_id)
    if workspace is None:
        raise HTTPException(404, "unknown repo_id")
    return tree(workspace)


@router.get("/repos/{repo_id}/file")
async def get_file(repo_id: str, path: str) -> dict:
    """Return the text content of a file under the repo (for the viewer)."""
    workspace = _REGISTRY.get(repo_id)
    if workspace is None:
        raise HTTPException(404, "unknown repo_id")
    root = workspace.resolve()
    target = (workspace / path).resolve()
    # Prevent path traversal outside the workspace.
    if root != target and root not in target.parents:
        raise HTTPException(400, "invalid path")
    if not target.is_file():
        raise HTTPException(404, "not a file")
    try:
        content = target.read_text(errors="replace")
    except Exception as exc:  # binary or unreadable
        raise HTTPException(400, f"cannot read file: {exc}")
    return {"path": path, "content": content}


def _keep_change(_change, path: str) -> bool:
    """watch_filter: drop changes inside ignored directories."""
    return not any(part in IGNORE for part in Path(path).parts)


async def _drain(websocket: WebSocket, stop: asyncio.Event) -> None:
    """Detect client disconnect and signal the watcher to stop."""
    try:
        while True:
            await websocket.receive_text()
    except Exception:
        pass
    finally:
        stop.set()


@router.websocket("/repos/{repo_id}/watch")
async def watch_repo(websocket: WebSocket, repo_id: str) -> None:
    """Stream real filesystem changes under the repo to the client.

    Emits {"changes": [{"type": "added|modified|deleted", "path": "..."}]} for
    any change — including those made by shell commands, build tools, or external
    edits — not just the agent's declared file writes.
    """
    workspace = _REGISTRY.get(repo_id)
    if workspace is None:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    root = workspace.resolve()
    stop = asyncio.Event()
    drain = asyncio.create_task(_drain(websocket, stop))

    try:
        async for changes in awatch(root, watch_filter=_keep_change, stop_event=stop):
            events = []
            for change, abspath in changes:
                try:
                    rel = Path(abspath).resolve().relative_to(root)
                except ValueError:
                    continue
                events.append({"type": change.name, "path": str(rel)})
            if events:
                await websocket.send_json({"changes": events})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        stop.set()
        drain.cancel()
