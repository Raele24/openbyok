"""
Zero-Dependency Python ByokClient supporting Google Gemini, OpenAI, Anthropic Claude,
Local Ollama, and OpenAI-compatible endpoints with Cross-Provider Failover & Budget Guard.
"""

from dataclasses import dataclass
import json
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

from .vault import PosixFileVault


class BudgetExceededError(Exception):
    """Raised when a session request or token budget limit is exceeded."""


@dataclass
class BudgetPolicy:
    max_requests_per_session: Optional[int] = None
    max_estimated_tokens_per_session: Optional[int] = None


class ByokClient:
    """
    Unified Python BYOK client with per-model and cross-provider failover.
    Uses standard library urllib.request so zero third-party packages are required.
    """

    def __init__(
        self,
        default_provider: str = "gemini",
        fallback_providers: Optional[List[str]] = None,
        vault: Optional[PosixFileVault] = None,
        budget_policy: Optional[BudgetPolicy] = None,
    ) -> None:
        self.default_provider = default_provider.lower()
        self.fallback_providers = [p.lower() for p in (fallback_providers or [])]
        self.vault = vault or PosixFileVault()
        self.budget_policy = budget_policy or BudgetPolicy()
        self.request_count = 0
        self.estimated_tokens = 0
        self.custom_openai_providers: Dict[str, Dict[str, str]] = {}

    def register_openai_compatible(
        self, provider_id: str, base_url: str, default_model: str
    ) -> None:
        self.custom_openai_providers[provider_id.lower()] = {
            "base_url": base_url.rstrip("/"),
            "default_model": default_model,
        }

    def _check_budget(self, prompt: str) -> None:
        if (
            self.budget_policy.max_requests_per_session is not None
            and self.request_count >= self.budget_policy.max_requests_per_session
        ):
            raise BudgetExceededError("Session request limit reached.")
        est_in = max(1, len(prompt) // 4)
        if (
            self.budget_policy.max_estimated_tokens_per_session is not None
            and self.estimated_tokens + est_in
            > self.budget_policy.max_estimated_tokens_per_session
        ):
            raise BudgetExceededError("Session token budget exceeded.")

    def generate_text(
        self,
        user_prompt: str,
        system_prompt: Optional[str] = None,
        provider_id: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout_sec: int = 30,
    ) -> str:
        self._check_budget(user_prompt)
        primary = (provider_id or self.default_provider).lower()
        chain = [primary] + [p for p in self.fallback_providers if p != primary]

        last_err: Optional[Exception] = None
        for idx, pid in enumerate(chain):
            resolved_key = (
                api_key
                if (idx == 0 and api_key is not None)
                else self.vault.resolve_key(pid)
            )
            if idx > 0 and pid != "ollama" and not resolved_key:
                continue

            try:
                text = self._dispatch_provider(
                    provider_id=pid,
                    api_key=resolved_key,
                    user_prompt=user_prompt,
                    system_prompt=system_prompt,
                    model=model if idx == 0 else None,
                    timeout_sec=timeout_sec,
                )
                self.request_count += 1
                self.estimated_tokens += max(1, (len(user_prompt) + len(text)) // 4)
                return text
            except Exception as err:
                last_err = err
                if idx < len(chain) - 1:
                    continue
                raise

        raise last_err or RuntimeError("All configured providers failed.")

    def _dispatch_provider(
        self,
        provider_id: str,
        api_key: str,
        user_prompt: str,
        system_prompt: Optional[str],
        model: Optional[str],
        timeout_sec: int,
    ) -> str:
        if provider_id == "gemini":
            target_model = model or "gemini-3.5-flash"
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{target_model}:generateContent"
            body: Dict[str, Any] = {
                "contents": [{"role": "user", "parts": [{"text": user_prompt}]}]
            }
            if system_prompt:
                body["system_instruction"] = {"parts": [{"text": system_prompt}]}
            data = self._http_post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                payload=body,
                timeout_sec=timeout_sec,
            )
            return str(data["candidates"][0]["content"]["parts"][0]["text"])

        if provider_id == "claude":
            target_model = model or "claude-3-5-haiku-20241022"
            url = "https://api.anthropic.com/v1/messages"
            body = {
                "model": target_model,
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": user_prompt}],
            }
            if system_prompt:
                body["system"] = system_prompt
            data = self._http_post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
                payload=body,
                timeout_sec=timeout_sec,
            )
            return str(data["content"][0]["text"])

        if provider_id == "ollama":
            target_model = model or "llama3.2-vision"
            url = "http://localhost:11434/api/chat"
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": user_prompt})
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            data = self._http_post(
                url,
                headers=headers,
                payload={"model": target_model, "messages": messages, "stream": False},
                timeout_sec=timeout_sec,
            )
            return str(data.get("message", {}).get("content", ""))

        # OpenAI or custom OpenAI-compatible provider
        compat = self.custom_openai_providers.get(provider_id)
        base_url = compat["base_url"] if compat else "https://api.openai.com/v1"
        target_model = model or (compat["default_model"] if compat else "gpt-4o-mini")
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": user_prompt})
        data = self._http_post(
            f"{base_url}/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            payload={"model": target_model, "messages": messages},
            timeout_sec=timeout_sec,
        )
        return str(data["choices"][0]["message"]["content"])

    @staticmethod
    def _http_post(
        url: str, headers: Dict[str, str], payload: Dict[str, Any], timeout_sec: int
    ) -> Dict[str, Any]:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            return json.loads(resp.read().decode("utf-8"))

