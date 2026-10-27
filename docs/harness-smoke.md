# Strict Harness model smoke

A model-in-the-loop check that the hub works through [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) end to end. It is optional: `pnpm test` does not need a model, a Harness install or a network.

The reusable smoke creates an isolated temporary `DSH_HOME`, forces the `read-only` permission preset, and starts a new headless session. Its isolated hub state contains approved **metadata only** for the Web Search Neo and Unity CLI examples; neither capability is started. The smoke validates exactly seven calls through the single outer hub tool — `search`, `inspect`, `tools`, `call` (`add` with `2 + 3`), `skill.load`, `status`, `disable` — followed by the exact assistant token `CAPABILITY_HUB_SMOKE_OK`. Retries, other tools, missing results, tool errors, or extra final text fail validation.

The compact JSON receipt under `data/state/smoke-receipts` records the final assistant text, catalog visibility, selected Harness provider/model, permission preset, action sequence, and model lifecycle. Before loading LM Studio, the smoke checks the process list: an already-loaded matching model is reused and never unloaded by the smoke; a model loaded by the smoke is released after the Harness evidence receipt has been persisted (with TTL as a fallback).

```powershell
pnpm smoke:harness
```

For a stricter source-checkout-only proof, the optional external smoke uses the pinned
local `@playwright/mcp@0.0.79` dev dependency. Qwen must discover it, inspect it,
explicitly enable it, list the narrowed navigation tools, call `browser_navigate` on an
inert `data:` page, load the bundled skill, observe the child running, disable it, and
finally observe an empty enabled list. The receipt rejects retries, any second outer
tool, tool errors, a different model, an unverified page title, or a child that remains
enabled. The browser is headless and isolated, writes only below the temporary smoke
home, and the command never downloads a package:

```powershell
pnpm smoke:harness:external
```

The ordinary `pnpm smoke:harness` remains the fast bundled/offline-contract smoke and
does not require Playwright.

With no model overrides, the default `lmstudio` smoke reads `lms ls --json` and deterministically selects the smallest already-installed `trainedForToolUse` LLM (size first, then `modelKey`). Its `modelKey` is also used as the Harness API model identifier. The smoke never downloads a model. Context is 32K and the idle TTL fallback is one hour. Explicit overrides keep the requested model and disable auto-selection:

```powershell
$env:CAPABILITY_HUB_SMOKE_MODEL = "another-api-identifier"
$env:CAPABILITY_HUB_SMOKE_MODEL_KEY = "installed-lm-studio-model-key"
$env:CAPABILITY_HUB_SMOKE_RECEIPT = "C:\receipts\capability-hub.json"
pnpm smoke:harness
```

Set `CAPABILITY_HUB_SMOKE_DSH_ENTRY` when Harness is installed outside `C:\AI\work\deepseek-harness-runtime`. For non-LM-Studio providers, set `CAPABILITY_HUB_SMOKE_PROVIDER` and, when needed, `CAPABILITY_HUB_SMOKE_PROVIDER_CONFIG_JSON`; the script does not install providers or models.
