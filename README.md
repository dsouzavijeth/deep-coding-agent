# Deep Coding Agent

A self-hosted coding agent — think Claude Code / Cursor, but yours — built on
LangChain's **deepagents** harness with a **CopilotKit + AG-UI** frontend. Point
it at **any repository** (clone a GitHub URL or open a local path) and chat with an
agent scoped to that repo. Edits and shell commands pause for approval, shown as a
live **diff in a Monaco editor** that stays in sync with the chat.

> 📖 For the architecture deep-dive, design decisions, and the hard-won gotchas,
> see **[the build story](./ARTICLE.md)**.

---

## Features

- **Works on any repo** — clone a URL or symlink a local path; the agent's file
  tools and shell are rooted at that directory.
- **Diff-based approval** — every `edit_file` / `write_file` / `execute` pauses;
  you review the change as an inline Monaco diff and Approve / Reject from the
  editor *or* the chat (they're kept in sync).
- **Knows your open file** — the file in the editor is shared with the agent, so
  "review this file" just works.
- **Live file sync** — a filesystem watcher streams real changes to the tree and
  editor; no optimistic guessing.
- **Durable threads** — conversations are checkpointed in MongoDB and resume
  across restarts.
- **Optional knowledge graph** — each repo can get a per-repo
  [graphify](https://pypi.org/project/graphifyy/) graph the agent queries instead
  of grepping.

---

## Architecture

```
React (CopilotKit UI) ──► CopilotKit Runtime (Next route) ──► AG-UI endpoint ──► deepagents graph
  chat · editor · tree      /api/copilotkit                   /agent/{repo}      (rooted at the repo)
                                                                                      │
                                              MongoDB (threads/state)  ◄──────────────┤
                                              host shell / sandbox     ◄──────────────┤
                                              graphify graph (optional)◄──────────────┘
```

- **deepagents** — agent harness (planning, virtual filesystem, subagents,
  human-in-the-loop), rooted at the repo via its filesystem `backend`.
- **AG-UI** — the agent↔UI protocol; each repo is its own `/agent/{repo_id}`.
- **CopilotKit** — the React client (chat, shared context, interrupt rendering).
- **MongoDB** — the LangGraph checkpointer (durable, resumable threads).

---

## Quick start

**Prerequisites:** Python 3.11+, Node 20+, Git, Docker (for MongoDB), and a
`NEBIUS_API_KEY` (or `ANTHROPIC_API_KEY`).

```bash
# 1. MongoDB
docker compose up -d

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add NEBIUS_API_KEY (+ NEBIUS_MODEL)
uvicorn app.main:app --reload --reload-dir app --port 8000

# 3. Frontend (new terminal)
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Open <http://localhost:3000>, paste a GitHub URL (or local path), and start
chatting.

> `--reload-dir app` is important: it stops the reloader from watching the
> `workspaces/` clone target (which would restart the server on every clone).
> The Monaco editor loads its core from a CDN on first paint (needs internet once).

---

## Configuration

Essential backend env vars (`backend/.env`) — see
[the build story](./ARTICLE.md#configuration-reference) for the full table:

| Variable          | Default                                  | Purpose                                  |
| ----------------- | ---------------------------------------- | ---------------------------------------- |
| `NEBIUS_API_KEY`  | _(unset)_                                | If set, the agent uses Nebius            |
| `NEBIUS_MODEL`    | `Qwen/Qwen2.5-Coder-32B-Instruct`        | Model id — **must support tool calling** |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | OpenAI-compatible LLM base URL           |
| `MONGODB_URI`     | `mongodb://localhost:27017`              | Checkpointer connection                  |
| `WORKSPACES_DIR`  | `./workspaces`                           | Where repos are cloned/linked            |
| `ENABLE_GRAPHIFY` | `false`                                  | Build a per-repo graphify graph on open  |

Frontend (`frontend/.env.local`): `NEXT_PUBLIC_AGENT_BACKEND`
(default `http://localhost:8000`).

---

## Project layout

```
backend/app/
  main.py         # FastAPI app, lifespan, Mongo checkpointer, CORS
  config.py       # env settings
  agent.py        # build_agent(): repo-rooted deepagents graph, gated edits
  middleware.py   # injects the open-file context into the prompt
  workspaces.py   # clone/local, AG-UI mount, tree, file read, watch (WS)
  graphify.py     # per-repo knowledge graph (extract → MCP → tools)
frontend/
  app/page.tsx              # workbench: tree · Monaco editor · chat
  app/api/copilotkit/route.ts  # CopilotKit runtime (per-repo agent by header)
  components/EditorPane.tsx    # Monaco editor; inline diff + approve when editing
  components/ApprovalGate.tsx  # captures edit/exec interrupts; compact chat card
  components/interruptStore.ts # bridges the interrupt between chat and editor
  components/…                 # tree, opener, folder picker, tool chips, watcher
```

A full module-by-module reference lives in
[the build story](./ARTICLE.md#module-reference).

---

## Security

The default backend is `LocalShellBackend`: the agent gets **unrestricted shell
and filesystem access on the host**. That's fine for trusted local development.
For untrusted repos, swap in a sandbox backend (E2B, Daytona, Modal) in
`backend/app/agent.py`. Human-in-the-loop approval gates every mutation, but
**approval is a guardrail, not a sandbox**. The `/fs/list` folder-picker endpoint
also exposes host directories — lock it down for any networked deployment.

---

## Learn more

The **[build story / deep-dive](./ARTICLE.md)** covers how it's wired, the design
choices, the full module reference, how to extend it (tools, sandbox backends,
endpoints), and a troubleshooting catalog of the bugs hit along the way — including
how the agent is made aware of your open file, and how the editor and chat stay in
sync on approvals.
