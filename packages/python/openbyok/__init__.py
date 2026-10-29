"""
openbyok — Zero-Dependency Python BYOK AI Toolkit

Interoperates directly with openbyok/cli POSIX 0600 configuration files (~/.<app>/config.json).
Provides:
- PosixFileVault: Per-provider key storage (0600 file, 0700 dir) + Environment Variable precedence.
- ByokClient: Unified multimodal generation across Google Gemini, OpenAI, Anthropic Claude,
  Local Ollama, and custom OpenAI-compatible endpoints with cross-provider failover and budget guards.
"""

from .vault import PosixFileVault, redact_api_key, prompt_masked_input
from .client import ByokClient, BudgetPolicy, BudgetExceededError

__all__ = [
    "PosixFileVault",
    "redact_api_key",
    "prompt_masked_input",
    "ByokClient",
    "BudgetPolicy",
    "BudgetExceededError",
]
