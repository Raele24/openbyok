# UI Integration & Theming Guide

Because every application has its own visual identity, `openbyok/ui` offers three integration levels.

---

## Level 1: Headless Controller (`ByokHeadlessController`)

Use `ByokHeadlessController` when your project has its own custom settings modal and you only want reactive state management:

```typescript
import { createByok } from 'openbyok';
import { ByokHeadlessController } from 'openbyok/ui';

const client = createByok();
const controller = new ByokHeadlessController(client, 'it');

const unsubscribe = controller.subscribe((state) => {
  console.log('Active provider:', state.activeProvider);
  console.log('Has valid key:', state.hasKey);
  console.log('Vault mode:', state.vaultMode);
});
```

---

## Level 2: Themeable `<byok-settings>` Web Component (CSS Variables)

Use `<byok-settings>` for a ready-made credential panel that adapts to your colors, borders, and typography via CSS Custom Properties:

```css
byok-settings {
  --byok-bg: #18181b;
  --byok-surface: #27272a;
  --byok-text: #fafafa;
  --byok-muted: #a1a1aa;
  --byok-border: #3f3f46;
  --byok-accent: #6366f1;
  --byok-danger: #f43f5e;
  --byok-radius: 8px;
  --byok-font: 'Inter', sans-serif;
}
```

---

## Level 3: Unstyled Mode with Custom Class Names (Tailwind / Bootstrap)

Pass `unstyled: true` and your own `classNames` map to style the DOM directly with utility classes:

```typescript
element.connectController(controller, {
  unstyled: true,
  classNames: {
    container: 'p-6 bg-zinc-900 rounded-xl border border-zinc-800 space-y-4',
    header: 'text-lg font-bold text-white',
    label: 'block text-xs font-medium text-zinc-400 mb-1',
    input: 'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white',
    select: 'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white',
    secondaryButton: 'px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold',
    dangerButton: 'px-4 py-2 border border-red-500 text-red-400 rounded-lg text-sm',
  },
});
```
