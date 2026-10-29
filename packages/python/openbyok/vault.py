"""
POSIX 0600 Multi-Provider Credential Vault for Python & CLI tools.
Fully compatible with openbyok/cli config.json files.
"""

import getpass
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_ENV_VAR_MAP: Dict[str, str] = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "claude": "ANTHROPIC_API_KEY",
    "ollama": "OLLAMA_API_KEY",
}


def redact_api_key(key: Optional[str]) -> str:
    """Redacts an API key for safe terminal display (e.g. 'AIza...Z4X2')."""
    if not key:
        return "(not configured)"
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"


def prompt_masked_input(prompt_text: str = "Enter API key (input hidden): ") -> str:
    """Reads an API key from the terminal without echoing characters."""
    return getpass.getpass(prompt_text).strip()


class PosixFileVault:
    """
    Stores per-provider API keys in ~/.<config_dir_name>/config.json with
    0700 directory permissions and 0600 file permissions.
    Enforces strict resolution order:
      1. Explicit CLI flag (explicit_key)
      2. Environment Variable (GEMINI_API_KEY, OPENAI_API_KEY, etc.)
      3. Stored per-provider key (config["keys"][provider_id])
    """

    def __init__(
        self,
        config_dir_name: str = ".openbyok",
        config_file_name: str = "config.json",
        env_var_map: Optional[Dict[str, str]] = None,
    ) -> None:
        self.config_dir = Path.home() / config_dir_name
        self.config_file = self.config_dir / config_file_name
        self.env_var_map = {**DEFAULT_ENV_VAR_MAP, **(env_var_map or {})}

    def load_config(self) -> Dict[str, Any]:
        try:
            if self.config_file.exists():
                data = json.loads(self.config_file.read_text(encoding="utf-8"))
                if data.get("apiKey") and "keys" not in data:
                    provider = str(data.get("provider", "gemini")).lower()
                    data["keys"] = {provider: data["apiKey"]}
                return data
        except Exception:
            pass
        return {}

    def save_config(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        self.config_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.config_dir, 0o700)
        except Exception:
            pass

        current = self.load_config()
        merged_keys: Dict[str, str] = {
            **(current.get("keys") or {}),
            **(updates.get("keys") or {}),
        }

        target_provider = str(
            updates.get("provider") or current.get("provider") or "gemini"
        ).lower()

        if updates.get("apiKey"):
            merged_keys[target_provider] = str(updates["apiKey"]).strip()

        merged = {**current, **updates, "keys": merged_keys}
        if target_provider in merged_keys:
            merged["apiKey"] = merged_keys[target_provider]

        self.config_file.write_text(json.dumps(merged, indent=2), encoding="utf-8")
        try:
            os.chmod(self.config_file, 0o600)
        except Exception:
            pass
        return merged

    def set_secret(self, provider_id: str, secret: str) -> None:
        pid = provider_id.lower()
        cfg = self.load_config()
        keys = dict(cfg.get("keys") or {})
        clean = secret.strip()
        if clean:
            keys[pid] = clean
        else:
            keys.pop(pid, None)
        self.save_config({"keys": keys})

    def resolve_key(self, provider_id: str, explicit_key: Optional[str] = None) -> str:
        if explicit_key and explicit_key.strip():
            return explicit_key.strip()

        pid = provider_id.lower()
        env_var = self.env_var_map.get(pid, f"{pid.upper()}_API_KEY")
        env_val = os.environ.get(env_var, "").strip()
        if env_val:
            return env_val

        cfg = self.load_config()
        keys = cfg.get("keys") or {}
        if pid in keys and keys[pid]:
            return str(keys[pid])

        saved_provider = str(cfg.get("provider", "gemini")).lower()
        if cfg.get("apiKey") and saved_provider == pid:
            return str(cfg["apiKey"])

        return ""

    def get_redacted_config(self) -> Dict[str, Any]:
        cfg = self.load_config()
        redacted_keys = {
            k: redact_api_key(v) for k, v in (cfg.get("keys") or {}).items()
        }
        return {
            **cfg,
            "apiKey": redact_api_key(cfg.get("apiKey")),
            "keys": redacted_keys,
        }

