# Multi-Framework (Angular, React, Vue) & Python Interoperability

`openbyok` provides zero-coupling reactive bridges for modern web frameworks and a pure-Python SDK that shares the same CLI credential vault.

---

## 1. Angular Signals (`openbyok/angular`)

```typescript
import { Injectable, signal, computed } from '@angular/core';
import { createByokSignalStore } from 'openbyok/angular';

@Injectable({ providedIn: 'root' })
export class AiStateService {
  public readonly store = createByokSignalStore(
    { signal, computed },
    {
      defaultProvider: 'gemini',
      fallbackProviders: ['openai', 'ollama'],
      defaultVaultMode: 'session',
    }
  );
}
```

---

## 2. React Hooks (`openbyok/react`)

```typescript
import { useState, useEffect } from 'react';
import { createByokReactHook } from 'openbyok/react';

export const useByok = createByokReactHook(
  { useState, useEffect },
  {
    defaultProvider: 'openai',
    fallbackProviders: ['claude', 'ollama'],
  }
);

// Inside a React component:
// const { state, setKey, selectProvider, testConnection, getUsageMetrics } = useByok();
```

---

## 3. Vue 3 Composable (`openbyok/vue`)

```typescript
import { ref, onUnmounted } from 'vue';
import { createByokVueComposable } from 'openbyok/vue';

export const useByok = createByokVueComposable(
  { ref, onUnmounted },
  {
    defaultProvider: 'claude',
    fallbackProviders: ['gemini', 'ollama'],
  }
);

// Inside a Vue <script setup>:
// const { state, setKey, selectProvider, testConnection } = useByok();
```

---

## 4. Python SDK (`openbyok`)

The Python SDK reads and writes the exact same `~/.<app>/config.json` (`0600`) file created by `openbyok/cli` in Node.js:

```python
from openbyok import PosixFileVault, ByokClient, BudgetPolicy

vault = PosixFileVault(config_dir_name=".my-app")
client = ByokClient(
    default_provider="gemini",
    fallback_providers=["openai", "ollama"],
    vault=vault,
    budget_policy=BudgetPolicy(max_requests_per_session=100),
)

text = client.generate_text("Summarize the key specifications.")
```
