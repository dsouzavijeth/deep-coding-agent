"""FastAPI entrypoint.

Wires the MongoDB checkpointer (durable threads), mounts a default agent and the
per-repo workspace routes, and enables CORS for the frontend.

Run:
    uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langgraph.checkpoint.mongodb import MongoDBSaver
from pymongo import MongoClient

from .config import settings
from .workspaces import router as repos_router, mount_default_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # langgraph-checkpoint-mongodb exposes a single MongoDBSaver that implements
    # the async methods LangGraph needs (aget/aput/alist/...). There is no
    # separate AsyncMongoDBSaver. It connects on construction (it creates
    # indexes), so MongoDB must be running before the backend starts.
    client = MongoClient(settings.mongodb_uri)
    try:
        checkpointer = MongoDBSaver(client, db_name=settings.mongodb_db)
        app.state.checkpointer = checkpointer
        mount_default_agent(app, checkpointer)
        yield
    finally:
        # Stop any per-repo graphify MCP servers, then close the Mongo client.
        from . import graphify
        graphify.stop_all()
        client.close()


app = FastAPI(title="Deep Coding Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(repos_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
