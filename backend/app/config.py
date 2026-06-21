"""Environment-backed settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- LLM provider ---------------------------------------------------------
    # Nebius Token Factory is OpenAI-compatible. If NEBIUS_API_KEY is set, the
    # agent uses Nebius; otherwise it falls back to the `model` string (e.g. an
    # Anthropic model via ANTHROPIC_API_KEY).
    nebius_base_url: str = "https://api.tokenfactory.nebius.com/v1"
    nebius_api_key: str | None = None
    # Any tool-calling model from the Token Factory catalogue. See
    # https://docs.tokenfactory.nebius.com/ai-models-inference/overview
    nebius_model: str = "Qwen/Qwen2.5-Coder-32B-Instruct"

    anthropic_api_key: str | None = None
    model: str = "anthropic:claude-sonnet-4-6"  # fallback when Nebius is unset

    # --- Infra ----------------------------------------------------------------
    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_db: str = "deep_coding_agent"
    workspaces_dir: str = "./workspaces"
    cors_origins: str = "http://localhost:3000"
    # LangGraph super-step cap per run (default 25 is too low for a coding agent
    # that explores via many tool calls). Raise if runs hit the recursion limit.
    agent_recursion_limit: int = 50

    # --- graphify (optional per-repo knowledge-graph tool) --------------------
    # Requires `pip install "graphifyy[mcp]"` in this backend's environment.
    enable_graphify: bool = False
    # Backend for extracting non-code files (docs/PDFs). None = code-only, which
    # needs no API key. "openai" works against Nebius if you also set the
    # OpenAI-compatible env that graphify reads.
    graphify_extract_backend: str | None = None

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
