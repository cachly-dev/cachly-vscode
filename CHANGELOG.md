# Changelog – Cachly Brain VS Code Extension

---

## [0.9.6] – 2026-06-05 — *"v4 Move 1"*

### Added
- **`brain_confirm_ci`** — closed-loop CI self-calibration: confirmed failures boost lesson confidence +15%, false positives reduce it −10% (capped 5–99%). Works automatically via `cachly-action confirm` mode or `cachly brain ci-confirm` CLI.
- **`cachly brain` CLI commands** — `lessons`, `recall`, `stats`, `ci-confirm`, `federation list/contribute` now available from the terminal.

---

## [0.9.5] – 2026-06-02 — *"Clean slate"*

### Changed
- **Marketplace metadata** — removed third-party keywords to comply with Marketplace policy; refined keyword set to `mcp`, `model-context-protocol`, `ai-assistant`, `persistent-memory`, `ambient-learning`, `memory`.
- **Repository link** now points at the public mirror `cachly-dev/cachly-vscode`.
- **Extension icon** — added the Cachly lightning logo (`images/logo.png`).

---

## [0.9.4] – 2026-06-01 — *"CLS auto-learn"*

### Added
- **Compiler Learning Stream hook** — `setup` now installs a post-commit Git hook so the Brain auto-captures a lesson whenever a compiler error disappears after an edit.
