# Building a self-hosted Cursor: a coding agent on deepagents + CopilotKit + AG-UI

*How I wired LangChain's deepagents harness to a CopilotKit/AG-UI frontend to get a
repo-scoped coding agent with diff-based approvals — and the handful of bugs that
taught me how these pieces actually fit together.*

---

I wanted a coding agent I could point at **any** repository and chat with — explore
it, explain it, change it — with every edit and shell command pausing for my
approval as a real diff. Essentially a self-hosted Claude Code / Cursor, assembled
from open parts:

- **[deepagents](https://pypi.org/project/deepagents/)** — LangChain's agent
  harness: planning/todos, a virtual filesystem, subagents, and human-in-the-loop,
  all on top of LangGraph.
- **[CopilotKit](https://copilotkit.ai) + [AG-UI](https://docs.ag-ui.com)** — the
  React client and the agent↔UI protocol that streams tokens, tool calls, and
  interrupts to the browser.
- **MongoDB** — the LangGraph checkpointer, for durable threads.
- **[graphify](https://pypi.org/project/graphifyy/)** — an optional per-repo
  knowledge graph the agent can query instead of grepping.

The result works end to end, but the interesting part isn't the happy path — it's
the four or five places where the abstractions leak, and what the fixes reveal
about how the stack is glued together. This is that story.

> This is written to **rebuild from**. Every code block is from the working
> source, and there's a verified [version-pin appendix](#version-pins) at the end —
> read that first if you just want a set of versions that fit together.

**Contents**

1. [The shape of the thing](#the-shape-of-the-thing)
2. [Rooting an agent at any repo](#rooting-an-agent-at-any-repo)
3. [Picking the agent from the frontend](#picking-the-agent-from-the-frontend)
4. [The model and the prompt](#the-model-and-the-prompt)
5. [The checkpointer reality](#the-checkpointer-reality)
6. [Making the agent aware of your open file](#making-the-agent-aware-of-your-open-file)
7. [Human-in-the-loop, done right](#human-in-the-loop-done-right)
8. [Bringing the diff into the editor](#bringing-the-diff-into-the-editor)
9. [Live sync without optimistic UI](#live-sync-without-optimistic-ui)
10. [graphify](#graphify-a-per-repo-knowledge-graph) · [Operational notes](#a-few-more-operational-notes)
11. [Config](#configuration-reference) · [Version pins](#version-pins) · [API](#api-reference) · [Modules](#module-reference) · [Extending](#extending-it) · [Security](#security--productionizing) · [Troubleshooting](#troubleshooting)

---

> 📷 _**Screenshot:** the workbench — file tree (left), Monaco editor (center),
> chat with tool chips (right). A good hero image for the article._

## The shape of the thing

```
React (CopilotKit UI) ──► CopilotKit Runtime (Next route) ──► AG-UI endpoint ──► deepagents graph
  chat · editor · tree      /api/copilotkit                   /agent/{repo}      (rooted at the repo)
                                                                                      │
                                              MongoDB (threads/state)  ◄──────────────┤
                                              host shell / sandbox     ◄──────────────┤
                                              graphify graph (optional)◄──────────────┘
```

Two flows matter.

**Opening a repo.** `RepoOpener` POSTs a `git_url` or `local_path` to `/repos`. The
backend clones the URL (or symlinks the local path) into a workspace, optionally
builds a graphify graph, compiles a deepagents graph **rooted at that workspace**,
and mounts it as its own AG-UI endpoint at `/agent/{repo_id}`. The frontend gets
back `{ repo_id, location, graphify, tree }`, renders the tree and editor, opens a
file-watch WebSocket, and points CopilotKit at that repo's agent.

**Chatting and editing.** A message flows `CopilotChat → /api/copilotkit (Next) →
CopilotRuntime → LangGraphHttpAgent → POST /agent/{repo_id}`. The graph runs on a
MongoDB-checkpointed thread. When it calls `edit_file` / `write_file` / `execute`,
`interrupt_on` **pauses** the run; the interrupt streams to the browser, you
approve or reject, and on approve the write hits disk — where the filesystem
watcher picks it up and refreshes the UI.

Everything below is what it took to make those two paragraphs actually true.

---

## Rooting an agent at any repo

The thing that makes this work on *any* codebase is a single deepagents idea: the
filesystem backend is rooted at a directory. Give it `root_dir = <workspace>` and
the agent's `ls` / `read_file` / `write_file` / `edit_file` / `glob` / `grep` and
its `execute` shell all resolve under that path.

So `build_agent(workspace, …)` compiles one graph per repo:

```python
return create_deep_agent(
    model=_model(),
    backend=backend,                       # LocalShellBackend rooted at the workspace
    tools=tools or [],                     # + graphify MCP tools, if attached
    system_prompt=SYSTEM_PROMPT,
    middleware=[CopilotContextMiddleware()],
    interrupt_on={"execute": True, "write_file": True, "edit_file": True},
    checkpointer=checkpointer,
)
```

Each compiled graph is mounted as its own AG-UI endpoint and tracked in an
in-process registry (`_REGISTRY: dict[repo_id, Path]`). Here's the actual mount,
inside the `POST /repos` handler — this is the crux of "one agent per repo":

```python
# backend/app/workspaces.py
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent

_REGISTRY: dict[str, Path] = {}

@router.post("/repos")
async def create_repo(req: NewRepo, request: Request) -> dict:
    checkpointer = request.app.state.checkpointer
    repo_id, workspace = _materialize(req)      # clone URL or symlink local path
    _REGISTRY[repo_id] = workspace

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
            graph=agent,                        # the compiled deepagents graph
            config={"recursion_limit": settings.agent_recursion_limit},
        ),
        path=f"/agent/{repo_id}",
    )
    request.app.openapi_schema = None           # surface the new route in the schema
    return {"repo_id": repo_id, "agent_path": f"/agent/{repo_id}",
            "location": str(workspace), "graphify": bool(tools), "tree": tree(workspace)}
```

Two things worth copying exactly: the `recursion_limit` goes in the
`LangGraphAGUIAgent` **config** (not on the graph), and resetting
`openapi_schema = None` is what makes the freshly-mounted route show up. The frontend selects which
agent to talk to by sending an `x-agent-id` header that the Next route reads to
build a `LangGraphHttpAgent` pointed at `/agent/{repo_id}`.

**Operational consequence #1:** the registry lives in memory. Restart the backend
and the mounted routes vanish — so a stale browser tab watching a previous
`repo_id` gets `404`/`403` until you re-open the repo. Expected, not a bug.

**Operational consequence #2 (a sharp one):** if you run uvicorn with plain
`--reload`, the reloader watches the whole tree — *including* `workspaces/`. The
moment the agent clones a repo there, WatchFiles sees new files and restarts the
server, which wipes the registry, kills mounted routes, and orphans the graphify
subprocess. The fix is one flag:

```bash
uvicorn app.main:app --reload --reload-dir app --port 8000
```

`--reload-dir app` watches only source, never the clone target.

---

## Picking the agent from the frontend

The other half of "one agent per repo" is the frontend choosing *which* endpoint to
talk to. CopilotKit's runtime route reads an `x-agent-id` header and builds a
`LangGraphHttpAgent` pointed at that repo's URL:

```ts
// frontend/app/api/copilotkit/route.ts
import {
  CopilotRuntime, ExperimentalEmptyAdapter, copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { LangGraphHttpAgent } from "@ag-ui/langgraph";
import { NextRequest } from "next/server";

const BACKEND = process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "http://localhost:8000";

export const POST = async (req: NextRequest) => {
  const agentId = req.headers.get("x-agent-id") ?? "default";
  const runtime = new CopilotRuntime({
    agents: {
      [agentId]: new LangGraphHttpAgent({ url: `${BACKEND}/agent/${agentId}` }),
    },
  });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
};
```

Two traps that cost me time:

- **`LangGraphHttpAgent` lives in `@ag-ui/langgraph`, not `@ag-ui/client`.**
  `@ag-ui/client` only exports the lower-level `HttpAgent`. Importing from the
  wrong package is a 500 at `/api/copilotkit`.
- **Do not use `LangGraphAgent({ deploymentUrl, graphId })`** for a self-hosted
  FastAPI backend — that form targets LangGraph Platform and fails against a plain
  endpoint. `LangGraphHttpAgent({ url })` is the self-hosted form.

The header is set on the provider, which wraps the chat:

```tsx
<CopilotKit runtimeUrl="/api/copilotkit" agent={repoId}
            headers={{ "x-agent-id": repoId }}>
  …
</CopilotKit>
```

---

## The model and the prompt

`_model()` returns an OpenAI-compatible `ChatOpenAI` when a Nebius key is present,
else a provider string for the Anthropic fallback. The `langchain_openai` import is
**lazy** so an Anthropic-only setup doesn't need it installed:

```python
def _model():
    if settings.nebius_api_key:
        from langchain_openai import ChatOpenAI       # lazy: optional dependency
        return ChatOpenAI(
            model=settings.nebius_model,
            base_url=settings.nebius_base_url,
            api_key=settings.nebius_api_key,
            temperature=settings.nebius_temperature,   # 1.0 for reasoning models
            top_p=settings.nebius_top_p,               # 0.95
        )
    return settings.model  # e.g. "anthropic:claude-sonnet-4-6"
```

The system prompt is small but load-bearing — three of its clauses each fix a real
failure I saw with weaker / reasoning-tuned models (inventing tool names, stopping
after tool calls without an answer, grepping when graph tools exist):

```python
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
```

And the backend choice that keeps file tools scoped — `virtual_mode=True` blocks
absolute paths and `..`, so the agent can't read or write outside the repo (note it
does **not** sandbox `execute` — the shell still runs on the host):

```python
backend = LocalShellBackend(root_dir=str(workspace), virtual_mode=True)
```

---

## The checkpointer reality

I reached for an async Mongo saver out of habit and it didn't exist. In
`langgraph-checkpoint-mongodb`, `AsyncMongoDBSaver` / `.aio` isn't a thing in the
version I had; the plain `MongoDBSaver` already exposes the async methods LangGraph
needs. It's built in the FastAPI `lifespan` and shared on `app.state`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # One MongoDBSaver, not AsyncMongoDBSaver. It connects on construction
    # (creates indexes), so MongoDB must be up before the backend starts.
    client = MongoClient(settings.mongodb_uri)
    try:
        checkpointer = MongoDBSaver(client, db_name=settings.mongodb_db)
        app.state.checkpointer = checkpointer
        mount_default_agent(app, checkpointer)
        yield
    finally:
        from . import graphify
        graphify.stop_all()       # kill per-repo MCP servers
        client.close()
```

It connects eagerly, so Mongo has to be up *before* the app starts — a local
`mongod` (inspected with MongoDB Compass if you like) or a Docker container both
work; the default `MONGODB_URI` points at `mongodb://localhost:27017`.

If you see `Transaction numbers are only allowed on a replica set`, your MongoDB is
running standalone. Either point `MONGODB_URI` at a replica set, or convert your
local instance to a **single-node replica set**: start `mongod --replSet rs0`, run
`rs.initiate()` once in `mongosh`, and append `?replicaSet=rs0` to `MONGODB_URI`.
(The repo's `docker-compose.yml` has a single-node replica-set service commented in
for the Docker path.)

---

## Making the agent aware of your open file

This is the bug I learned the most from.

I wanted "review this file" to just work — no need to name the path. CopilotKit has
the obvious primitive: `useCopilotReadable` shares app state with the agent. So
`OpenFileContext` registers the open file:

```tsx
useCopilotReadable({
  description: "The file the user currently has open in the editor…",
  value: path ? { path, snippet } : "No file is currently open.",
});
```

It did nothing. The agent kept asking *which* file.

Digging into the AG-UI LangGraph adapter explains why. Readable context isn't
injected into the prompt — it's merged into **graph state**, under a specific key:

```python
# inside the AG-UI adapter's state merge
ag_ui_state = { "tools": …, "context": regular_context }
return { **state, "ag-ui": ag_ui_state, "copilotkit": {…} }
```

So my readable was sitting in `state["ag-ui"]["context"]`, and a vanilla deepagents
graph never looks there. In a normal CopilotKit-native agent, *CopilotKit's own
middleware* is what lifts that context into the system prompt. My graph had no such
middleware — so the data arrived and was silently ignored.

The whole path, and where it was breaking:

```
useCopilotReadable(open file)          [browser]
        │  CopilotKit serializes it as AG-UI "context"
        ▼
POST /agent/{repo}  (RunAgentInput.context = [{description, value}])
        │  ag_ui_langgraph adapter: langGraphDefaultMergeState
        ▼
graph state:  state["ag-ui"]["context"]        ← lands HERE
        │
        ╳  deepagents never reads this key      ← was breaking HERE
        │
        ▼  (fix) CopilotContextMiddleware.wrap_model_call
system prompt += "## Live context …"           ← now the model sees it
```

The fix is a tiny middleware that does two things deepagents wouldn't otherwise do:

```python
AgUiContextState = TypedDict("AgUiContextState", {"ag-ui": dict}, total=False)

class CopilotContextMiddleware(AgentMiddleware):
    # 1) Declare the channel so LangGraph KEEPS it. Unknown input keys are
    #    dropped before any node runs, so without this the "ag-ui" key never
    #    survives into state.
    state_schema = AgUiContextState

    def _with_context(self, request):
        context = (request.state.get("ag-ui") or {}).get("context") or []
        if not context:
            return request
        # 2) Append the readables to the system prompt before the model call.
        lines = [f"- {field(i, 'description')}: {field(i, 'value')}" for i in context]
        addendum = "\n\n## Live context from the user's UI\n" + "\n".join(lines)
        base = request.system_message
        base_text = base.content if base else ""
        return request.override(system_message=SystemMessage(content=base_text + addendum))

    def wrap_model_call(self, request, handler):
        return handler(self._with_context(request))
    async def awrap_model_call(self, request, handler):
        return await handler(self._with_context(request))
```

Two subtleties bit me even after that:

- **The state channel must be declared.** LangGraph filters graph input to known
  channels; an undeclared `"ag-ui"` key is dropped before a node ever sees it.
  Declaring it in the middleware's `state_schema` is what makes it survive.
- **The context items aren't dicts.** They're AG-UI `Context` *pydantic* objects.
  My first version did `item.get("description")` and crashed with
  `'Context' object has no attribute 'get'`. The `field()` helper reads by
  attribute for objects and falls back to `.get()` for dicts.

That crash was, perversely, the proof the design was right: the run reached my
middleware with a *populated* context array — the readable had traveled all the way
from the browser into graph state and survived. Fixing the access pattern was the
last mile, and "review this file" started resolving to the editor's file.

The nice side effect: this is general. Any `useCopilotReadable` you add later — the
current selection, cursor position, which tree node is highlighted — now reaches the
model through the same path.

---

## Human-in-the-loop, done right

deepagents gates tools with `interrupt_on`, which raises a LangGraph `interrupt`
the frontend renders via `useLangGraphInterrupt`. My first `ApprovalGate` was
written against a *guessed* payload shape, and it failed two ways at once: the
diff never showed, and clicking Approve crashed with:

```
decisions = interrupt(hitl_request)["decisions"]
TypeError: list indices must be integers or slices, not str
```

The real deepagents contract, read straight from
`HumanInTheLoopMiddleware`, is precise:

```
interrupt value  →  { action_requests: [{ name, args, description? }], review_configs: [...] }
resume value     →  { decisions: [ {type:"approve"} | {type:"reject", message?} | … ] }
```

One decision per action, and the resume must be a **dict** with a `decisions` key —
not a bare list, and the types are `approve`/`reject` (plus `edit`/`respond`), not
the `accept`/`ignore` I'd invented. The "lot of plain text before the diff" was a
second symptom: deepagents auto-generates a `description` that dumps the entire
args blob (`Tool execution requires approval\nTool: edit_file\nArgs: {…}`), and I
was rendering it verbatim. Dropping it and parsing `action_requests` fixed both:

```tsx
const decide = (type: "approve" | "reject") =>
  resolve({ decisions: actions.map(() => ({ type })) });
```

Tool args you'll be rendering: `write_file{file_path, content}`,
`edit_file{file_path, old_string, new_string, replace_all?}`, `execute{command}`.

---

## Bringing the diff into the editor

A read-only syntax-highlighted viewer can show a file; it can't show a *diff*. Once
I wanted the proposed change rendered inline in the editor — approvable there,
synced with the chat — I switched the center pane to **Monaco** (the actual VS Code
editor), whose `DiffEditor` renders inline diffs natively.

The interesting problem is sync. The interrupt is captured by `useLangGraphInterrupt`,
which only works **inside** the CopilotKit provider (the chat). The editor lives
*outside* that provider. Rather than restructure the whole layout to wrap both
panes (and risk the provider injecting a DOM wrapper that breaks the CSS grid), I
bridged them with a tiny framework-agnostic store:

```ts
// interruptStore.ts
export type PendingInterrupt = {
  actions: Array<{ name: string; args: Record<string, any>; description?: string }>;
  resolve: (value: any) => void;
};

let state: PendingInterrupt | null = null;
let lastKey = "";                       // identifies the current interrupt
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const interruptStore = {
  // Called from ApprovalGate's render; content-keyed so re-renders don't loop.
  set(pending: PendingInterrupt, key: string) {
    if (key === lastKey) return;
    lastKey = key; state = pending; notify();
  },
  // Keep lastKey after clearing so the just-resolved interrupt can't reopen.
  clear() { if (state === null) return; state = null; notify(); },
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  get() { return state; },
};
```

`ApprovalGate` (inside the provider) captures the interrupt and publishes it —
deferred with `queueMicrotask` so it isn't setting state during render, and
content-keyed so re-renders don't re-fire:

```tsx
// ApprovalGate.tsx (render of useLangGraphInterrupt)
const actions = normalize(event.value);           // parse action_requests
const key = JSON.stringify(actions);
queueMicrotask(() => interruptStore.set({ actions, resolve }, key));
// …compact chat card; decide() calls resolve({decisions}) + interruptStore.clear()
```

`EditorPane` (outside the provider) subscribes with `useSyncExternalStore`, and
when an edit is pending it reconstructs the proposed file and renders Monaco's
inline diff:

```tsx
// EditorPane.tsx
const pending = useSyncExternalStore(
  interruptStore.subscribe, interruptStore.get, interruptStore.get);
const editAction = pending?.actions?.find(
  (a) => a.name === "edit_file" || a.name === "write_file");

// reconstruct the proposed contents for preview
function applyEdit(original: string, action: { name: string; args: any }) {
  if (action.name === "write_file") return String(action.args?.content ?? "");
  if (action.name === "edit_file") {
    const oldS = String(action.args?.old_string ?? "");
    const newS = String(action.args?.new_string ?? "");
    if (!oldS) return original;
    return action.args?.replace_all
      ? original.split(oldS).join(newS)
      : original.replace(oldS, newS);     // deepagents requires old_string unique
  }
  return original;
}

// when editAction exists: fetch the file, set original + applyEdit(original), then
<DiffEditor original={original} modified={modified} language={langFor(file)}
            theme="vs-dark" height="100%"
            options={{ ...MONACO_OPTS, renderSideBySide: false }} />
// Approve/Reject call pending.resolve({decisions:[…]}) + interruptStore.clear()
```

Both panes call the *same* stored `resolve`, so they can't drift. The full
round-trip:

```
agent calls edit_file ──► interrupt_on pauses the graph
        │  AG-UI streams the interrupt
        ▼
useLangGraphInterrupt(render) ──► interruptStore.set({actions, resolve}, key)
        │                                   │
        ▼ (chat)                            ▼ (editor, via useSyncExternalStore)
  compact card  ◄──── same pending ────►  Monaco DiffEditor + Approve/Reject
        │                                   │
        └──────────► resolve({decisions:[…]}) ◄───────────┘
                          │  graph resumes, write hits disk
                          ▼
                  watchfiles ──► /watch WS ──► tree + editor refetch
```

The preview is reconstructed client-side; the real write is still performed by the
agent on approval and lands through the watcher — so what you see is faithful, and
the source of truth stays on disk.

One layout gotcha worth stealing: while dragging the chat-resizer, a full-screen
`position: fixed` overlay grabs the mouse. Without it, Monaco swallows the
`mousemove` the instant your cursor crosses the editor and the drag dies.

> 📷 _**GIF:** ask for an edit → the inline Monaco diff appears in the editor with
> Approve/Reject → approve → the file updates live. This is the money shot._

(Before Monaco, the chat card used a hand-rolled **LCS line diff** — context lines
plus only the changed `+`/`-` lines, with an `m*n` guard against pathological
inputs. It's been superseded by Monaco's diff but is a fine ~50-line standalone if
you ever want a dependency-free diff.)

---

## Live sync without optimistic UI

The tree and editor never *guess* what changed after an approval. The backend
watches the workspace with `watchfiles` and streams add/modify/delete events over a
WebSocket; the `useRepoWatch` hook subscribes and bumps a refresh signal that the
tree and editor refetch on.

Backend — note the `_drain` task: a WebSocket has no "is the client gone?" signal
while you're only sending, so a second task reads from the socket purely to detect
disconnect and stop the watcher:

```python
# backend/app/workspaces.py
@router.websocket("/repos/{repo_id}/watch")
async def watch_repo(websocket: WebSocket, repo_id: str) -> None:
    workspace = _REGISTRY.get(repo_id)
    if workspace is None:
        await websocket.close(code=1008)        # stale repo_id (e.g. after restart)
        return
    await websocket.accept()
    root = workspace.resolve()
    stop = asyncio.Event()
    drain = asyncio.create_task(_drain(websocket, stop))   # detect disconnect
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
```

Frontend — derive the `ws://` URL from the backend URL and auto-reconnect:

```ts
// frontend/components/useRepoWatch.ts
const wsUrl = BACKEND.replace(/^http/, "ws") + `/repos/${repoId}/watch`;
const connect = () => {
  ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const paths = (data.changes ?? []).map((c: any) => c.path);
    if (paths.length) cb.current(paths);
  };
  ws.onclose = () => { if (!closed) retry = setTimeout(connect, 1500); };
  ws.onerror = () => ws?.close();
};
```

In `page.tsx`, `useRepoWatch(repoId, () => setRefreshTick(t => t + 1))` is the whole
wiring — the tick is a dependency of the tree and editor fetches. The approval
click and the UI refresh stay decoupled: approval resumes the graph, the write hits
disk, and the watcher independently tells the UI. That's why files created as a
*side effect* of a shell command show up too.

---

## graphify: a per-repo knowledge graph

graphify is **on by default** (`ENABLE_GRAPHIFY=true`; set it `false` to skip).
When a repo is opened, `graphify.attach()`: it extracts a
graph (`graphify extract`), starts a per-repo MCP server exposing `query_graph` /
`get_node` / `get_neighbors` / `shortest_path`, and loads those as LangChain tools
via `langchain-mcp-adapters`, merged into that repo's agent. The agent then queries
structure instead of grepping.

Two traps:

- **Install location.** graphify must live in the **backend venv**
  (`pip install "graphifyy[mcp]"`), not via `uv tool`/`pipx`, because the code
  launches it with `sys.executable -m graphify…`. An isolated install yields
  `ModuleNotFoundError: graphify`.
- **Keyless extraction.** `graphify extract` aborts the whole run if it hits
  docs/images with no extraction backend configured. The fix: when
  `GRAPHIFY_EXTRACT_BACKEND` is unset, write a `.graphifyignore` excluding doc/image
  globs so code-only extraction succeeds without any API key.

graphify on open adds latency; for large repos, build the graph asynchronously and
attach the tools once ready instead of blocking the open.

---

## A few more operational notes

- **Windows symlinks.** Local-path repos are symlinked; Windows needs Developer
  Mode enabled or you'll hit `WinError 1314`. Git URLs sidestep it.
- **Model choice matters.** The agent loop needs a strong tool-calling model. Weak
  models produce malformed tool calls or loop. For reasoning-tuned models (e.g.
  Nemotron), set the vendor-recommended sampling (`temperature`/`top_p`) — a
  `temperature=0` reasoning model will stall or hallucinate tools.
- **Recursion limit.** Long runs can exceed LangGraph's super-step budget and end
  as `INCOMPLETE_STREAM`. Raise `AGENT_RECURSION_LIMIT` — but if it's hit
  constantly, the model is probably looping.
- **A benign warning.** `Deserializing unregistered type ag_ui.core.types.Context
  from checkpoint` just means the readable `Context` object is being checkpointed;
  harmless. Set `LANGGRAPH_STRICT_MSGPACK` or allow-list the module to silence it.

---

## Configuration reference

Backend (`backend/.env`):

| Variable                   | Default                                  | Purpose                                                     |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `NEBIUS_BASE_URL`          | `https://api.tokenfactory.nebius.com/v1` | OpenAI-compatible base URL for the LLM                      |
| `NEBIUS_API_KEY`           | _(unset)_                                | If set, the agent uses Nebius                               |
| `NEBIUS_MODEL`             | `nvidia/nemotron-3-super-120b-a12b`      | Model id — must support tool calling                        |
| `NEBIUS_TEMPERATURE`       | `1.0`                                    | Sampling temperature (per model recommendation)             |
| `NEBIUS_TOP_P`             | `0.95`                                   | Nucleus sampling                                            |
| `ANTHROPIC_API_KEY`        | _(unset)_                                | Used only if `NEBIUS_API_KEY` is unset                      |
| `MODEL`                    | `anthropic:claude-sonnet-4-6`            | Fallback model string when Nebius is unset                  |
| `MONGODB_URI`              | `mongodb://localhost:27017`              | LangGraph checkpointer connection                           |
| `MONGODB_DB`               | `deep_coding_agent`                      | Database name for checkpoints                               |
| `WORKSPACES_DIR`           | `./workspaces`                           | Default directory repos are cloned/linked into              |
| `AGENT_RECURSION_LIMIT`    | `100`                                    | LangGraph super-steps per run                               |
| `CORS_ORIGINS`             | `http://localhost:3000`                  | Comma-separated allowed frontend origins                    |
| `ENABLE_GRAPHIFY`          | `true`                                   | Build + attach a per-repo graphify graph on open (needs `graphifyy[mcp]`) |
| `GRAPHIFY_EXTRACT_BACKEND` | _(unset)_                                | Backend for docs/PDF extraction; unset = code-only (no key) |

Frontend (`frontend/.env.local`):

| Variable                        | Default                 | Purpose                                       |
| ------------------------------- | ----------------------- | --------------------------------------------- |
| `NEXT_PUBLIC_AGENT_BACKEND`     | `http://localhost:8000` | Backend base URL (also derives the watch `ws://`) |
| `COPILOTKIT_TELEMETRY_DISABLED` | _(unset)_               | Set `true` to silence the runtime telemetry notice |

---

## Version pins

This stack moves fast and the seams above are version-sensitive — the AG-UI state
key, the deepagents HITL schema, and the `MongoDBSaver` shape have all shifted
across releases. These are the versions the code in this article was written and
verified against. **Treat your own `uv.lock` / `package-lock.json` as the source of
truth** and pin from there; use this as a known-compatible reference set.

Backend (Python 3.11+):

```
deepagents==0.6.11
langchain==1.3.10
langchain-core==1.4.8
langchain-openai==1.3.2          # only needed for the Nebius/OpenAI-compatible path
langgraph==1.2.6
langgraph-checkpoint-mongodb==0.4.0
ag-ui-langgraph==0.0.42
copilotkit==0.1.94               # Python: LangGraphAGUIAgent, CopilotKitMiddleware
pymongo==4.16.0
fastapi==0.138.0
pydantic==2.13.4
# also: uvicorn, watchfiles, pydantic-settings, langchain-mcp-adapters (see requirements.txt)
# knowledge graph (on by default): graphifyy[mcp]
```

Frontend (Node 20+):

```
next 15.5.x
@monaco-editor/react ^4.6.0
@copilotkit/react-core, @copilotkit/react-ui, @copilotkit/runtime   (pin from your lockfile)
@ag-ui/client, @ag-ui/langgraph                                     (pin from your lockfile)
```

> If a version drifts and something at a seam breaks, the three things to re-check
> are: where the AG-UI adapter puts readable context (`state["ag-ui"]["context"]`),
> the deepagents interrupt/resume schema (`{action_requests}` / `{decisions}`), and
> whether `MongoDBSaver` is still the single sync+async saver.

---

## API reference

| Method | Path                     | Body / query                                 | Returns                                              |
| ------ | ------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| GET    | `/health`                | —                                            | `{ "status": "ok" }`                                 |
| GET    | `/config`                | —                                            | `{ workspaces_dir, graphify }`                       |
| GET    | `/fs/list`               | `?path=<dir>` (omit for drives/root)         | `{ path, parent, entries }` — folder picker          |
| POST   | `/repos`                 | `{ git_url?, local_path?, repo_id?, dest? }` | `{ repo_id, agent_path, location, graphify, tree }`  |
| GET    | `/repos/{repo_id}/tree`  | —                                            | nested `{ name, path, type, children }`              |
| GET    | `/repos/{repo_id}/file`  | `?path=<relative>`                           | `{ path, content }`                                  |
| WS     | `/repos/{repo_id}/watch` | —                                            | streams `{ changes: [{ type, path }] }`              |
| POST   | `/agent/{repo_id}`       | AG-UI `RunAgentInput`                        | AG-UI event stream (used by the CopilotKit runtime)  |

`/agent/{repo_id}` is mounted dynamically when a repo is opened (plus a static
`/agent/default`) and is called by the CopilotKit runtime, not directly.

---

## Module reference

### Backend

**`app/config.py`** — `Settings` (pydantic-settings): LLM fields, Mongo,
`workspaces_dir`, `cors_origins`, graphify flags. `cors_origin_list` splits the
origins string. A module-level `settings` is imported everywhere.

**`app/agent.py`** — `_model()` returns `ChatOpenAI(base_url, api_key, model)` when
`NEBIUS_API_KEY` is set, else the `MODEL` provider string (imported lazily).
`build_agent(workspace, checkpointer=None, tools=None)` compiles the repo-rooted
deepagents graph with `interrupt_on`, the checkpointer, and
`middleware=[CopilotContextMiddleware()]`. **The single place to change the backend
(sandbox), the system prompt, or the agent's tools.**

**`app/middleware.py`** — `CopilotContextMiddleware`: extends state to keep the
`ag-ui` channel and injects `state["ag-ui"]["context"]` (CopilotKit readables) into
the system prompt before each model call. (Context items are `Context` objects,
read by attribute.)

**`app/workspaces.py`** — the repos `APIRouter`: `_materialize()` clones/symlinks a
repo; `tree()` builds the nested listing; routes for `POST /repos`, tree, file,
`/config`, `/fs/list`, and the `watchfiles` WebSocket. `_REGISTRY` maps repos to
workspaces.

**`app/graphify.py`** — `build_graph` (extract) → `start_server` (per-repo MCP) →
`load_tools` (via `MultiServerMCPClient`); `attach()` chains them; `stop_all()`
tears down on shutdown.

**`app/main.py`** — `lifespan` builds the `MongoDBSaver`, mounts the default agent,
and stops graphify on shutdown; adds CORS, includes the router, exposes `/health`.

### Frontend

**`components/FileTree.tsx`** — `openRepo({gitUrl?, localPath?, dest?})` POSTs
`/repos` and returns a `RepoSession`; `FileTree` renders the tree and refetches on
`refreshSignal`.

**`components/RepoOpener.tsx`** — URL/path input, optional "clone into…"
destination, `/config` hint.

**`components/EditorPane.tsx`** — read-only **Monaco** editor of the selected file;
when `interruptStore` holds a pending `edit_file`/`write_file`, renders Monaco's
inline `DiffEditor` with Approve / Reject. Replaces the old `FileViewer`.

**`components/ApprovalGate.tsx`** — registers `useLangGraphInterrupt`, normalizes
`action_requests`, publishes them (+`resolve`) to `interruptStore`, renders a
compact chat card, and resolves `{ decisions: [{type:"approve"|"reject"}] }`.

**`components/interruptStore.ts`** — the external store bridging the interrupt
between `ApprovalGate` (in the provider) and `EditorPane` (outside it).

**`components/FolderBrowser.tsx`** — modal folder picker over `GET /fs/list`.

**`components/ToolRender.tsx`** — catch-all `useCopilotAction({name:"*"})` that
draws each tool call as a compact chip.

**`components/OpenFileContext.tsx`** — shares the open file via
`useCopilotReadable` (reaches the model through `CopilotContextMiddleware`).

**`components/useRepoWatch.ts`** — opens the watch WebSocket and calls back per
change batch; auto-reconnects.

**`app/page.tsx`** — the workbench: holds `session`/`selectedFile`/`refreshTick`,
wires the watcher, renders tree + Monaco editor + chat, and the drag-to-resize
divider.

**`app/api/copilotkit/route.ts`** — reads `x-agent-id` and builds a
`CopilotRuntime` with a `LangGraphHttpAgent` pointed at `{BACKEND}/agent/{agentId}`.

---

## Extending it

**Add a tool** — define a LangChain tool and pass it into `build_agent`:

```python
@tool
def run_linter(path: str) -> str:
    """Lint a file and return findings."""
    ...

def build_agent(workspace, checkpointer=None, tools=None):
    tools = (tools or []) + [run_linter]
    ...
```

graphify's MCP tools arrive the same way, merged in via `attach()`.

**Swap in a sandbox backend** — change one line in `build_agent`:

```python
# pip install langchain-e2b e2b
backend = E2BSandbox(sandbox=Sandbox.create())  # instead of LocalShellBackend
```

For per-repo isolation, create the sandbox in `attach()`/`create_repo`, thread it
into `build_agent`, and tear it down with the graphify server.

**Add an endpoint** — drop a route on the existing router (already included in
`main.py`):

```python
@router.get("/repos/{repo_id}/grep")
async def grep(repo_id: str, q: str) -> dict:
    workspace = _REGISTRY.get(repo_id)
    if workspace is None:
        raise HTTPException(404, "unknown repo_id")
    ...
```

---

## Security & productionizing

`LocalShellBackend` gives the agent **unrestricted host shell and filesystem
access** — fine for trusted local dev, unacceptable for untrusted repos. Swap in a
sandbox backend (E2B, Daytona, Modal, Vercel, AgentCore) so each repo runs
isolated. Human-in-the-loop approval gates every mutation, but **it's a guardrail,
not a sandbox**. The `/fs/list` folder picker exposes host directories to any caller
that reaches the backend — remove or lock it down for networked/multi-user use.

For scale: per-repo agents are mounted in-process and cached. For many repos or
multi-tenant use, route by thread and resolve `root_dir` per thread with agent
caching/eviction, instead of one route per repo.

---

## Troubleshooting

| Symptom                                                       | Fix                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Transaction numbers are only allowed on a replica set`       | Standalone MongoDB. Convert to a single-node replica set (`mongod --replSet rs0` + `rs.initiate()`) and add `?replicaSet=rs0` to `MONGODB_URI` — or use the replica-set service in `docker-compose.yml`. |
| `ModuleNotFoundError: graphify`                               | Install `graphifyy[mcp]` in the **backend venv**, not via `uv tool`/`pipx`.                                 |
| Approval card doesn't render / hangs after approve            | Match `ApprovalGate.tsx` to deepagents' interrupt schema: `{action_requests}` in, `{decisions:[…]}` out.    |
| Tree/editor don't live-update                                 | Check `NEXT_PUBLIC_AGENT_BACKEND` is reachable; watch socket is `ws(s)://<backend>/repos/{id}/watch`.        |
| Agent makes malformed tool calls / loops                      | Use a strong tool-calling model in `NEBIUS_MODEL`.                                                          |
| `GraphRecursionError` / `INCOMPLETE_STREAM`                   | Raise `AGENT_RECURSION_LIMIT`; if hit constantly, the model is looping — use a stronger one.                |
| `404` / "agent not found" on `/agent/{id}`                    | Routes are in-process and not persisted; re-open the repo after a backend restart.                          |
| Cloning a repo restarts the server (tree `404`, watch `403`)  | Launch with `--reload-dir app` so only source is watched, not `workspaces/`.                                 |
| `'Context' object has no attribute 'get'`                     | Read AG-UI context items by attribute, not dict access (see the middleware).                                |
| Monaco doesn't appear                                         | It loads from a CDN on first paint — the browser needs internet once.                                       |
| `WinError 1314` on a local-path repo                          | Enable Windows Developer Mode for symlinks, or use a git URL.                                               |

---

## Closing thoughts

The lesson that kept repeating: when two fast-moving frameworks meet, the bugs
cluster at the seam. Readable context that lands in state instead of the prompt; an
interrupt schema that's a dict-of-decisions, not a list; typed objects where you
assumed dicts; a reloader that watches the directory your agent writes into. None
of these are in any quickstart — they're what you find by reading the adapter
source and the tracebacks. Once each seam is understood, the parts compose into
something genuinely useful: a coding agent, scoped to your repo, that shows you the
diff and waits for your nod.

*Stack: LangChain deepagents · CopilotKit · AG-UI · LangGraph · MongoDB · Monaco ·
FastAPI · Next.js. deepagents, AG-UI, and CopilotKit move fast — if an import or
signature breaks, check current docs and pin versions.*
