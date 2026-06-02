# Changelog – Cachly Brain VS Code Extension

---

## [0.8.5] – 2026-05-25 — *"Always know your Brain's state"*

The status bar finally explains itself.

### Changed
- **Status bar tooltips** — every state now has a rich, plain-language tooltip:
  active ("Brain active — learning from your work" with lessons, recalls, hours saved),
  degraded (amber background + explanation), offline (actionable, lists queued lessons),
  and a previously-dead "Brain: error" state that is now a clickable "setup needed" → runs setup.
- Every status-bar state sets an explicit click command so clicking always does the right thing.

---

## [0.8.4] – 2026-05-18 — *"Trial config fix"*

### Fixed
- Registered the missing `cachly.trialExpiresAt` configuration key — its absence threw a write exception so the resolved `instanceId` was never persisted, breaking reconnects.

---

## [0.8.3] – 2026-05-16 — *"Fail-fast auth"*

### Fixed
- Brain connect now fails fast on auth errors during provisioning instead of hanging, and surfaces an actionable reset/reconnect prompt.

---

## [0.8.2] – 2026-05-15 — *"Docs that do justice"*

A polished Marketplace presence: richer README, better discoverability keywords, and a true WOW-moment story in every CHANGELOG entry.

### Changed
- **README** — hero subtitle, 11 feature blocks with real context, expanded Commands & Settings tables
- **CHANGELOG** — every version now has a named moment that tells the story
- **package.json** — 15 SEO-optimised keywords, improved `description` for Marketplace search

---

## [0.8.1] – 2026-05-15 — *"We see you"*

We now observe every critical moment in the setup journey — so we can fix exactly where devs get stuck.

### Added
- **Lifecycle telemetry** — `vscode_setup_started`, `vscode_trial_started`, `vscode_setup_completed`, `vscode_account_linked`, `vscode_lesson_saved`, `vscode_cls_lesson_saved`, `vscode_brain_panel_opened`. Fire-and-forget, max once per VS Code session. Helps us understand where the magic happens — and where it doesn't yet.

---

## [0.8.0] – 2026-05-07 — *"Touch the Brain"*

The 3D knowledge graph of your Brain now works on every device.

### Added
- **Mobile & tablet Brain Viz** — full touch support: single-finger orbit, two-finger pinch-to-zoom on iPad, Surface, Android. Your knowledge graph, anywhere.

### Fixed
- **GPU memory leak in Brain Viz** — `scene.traverse()` now fully disposes geometries, materials and textures on close. Long coding sessions stay smooth.

---

## [0.7.0] – 2026-04-26 — *"Collective intelligence"*

Your team's AI knowledge is now pooled. Every fix, every solved incident — shared automatically.

### Added
- **Team Brain awareness** — CodeLens and the Brain Health dialog now show your team's combined lesson count and author attribution: `👥 3 team lessons · Elena, Tom`. New team member? Their AI arrives pre-briefed from day one.
- **Brain IQ score** — Brain Health dialog now surfaces IQ Boost % and Crystal freshness. See exactly how smart your AI context has become over time.
- **Memory Crystal** 💎 — when a compressed Crystal is loaded at session start, the status bar shows 💎. That's 800+ lessons delivered to your AI in < 50ms. Context in the blink of an eye.

### Fixed
- CodeLens no longer flickers when switching files rapidly
- Status bar tooltip now stays in sync after `session_start` completes

---

## [0.6.0] – 2026-04-19 — *"The editor that learns from you"*

This is where Cachly Brain becomes a true ambient AI development companion.

### Added
- **Ambient Learning** — you code, the Brain learns. The extension silently watches for repeated typing patterns (Dice similarity ≥ 0.75, 3+ occurrences) and asks if it should remember them. Your muscle memory becomes AI memory — zero friction.
- **CodeLens** — every file gets a Brain hint at the top when your stored lessons match the filename or framework. Your AI already knows what you just opened.
- **Cost savings tracker** — status bar upgrades from `🧠 42 lessons` to `🧠 42 · ~$0.84 saved`. Every recalled lesson is an LLM call your AI didn't have to make. Watch the savings mount.
- **First-hit moment** — on the very first successful Brain recall in a new VS Code window, you see: *"Brain is live — your AI now remembers."* You'll know the exact second it starts working.
- **`Cachly: Save Lesson`** — one command in the Command Palette to capture any solution, fix, or insight directly from your editor. Stored forever, found instantly.
- **Framework detection** — on workspace open, the extension scans `package.json`, `go.mod`, `requirements.txt` and loads the matching stack context. Your AI already knows your tech stack before you ask.
- **New settings**: `cachly.showCostSaved`, `cachly.ambientLearning`, `cachly.codeLens`

---

## [0.5.0] – 2026-04-07 — *"First light"*

The moment the Brain becomes visible.

### Added
- **Status bar** — `🧠 42 lessons  ·  ✅ healthy` lives at the bottom of your VS Code. Always there, always updating. You finally know your AI is actually working.
- **Brain Health panel** — one click: storage usage, lesson count, recall count, estimated tokens saved, cost saved, last session timestamp. Everything your Brain knows about itself, in one view.
- **Manual refresh** — `Cachly: Refresh Brain` in the Command Palette for an instant sync.
