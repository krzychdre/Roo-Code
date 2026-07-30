"""Application settings loaded from environment variables."""

import json
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, HttpUrl, computed_field


class Settings(BaseSettings):
    """Roo Cloud API settings."""

    # extra="ignore": the same .env is shared with docker-compose and carries
    # infra-only keys (COMPOSE_PORT_*, AUTHENTIK_BOOTSTRAP_*, AUTH_PG_PASS, …)
    # that this app doesn't define. Ignore them instead of failing to start.
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Core
    database_url: str = Field(..., description="PostgreSQL connection string")
    secret_key: str = Field(..., description="Secret key for signing tickets, etc.")
    api_base_url: str = Field(..., description="Public URL of this API")
    port: int = Field(8085, description="Port to run the API server on")

    # JWT
    jwt_algorithm: str = "HS256"
    jwt_private_key: Optional[str] = None
    jwt_public_key: Optional[str] = None
    jwt_secret: Optional[str] = None

    # Authentik OAuth
    authentik_base_url: str = Field(..., description="Authentik instance URL (browser-facing / front-channel)")
    # Internal (container-network) Authentik URL for server-to-server calls
    # (token/userinfo/discovery/jwks). In a single docker-compose the api
    # container cannot reach the browser-facing `localhost:9000` — it must use
    # the compose service name (e.g. http://auth_server:9000). Falls back to
    # authentik_base_url when unset, so existing single-host deployments are
    # unaffected.
    authentik_internal_url: Optional[str] = Field(
        None, description="Internal Authentik URL for back-channel calls; falls back to authentik_base_url"
    )
    authentik_app_slug: str = Field("tumble-code", description="Authentik application slug for app-specific endpoints")
    authentik_client_id: str = Field(..., description="OAuth2 client ID")
    authentik_client_secret: Optional[str] = None
    authentik_redirect_uri: str = Field(..., description="OAuth2 redirect URI")

    # CORS - stored as raw string to avoid pydantic-settings v2 JSON-parsing issues
    # with List[str] env vars. Use cors_origins_list property to get the parsed list.
    cors_origins: str = Field(default="*", description="Allowed CORS origins (comma-separated or JSON array)")

    @computed_field(return_type=List[str])
    @property
    def cors_origins_list(self) -> List[str]:
        """Parse cors_origins string into a list.

        Supports JSON array format (e.g. '["https://a.com","https://b.com"]')
        or comma-separated format (e.g. 'https://a.com,https://b.com' or '*').
        """
        try:
            return json.loads(self.cors_origins)
        except (json.JSONDecodeError, ValueError):
            return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    # LLM Proxy
    default_llm_provider: str = "openai"
    openai_api_key: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    xai_api_key: Optional[str] = None

    # Marketplace
    marketplace_source: str = "yaml"
    marketplace_yaml_dir: str = "./config/marketplace"

    # Optional features
    credit_system_enabled: bool = False
    # Live remote-control bridge (socket.io). When enabled the API mounts a
    # socket.io server that relays events/commands between the extension and the
    # web task viewer. Defaults on for self-hosted: the relay is inert until an
    # extension actually connects (which itself is gated by an opt-in extension
    # setting), so enabling it costs nothing when unused.
    bridge_enabled: bool = True
    # Path the socket.io ASGI sub-app is mounted at (the engine.io endpoint).
    # The extension and browser connect with socket.io-client using this `path`.
    bridge_path: str = "/bridge/socket.io"
    telemetry_enabled: bool = True

    # Task sharing. With no organizations configured (self-hosted single-tenant
    # dev), org-level cloud settings are absent, which would leave the extension's
    # Share button disabled. When true, the API advertises task sharing as enabled
    # at the org-less level so a logged-in user can share tasks to the web viewer.
    enable_task_sharing: bool = True
    allow_public_task_sharing: bool = True
    rate_limit_enabled: bool = True
    rate_limit_requests_per_minute: int = 60

    # Data retention. The background sweep only ever acts on policies a user has
    # explicitly switched on in the web settings, so leaving this enabled costs
    # nothing on a deployment where nobody has configured retention. Set to
    # false to guarantee no automatic deletion at all, whatever is saved.
    retention_sweep_enabled: bool = True
    retention_sweep_hours: int = 6


settings = Settings()
