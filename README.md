# Deep Coding Agent

A coding agent — like a self-hosted Claude Code / Cursor — built on LangChain's
**deepagents** harness and exposed through a **CopilotKit + AG-UI** frontend. It
operates on **any repository**: clone a GitHub URL or load a local path, then chat
with an agent scoped to that repo. Edits and shell commands pause for approval
(shown as diffs), a file viewer and tree stay in sync via a filesystem watcher,
and each repo can get its own **graphify** knowledge graph.

---

## How it fits together

```
React (CopilotKit UI)  ──►  CopilotKit Runtime (Next route)  ──►  AG-UI endpoint  ──►  deepagents graph
   chat + tree + diff         /api/copilotkit                     /agent/{repo}        (rooted at the repo)
                                                                                          │
                                                  MongoDB (threads/state)   ◄─────────────┤
                                                  Sandbox / host shell      ◄─────────────┤
                                                  graphify graph (optional) ◄─────────────┘
```

- **deepagents** — the agent harness: planning/todos, virtual filesystem,
  subagents, human-in-the-loop. It works on any repo because its filesystem
  **backend is rooted at the repo directory** (`root_dir`).
- **AG-UI** — the protocol between agent and UI. Each repo is mounted as its own
  endpoint at `/agent/{repo_id}`.
- **CopilotKit** — the React client (chat, shared state, interrupt rendering).
- **MongoDB** — durable, resumable conversation threads (the LangGraph
  checkpointer).
- **graphify** (optional) — a per-repo knowledge graph the agent queries instead
  of grepping.

---

## Request flow

**Opening a repo**

1. `RepoOpener` → `openRepo()` → `POST /repos` with a `git_url` or `local_path`
   (plus an optional `dest`).
2. Backend `_materialize()` clones the URL (or symlinks the local path) into the
   workspace, registers it, and — if `ENABLE_GRAPHIFY` — runs `graphify.attach()`
   to build the graph and load its MCP tools.
3. `build_agent()` compiles a deepagents graph rooted at the workspace, and it is
   mounted as an AG-UI endpoint at `/agent/{repo_id}`.
4. The response (`repo_id`, `agent_path`, `location`, `graphify`, `tree`) is
   stored as the session. The frontend renders the tree + viewer, opens the watch
   WebSocket, and points CopilotKit at the repo's agent.

**Chatting and editing**

1. A message in `CopilotChat` → `POST /api/copilotkit` (Next route) →
   `CopilotRuntime` → `LangGraphHttpAgent` → `POST {BACKEND}/agent/{repo_id}`.
2. The deepagents graph runs on a MongoDB-checkpointed thread. When it calls
   `edit_file` / `write_file` / `execute`, `interrupt_on` **pauses** the run.
3. The interrupt reaches the browser via AG-UI; `useLangGraphInterrupt` →
   `ApprovalGate` renders a diff (or command) with Approve / Reject.
4. On approve, the graph resumes and the write hits disk. `watchfiles` detects
   it, the watch WebSocket pushes the change, `useRepoWatch` bumps the refresh
   signal, and the tree + viewer refetch.

---

## Project structure

```
deep-coding-agent/
├── docker-compose.yml          # MongoDB for the checkpointer
├── backend/
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── main.py             # FastAPI app, lifespan, checkpointer, CORS, shutdown
│       ├── config.py           # env settings (Nebius/Anthropic, Mongo, graphify)
│       ├── agent.py            # _model() + build_agent(): repo-rooted, gated edits
│       ├── workspaces.py       # clone/local, AG-UI mount, tree, file read, watch (WS)
│       └── graphify.py         # extract → serve MCP → load tools, per repo
└── frontend/
    ├── package.json
    ├── .env.local.example
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx            # workbench: tree · file viewer · chat
    │   ├── globals.css
    │   └── api/copilotkit/route.ts   # CopilotKit runtime (per-repo agent by header)
    └── components/
        ├── FileTree.tsx        # clickable tree + openRepo() helper
        ├── RepoOpener.tsx      # clone URL / local path + optional destination
        ├── FileViewer.tsx      # click a file to view its contents
        ├── ApprovalGate.tsx    # renders edit/exec interrupts for approval
        ├── DiffView.tsx        # red/green diff used in the approval card
        └── useRepoWatch.ts     # WebSocket hook: live file-change events
```

---

## Prerequisites

- Python 3.11+, Node 20+, Git
- A `NEBIUS_API_KEY` (Token Factory) — or set `ANTHROPIC_API_KEY` to use Anthropic
- Docker (for MongoDB) — or your own MongoDB instance
- Optional, for the knowledge-graph layer: `pip install "graphifyy[mcp]"` in the
  backend environment (the `[mcp]` extra is required for the server)

---

## Configuration

Backend (`backend/.env`):

| Variable                   | Default                                  | Purpose                                                        |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `NEBIUS_BASE_URL`          | `https://api.tokenfactory.nebius.com/v1` | OpenAI-compatible base URL for the LLM                         |
| `NEBIUS_API_KEY`           | _(unset)_                                | If set, the agent uses Nebius                                  |
| `NEBIUS_MODEL`             | `Qwen/Qwen2.5-Coder-32B-Instruct`        | Model id — **must support tool calling**                       |
| `ANTHROPIC_API_KEY`        | _(unset)_                                | Used only if `NEBIUS_API_KEY` is unset                         |
| `MODEL`                    | `anthropic:claude-sonnet-4-6`            | Fallback model string when Nebius is unset                     |
| `MONGODB_URI`              | `mongodb://localhost:27017`              | LangGraph checkpointer connection                              |
| `MONGODB_DB`               | `deep_coding_agent`                      | Database name for checkpoints                                  |
| `WORKSPACES_DIR`           | `./workspaces`                           | Default directory repos are cloned/linked into                 |
| `CORS_ORIGINS`             | `http://localhost:3000`                  | Comma-separated allowed frontend origins                       |
| `ENABLE_GRAPHIFY`          | `false`                                  | Build + attach a per-repo graphify graph on open               |
| `GRAPHIFY_EXTRACT_BACKEND` | _(unset)_                                | Backend for docs/PDF extraction; unset = code-only (no key)    |

Frontend (`frontend/.env.local`):

| Variable                   | Default                 | Purpose                                          |
| -------------------------- | ----------------------- | ------------------------------------------------ |
| `NEXT_PUBLIC_AGENT_BACKEND`| `http://localhost:8000` | Backend base URL (also derives the `ws://` watch URL) |

---

## Run it

**1. Start MongoDB**

```bash
docker compose up -d
```

**2. Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# optional knowledge graph:
# pip install "graphifyy[mcp]"
cp .env.example .env          # add your NEBIUS_API_KEY (+ NEBIUS_MODEL)
uvicorn app.main:app --reload --port 8000
```

**3. Frontend**

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Open http://localhost:3000, paste a GitHub URL (or a local path) in the sidebar,
and start chatting.

---

## API reference

| Method | Path                      | Body / query                                  | Returns                                                  |
| ------ | ------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| GET    | `/health`                 | —                                             | `{ "status": "ok" }`                                     |
| GET    | `/config`                 | —                                             | `{ "workspaces_dir", "graphify" }`                       |
| POST   | `/repos`                  | `{ git_url?, local_path?, repo_id?, dest? }`  | `{ repo_id, agent_path, location, graphify, tree }`      |
| GET    | `/repos/{repo_id}/tree`   | —                                             | nested `{ name, path, type, children }`                  |
| GET    | `/repos/{repo_id}/file`   | `?path=<relative>`                            | `{ path, content }`                                      |
| WS     | `/repos/{repo_id}/watch`  | —                                             | streams `{ changes: [{ type, path }] }`                  |
| POST   | `/agent/{repo_id}`        | AG-UI `RunAgentInput`                         | AG-UI event stream (used by the CopilotKit runtime)      |

`/agent/{repo_id}` is mounted dynamically when a repo is opened (plus a static
`/agent/default`). It's called by the CopilotKit runtime, not directly.

### Example: open a repo

```bash
curl -X POST http://localhost:8000/repos \
  -H 'Content-Type: application/json' \
  -d '{"git_url": "https://github.com/tiangolo/fastapi", "dest": "~/code/fastapi"}'
```

```json
{
  "repo_id": "a1b2c3d4e5f6",
  "agent_path": "/agent/a1b2c3d4e5f6",
  "location": "/home/you/code/fastapi",
  "graphify": false,
  "tree": { "name": "fastapi", "path": ".", "type": "dir", "children": [ ... ] }
}
```

Then point the frontend's CopilotKit provider at `agent="a1b2c3d4e5f6"` (the app
does this automatically via the `x-agent-id` header).

---

## Where repos live

Cloned/linked repos go under `WORKSPACES_DIR` (default `./workspaces`), one
subfolder per repo. The opener shows that default as a hint and lets you override
the destination per clone (the "clone into…" field). A **git URL** is cloned into
the chosen directory; a **local path** is symlinked, so the agent edits your real
repo in place. The sidebar shows exactly where each repo landed.

---

## Editing, approval & review

When you ask the agent to change code, it calls `edit_file` / `write_file` on the
repo (a symlink to your real repo for local paths; the clone under
`WORKSPACES_DIR` for git URLs). These — along with `execute` — are gated by
`interrupt_on` in `agent.py`, so each edit or shell command **pauses** and
surfaces in the chat as an approval card: file edits show a red/green **diff**
(`ApprovalGate` + `DiffView`), commands show the command line. Approve to apply,
reject to skip. Clicking a file in the tree opens it read-only in the center
**viewer**, which re-reads after an approved edit.

> The exact shape of the deepagents human-in-the-loop interrupt payload (and the
> `accept` / `ignore` resume values) can vary across versions. If approvals don't
> render or resume cleanly, adjust the payload parsing in `ApprovalGate.tsx`
> against your installed deepagents + CopilotKit versions.

### Live sync

The tree and viewer update from a real filesystem watcher, not by guessing after
an approval. The backend watches the workspace with `watchfiles` and streams
add/modify/delete events over a WebSocket (`/repos/{id}/watch`); the frontend
`useRepoWatch` hook subscribes and refreshes. This reflects *any* change — agent
edits, files created by shell commands or build steps, even external editors —
and reconnects automatically.

---

## graphify per codebase (optional)

Set `ENABLE_GRAPHIFY=true` (and `pip install "graphifyy[mcp]"` in the backend
env). When a repo is opened, `graphify.attach()`:

1. runs `graphify extract <repo>` → writes `graphify-out/graph.json` (code is
   parsed locally via tree-sitter; docs/PDFs need `GRAPHIFY_EXTRACT_BACKEND`),
2. starts a per-repo MCP server (`python -m graphify.serve … --transport http`)
   exposing `query_graph`, `get_node`, `get_neighbors`, `shortest_path`,
3. loads those as LangChain tools via `langchain-mcp-adapters` and attaches them
   to that repo's agent.

The agent then queries the graph to understand how the code connects instead of
grepping. Servers are tracked per repo and stopped on shutdown; the sidebar shows
whether the graph attached.

---

## Security

The default backend is `LocalShellBackend`, which gives the agent **unrestricted
shell and filesystem access on the host**. That is fine for trusted local
development only. For arbitrary or untrusted repos, switch to a **sandbox
backend** (E2B, Daytona, Modal, Vercel, AgentCore) in `backend/app/agent.py` so
each repo runs isolated. Human-in-the-loop approval is enabled for `execute`,
`write_file`, and `edit_file`, so nothing mutates the repo or shells out without
your click — but approval is a guardrail, not a sandbox.

---

## Troubleshooting

| Symptom                                                              | Fix                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Transaction numbers are only allowed on a replica set` (Mongo)     | Use the single-node replica-set service commented into `docker-compose.yml` and append `?replicaSet=rs0` to `MONGODB_URI`.                                     |
| `ModuleNotFoundError: graphify` / `python -m graphify.serve` fails  | graphify must be installed in the **backend venv** (`pip install "graphifyy[mcp]"`), not via `uv tool`/`pipx` in another environment.                          |
| Approval card doesn't render or the run hangs after approve         | The interrupt payload shape varies by version — adjust the parsing in `ApprovalGate.tsx` (`action_request.action` / `.args`, and the `accept`/`ignore` reply). |
| Tree/viewer don't live-update                                       | Check `NEXT_PUBLIC_AGENT_BACKEND` is reachable; the watch socket is `ws(s)://<backend>/repos/{id}/watch`. Cross-origin WS in production needs an origin check.  |
| Agent makes malformed tool calls / loops                            | Choose a strong tool-calling model in `NEBIUS_MODEL` (e.g. a larger Llama/Qwen/DeepSeek). Weak models struggle with the agent loop.                            |
| `404` / "agent not found" on `/agent/{id}`                          | Routes are mounted in-process on repo open and are **not** persisted. After a backend restart, re-open the repo.                                               |
| CORS error in the browser                                           | Add the frontend origin to `CORS_ORIGINS` (comma-separated).                                                                                                   |
| `git clone failed`                                                  | Verify the URL and access; private repos need credentials/SSH configured for the backend process.                                                             |

---

## Module reference

### Backend

**`app/config.py`** — `Settings` (pydantic-settings, reads `.env`): LLM fields
(`nebius_*`, `anthropic_api_key`, `model`), Mongo (`mongodb_uri`, `mongodb_db`),
`workspaces_dir`, `cors_origins`, graphify (`enable_graphify`,
`graphify_extract_backend`). `cors_origin_list` splits the origins string. A
module-level `settings` instance is imported everywhere.

**`app/agent.py`**
- `_model()` → a chat model: `ChatOpenAI(base_url, api_key, model)` when
  `NEBIUS_API_KEY` is set, else the `MODEL` provider string (imported lazily).
- `build_agent(workspace, checkpointer=None, tools=None)` → a compiled deepagents
  graph rooted at `workspace` via `LocalShellBackend`, with `tools` merged in,
  `interrupt_on` gating `execute`/`write_file`/`edit_file`, and the checkpointer.
  **This is the single place to change the backend (sandbox), the system prompt,
  or which tools the agent gets.**

**`app/workspaces.py`** — the repos `APIRouter`.
- `NewRepo` — request model: `git_url? | local_path?`, plus `repo_id?`, `dest?`.
- `_materialize(req)` → `(repo_id, workspace)`: clones the URL or symlinks the
  local path into `dest` (or `WORKSPACES/<repo_id>`).
- `tree(root)` → nested `{name, path, type, children}`, skipping `IGNORE` dirs.
- `mount_default_agent(app, checkpointer)` — mounts `/agent/default`.
- Routes: `POST /repos`, `GET /repos/{id}/tree`, `GET /repos/{id}/file`,
  `GET /config`, and `WS /repos/{id}/watch` (uses `watchfiles`; a drain task stops
  the watcher on disconnect).
- `_REGISTRY: dict[repo_id, Path]` maps repos to workspaces for tree/file/watch.

**`app/graphify.py`** — per-repo knowledge graph.
- `build_graph(workspace)` → runs `graphify extract`, returns the `graph.json` path.
- `start_server(repo_id, graph)` → spawns `python -m graphify.serve … http` on a
  free port, returns the `/mcp` URL, tracks the process in `_SERVERS`.
- `load_tools(url)` → MCP tools via `MultiServerMCPClient` (retries until ready).
- `attach(repo_id, workspace)` → `build_graph` + `start_server` + `load_tools`.
- `stop_all()` → terminate every per-repo server (called on shutdown).

**`app/main.py`** — `lifespan` constructs a `MongoDBSaver` from a `MongoClient`,
stores it on
`app.state.checkpointer`, mounts the default agent, and calls `graphify.stop_all()`
on shutdown. Adds CORS, includes the repos router, exposes `/health`.

### Frontend

**`components/FileTree.tsx`** — `openRepo({gitUrl?, localPath?, dest?})` does
`POST /repos` and returns a `RepoSession` (`repoId`, `agentPath`, `tree`,
`location`, `graphify`). `FileTree({repoId, initialTree, refreshSignal,
onOpenFile, activePath})` renders the tree; files call `onOpenFile(path)`;
refetches on `refreshSignal`.

**`components/RepoOpener.tsx`** — `RepoOpener({onOpen})`: a URL/path input, an
optional "clone into…" destination (shown for URLs), and a `/config` hint for the
default dir. Calls `openRepo` and hands the session up.

**`components/FileViewer.tsx`** — `FileViewer({repoId, path, refreshSignal})`:
fetches `GET /repos/{id}/file?path=…` and shows it read-only; re-reads on
`refreshSignal`.

**`components/ApprovalGate.tsx`** — `ApprovalGate({onResolved?})`: registers
`useLangGraphInterrupt` and renders an approve/reject card (`DiffView` for edits,
command text for `execute`); resolves `[{type:"accept"}]` / `[{type:"ignore"}]`.

**`components/DiffView.tsx`** — `DiffView({oldText?, newText?})`: stacked red
(removed) / green (added) line blocks.

**`components/useRepoWatch.ts`** — `useRepoWatch(repoId, onChanges)`: opens the
watch WebSocket (`http→ws`), calls `onChanges(paths)` per change batch,
auto-reconnects.

**`app/page.tsx`** — the workbench: holds `session` / `selectedFile` /
`refreshTick`, wires `useRepoWatch` to bump `refreshTick`, renders tree + viewer +
`CopilotKit`/`CopilotChat` with `ApprovalGate`.

**`app/api/copilotkit/route.ts`** — `POST` handler that reads `x-agent-id` and
builds a `CopilotRuntime` with a `LangGraphHttpAgent` pointed at
`{BACKEND}/agent/{agentId}`.

## Extending it

**Add a tool.** Define a LangChain tool and include it when building the agent:

```python
# app/agent.py
from langchain_core.tools import tool

@tool
def run_linter(path: str) -> str:
    """Lint a file and return findings."""
    ...

def build_agent(workspace, checkpointer=None, tools=None):
    tools = (tools or []) + [run_linter]
    ...
```

graphify's MCP tools arrive the same way — already merged in via `attach()`.

**Swap in a sandbox backend.** Change the one line in `build_agent`:

```python
# pip install langchain-e2b e2b
from e2b import Sandbox
from langchain_e2b import E2BSandbox

backend = E2BSandbox(sandbox=Sandbox.create())  # instead of LocalShellBackend
```

For per-repo isolation, create the sandbox in `attach()` / `create_repo`, pass it
through to `build_agent`, and tear it down alongside the graphify server.

**Add an endpoint.** Add a route to the existing router (already included in
`main.py`):

```python
# app/workspaces.py
@router.get("/repos/{repo_id}/grep")
async def grep(repo_id: str, q: str) -> dict:
    workspace = _REGISTRY.get(repo_id)
    if workspace is None:
        raise HTTPException(404, "unknown repo_id")
    ...
```

## Notes & next steps

- **Per-repo agents** are mounted dynamically and cached in-process. For many
  repos or multi-tenant use, route by thread and resolve `root_dir` per thread,
  with agent caching/eviction, instead of one route per repo.
- **graphify on open** adds extraction latency; for large repos, build the graph
  asynchronously and attach the tools once ready rather than blocking the open.
- **Library churn:** deepagents, AG-UI, and CopilotKit move fast. If an import or
  signature fails, check the current LangChain / AG-UI / CopilotKit docs and pin
  versions accordingly.
