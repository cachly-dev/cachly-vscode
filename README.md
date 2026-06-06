# 🧠 cachly Brain — VS Code Extension

> **Your AI forgets everything when VS Code closes. This extension makes it remember.**  
> Status bar shows your lesson count live. Brain Health panel shows what it knows. Ambient Learning stores patterns while you code. Team Brain awareness shares knowledge across your whole team. One-click setup, free forever.

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=cachly-dev.cachly-brain">
    <img src="https://img.shields.io/badge/VS%20Code%20Marketplace-v0.9.7-blue?logo=visual-studio-code&logoColor=white" alt="VS Code Marketplace v0.9.7" />
  </a>
  &nbsp;
  <a href="https://cachly.dev?utm_source=vscode-marketplace&utm_medium=readme&utm_campaign=extension">
    <img src="https://img.shields.io/badge/Free%20Brain-€0%2Fmo%20forever-brightgreen" alt="Free Brain" />
  </a>
  &nbsp;
  <img src="https://img.shields.io/badge/License-Apache--2.0-yellow" alt="License" />
</p>

<p align="center">
  <a href="https://cachly.dev?utm_source=vscode-marketplace&utm_medium=readme&utm_campaign=extension-cta">
    <img src="https://img.shields.io/badge/▶_Get_Your_Free_Brain-cachly.dev-7c3aed?style=for-the-badge" alt="Get Free Brain" />
  </a>
</p>

---

## The Pain Points This Solves

**Without this extension:**
- Your AI suggested the same wrong fix 3 sessions in a row — you have no idea how many lessons the Brain actually stored
- You don't know if your MCP server is connected — it just silently doesn't remember
- You waste 10 minutes every session confirming "did the Brain actually learn that?"
- "How much has this actually saved me?" — no idea

**With this extension:**
- Status bar shows `🧠 42 lessons` at a glance — you know it's working
- One click opens the full Brain health panel: storage, tier, recalls, cost saved
- If the MCP server isn't connected, you get a clear nudge with setup instructions
- You see **every lesson** the Brain stored — with what worked, what failed, and severity

---

## Features

### 🧠 Status Bar — Always-on brain gauge
```
🧠 42 lessons  ·  ~$0.84 saved  ·  ✅ healthy
```
Visible every second you're coding. Click to open the full panel. Zero effort, zero noise.

### 🔍 Brain Health Panel
One click reveals everything:
- **Lesson count** — total lessons your Brain has stored
- **Recall count** — how many times your AI retrieved a lesson from the Brain
- **Tokens saved** — estimated LLM tokens the Brain avoided regenerating
- **Cost saved** — estimated $ saved from cached context recall
- **Storage bar** — % of your tier's storage used at a glance
- **Brain IQ** — IQ Boost % and Crystal freshness when `brain_doctor` is active
- **Last session** — timestamp of the most recent Brain interaction

### 📚 Lessons View
See every stored lesson sorted by recency:
- ✅ What worked (exact command, file paths)
- ❌ What failed (with reason and severity)
- 🔴 Critical / 🟡 Major / ⚪ Minor
- Topic tags: `deploy:api`, `fix:auth`, `debug:docker`

### ✨ Ambient Learning *(automatic)*
You code — the Brain learns. The extension silently watches for repeated patterns. Type the same thing 3 times (Dice similarity ≥ 0.75) and it asks: *"Should the Brain remember this?"* One click. Your muscle memory becomes AI memory.

### 🔎 CodeLens — Brain hints in your files
A Brain lesson count appears at the top of every file that matches your stored context. `🧠 3 lessons — tap to recall`. Your AI already knows what you just opened before you type anything.

### 💾 Save Lesson — Capture from your editor
`Cachly: Save Lesson` in the Command Palette. Type the topic, what worked, what failed. The Brain stores it in under 3 seconds. Find it in every future session.

### 🔭 Quick Recall Panel — Search without leaving VS Code
`Cachly: Quick Recall` opens a fuzzy search over all your stored lessons directly in the editor. No terminal, no browser, no context switch.

### 🏗️ Framework Detection — Zero-config stack context
On workspace open, the extension scans `package.json`, `go.mod`, `requirements.txt` and pre-loads the matching stack context into your AI. Your AI already knows your tech stack before you ask anything.

### 👥 Team Brain — Collective knowledge
CodeLens and the Brain Health panel show your team's lesson count and author attribution: `👥 3 team lessons · Elena, Tom`. New team member? Their AI arrives pre-briefed from day one. Every fix your team ever solved — available to every AI, forever.

### 💎 Memory Crystal — Instant context delivery
When a compressed Crystal is loaded at session start, the status bar shows 💎. That's 800+ lessons delivered to your AI in under 50ms. Full context before the first keystroke.

### 🚀 Setup Detection & Instant Trial
If the MCP server isn't connected, the extension detects it and guides you through instant setup — including a 14-day free trial of the Dev tier, no credit card. One-click start from inside VS Code.

---

## Setup in 30 seconds

**Step 1 — Install this extension** from the Marketplace.

**Step 2 — Connect your Brain** (if not done yet):
```bash
npx @cachly-dev/mcp-server@latest autopilot
```
This signs you in, detects your editors (GitHub Copilot, Cursor, Windsurf, etc.), and writes the MCP config automatically.

**Step 3** — Open VS Code. The Brain status bar activates immediately.

---

## With vs. Without the Extension

| Situation | Without extension | With extension |
|-----------|-------------------|----------------|
| Is my Brain actually working? | No idea | `🧠 42 lessons ✅` in status bar |
| Did the AI just learn something? | Check terminal logs | Panel updates live |
| Tokens/money saved? | Invisible | Shown in health panel |
| MCP server disconnected | Silent failure | Clear nudge + fix instructions |
| What has my AI learned? | Can't see it | Full lessons list in editor |
| Brain storage full? | Surprise error | Warning in panel |
| Quick lesson search | Open terminal | In-editor quick recall |

---

## Who This Is For

- **GitHub Copilot + VS Code users** — make Copilot actually remember across sessions
- **Developers with multiple active projects** — one Brain per project, all visible in one panel
- **Teams using cachly** — each member sees their own Brain health
- **Anyone using the cachly MCP server** — the extension is the companion UI

---

## Commands

| Command | What it does |
|---------|-------------|
| `Cachly: Show Brain Health` | Open the full health panel with stats, storage, recalls |
| `Cachly: Show Lessons` | Browse all stored lessons with severity + topic tags |
| `Cachly: Quick Recall` | Fuzzy-search your Brain from inside VS Code |
| `Cachly: Save Lesson` | Capture any solution or insight directly from the editor |
| `Cachly: Refresh Brain` | Manually trigger a Brain sync |
| `Cachly: Setup Brain` | Run the interactive guided setup / instant trial flow |
| `Cachly: Link Account` | Connect an existing cachly account to this VS Code instance |

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cachly.apiKey` | — | API key from [cachly.dev](https://cachly.dev) (auto-set by `npx @cachly-dev/mcp-server@latest autopilot`) |
| `cachly.instanceId` | — | Brain instance ID (auto-set by `npx @cachly-dev/mcp-server@latest autopilot`) |
| `cachly.refreshInterval` | `300` | Auto-refresh interval in seconds |
| `cachly.showStatusBar` | `true` | Show/hide the status bar item |
| `cachly.showCostSaved` | `true` | Show estimated cost savings in the status bar |
| `cachly.ambientLearning` | `true` | Enable automatic pattern detection and lesson prompts |
| `cachly.codeLens` | `true` | Show Brain lesson hints at the top of matching files |

---

## Pricing

The extension is **free forever**. It connects to your cachly Brain:

| Tier | Storage | Price | Best for |
|------|---------|-------|----------|
| **Free** | 25 MB | **€0/mo forever** | Side projects & learning |
| **Dev** | 200 MB | €19/mo | Individual developers |
| **Pro** | 900 MB | €49/mo | Teams |
| **Speed** | 900 MB + Dragonfly | €79/mo | AI-heavy workloads |
| **Business** | 7 GB | €199/mo | Scale-ups |

✅ All plans: **German servers · GDPR-compliant · 99.9% SLA · No credit card for Free**

---

## The Full cachly Ecosystem

| Tool | What it does |
|------|-------------|
| **This extension** | Brain panel inside VS Code |
| **[`npx @cachly-dev/mcp-server@latest autopilot`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | One-command setup for all editors |
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | The Brain backend — works in Claude Code, Cursor, Windsurf, Copilot, Cline, Zed |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | Cut LLM costs 60–90% with semantic caching |
| **[`@cachly-dev/cli`](https://www.npmjs.com/package/@cachly-dev/cli)** | Terminal CLI for Brain management |

**Supported editors (via MCP server):** GitHub Copilot · Cursor · Windsurf · Claude Code · Cline · Zed

---

## Guides & Blog

- **[How to give GitHub Copilot persistent memory](https://cachly.dev/blog)** — VS Code + cachly setup
- **[Windsurf persistent memory](https://cachly.dev/blog/windsurf-persistent-memory)** — full walkthrough
- **[Cline MCP memory](https://cachly.dev/blog/cline-mcp-memory)** — stop re-explaining everything
- **[cachly.dev/docs](https://cachly.dev/docs/ai-memory)** — Full documentation

---

## Links

- 🌐 [cachly.dev](https://cachly.dev?utm_source=vscode-marketplace&utm_medium=readme&utm_campaign=extension) — Dashboard & free Brain signup
- 📦 [MCP Server on npm](https://www.npmjs.com/package/@cachly-dev/mcp-server) — The Brain backend
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 💬 [GitHub Issues](https://github.com/cachly-dev/sdk-vscode/issues) — Bug reports & feature requests
- ⭐ [Star on GitHub](https://github.com/cachly-dev/sdk-vscode) — If this saves you time, a star means a lot!

---

<p align="center">
  <a href="https://cachly.dev?utm_source=vscode-marketplace&utm_medium=readme&utm_campaign=extension-bottom">
    <strong>→ Get your free Brain at cachly.dev — no credit card, no expiry</strong>
  </a>
</p>
