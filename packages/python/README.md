# openbyok (Python SDK)

Zero-dependency Python SDK for Bring Your Own Key (BYOK) AI applications. Shares the exact same `~/.<app>/config.json` (`0600`) format as `openbyok/cli` in Node.js.

## Installation

```bash
pip install "git+https://github.com/Raele24/openbyok.git#subdirectory=packages/python"
```

## Quick Usage

```python
from openbyok import PosixFileVault, ByokClient, BudgetPolicy

vault = PosixFileVault(config_dir_name=".my-app")
client = ByokClient(
    default_provider="gemini",
    fallback_providers=["openai", "ollama"],
    vault=vault,
    budget_policy=BudgetPolicy(max_requests_per_session=50),
)

response = client.generate_text(
    user_prompt="Summarize the key specifications.",
    system_prompt="Be concise and factual.",
)
print(response)
```
