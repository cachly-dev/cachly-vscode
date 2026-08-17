import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import {
  normalizeBaseUrl,
  classifyInstanceError,
  isValidApiKey,
  isValidInstanceId,
  parseJsonc,
  buildClsPostCommitHook,
  CLS_HOOK_VERSION,
  type BrainStatus,
} from './lib/config';
import {
  buildAmbientHook,
  mergeAmbientSettings,
  AMBIENT_SCRIPT_NAMES,
  AMBIENT_HOOK_VERSION,
  type AmbientHookEvent,
  type AmbientHookPaths,
  type ClaudeSettingsLike,
} from './lib/ambient';

interface TopLesson {
  topic: string;
  outcome: string;
  recall_count: number;
  severity?: string;
  what_worked: string;
  ts: string;
  author?: string;
}

interface MemoryData {
  lesson_count: number;
  context_count: number;
  topics: string[];
  top_lessons: TopLesson[];
  last_session?: { summary?: string; focus?: string };
  memory_used_bytes: number;
  memory_limit_bytes: number;
  memory_used_pct: number;
  total_recall_count?: number;
  recall_limit?: number;
  goodwill_message?: string;
  iq_boost_pct?: number;
  team_authors?: string[];
  crystal?: { summary: string; patterns_hit: number; created_at: string };
}

interface BrainHealth {
  lessons: number;
  contexts: number;
  lastSession: string | null;
  status: 'healthy' | 'empty' | 'degraded' | 'unreachable' | 'setup_needed';
  tier: string;
  totalRecalls: number;
  recallLimit: number; // -1 = unlimited
  estimatedTokensSaved: number;
  estimatedCostSaved: number;
  topLessons: TopLesson[];
  topics: string[];
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryUsedPct: number;
  iqBoostPct: number;
  teamAuthors: string[];
  crystal: { summary: string; patterns_hit: number; created_at: string } | null;
  pendingLessons: number; // locally queued offline, not yet synced
  goodwillMessage: string | null;
  insights: BrainInsights | null;
}

interface BrainInsights {
  minutes_saved: number;
  dollars_saved: number;
  recalls_total: number;
  reuse_pct: number;
  ttfr_p50_sec: number;
  ttfr_p90_sec: number;
  currency: string;
  hourly_rate: number;
}

// ~$3 per 1M tokens (GPT-4o input blended rate)
const TOKENS_PER_RECALL = 1200;
const COST_PER_TOKEN = 0.000003;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000)     return `~${(n / 1_000).toFixed(0)}k tokens`;
  return `~${n} tokens`;
}

function fmtMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase() === 'EUR' ? 'EUR' : 'USD';
  return new Intl.NumberFormat(code === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

// ── Offline Lesson Queue ──────────────────────────────────────────────────────
// When the Brain is unreachable (no API key configured, or network error),
// lessons are stored locally in globalState and synced automatically once
// the Brain becomes available again. Nothing is lost.
interface OfflineLesson {
  topic: string;
  outcome: string;
  what_worked: string;
  context?: string;
  severity?: string;
  tags?: string[];
  source: string;
  savedAt: number; // epoch ms
}
const OFFLINE_QUEUE_KEY = 'cachly.offlineLessonQueue';
let syncTimer: NodeJS.Timeout | undefined;

function enqueueOfflineLesson(lesson: OfflineLesson): void {
  if (!extensionContext) return;
  const queue = extensionContext.globalState.get<OfflineLesson[]>(OFFLINE_QUEUE_KEY, []);
  // Cap at 500 lessons to avoid unbounded growth
  queue.push(lesson);
  if (queue.length > 500) queue.splice(0, queue.length - 500);
  void extensionContext.globalState.update(OFFLINE_QUEUE_KEY, queue);
}

async function flushOfflineQueue(): Promise<number> {
  if (!extensionContext) return 0;
  const queue = extensionContext.globalState.get<OfflineLesson[]>(OFFLINE_QUEUE_KEY, []);
  if (queue.length === 0) return 0;

  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  const baseUrl = apiBaseUrl(config);
  if (!isValidApiKey(apiKey) || !instanceId) return 0;

  let synced = 0;
  const failed: OfflineLesson[] = [];
  for (const lesson of queue) {
    try {
      await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/learn`, apiKey, {
        ...lesson,
        source: lesson.source + '-offline-sync',
      });
      synced++;
    } catch {
      failed.push(lesson);
    }
  }

  await extensionContext.globalState.update(OFFLINE_QUEUE_KEY, failed);
  return synced;
}

function startSyncTimer(): void {
  if (syncTimer) clearInterval(syncTimer);
  // Try to flush offline queue every 5 minutes
  syncTimer = setInterval(() => { void flushOfflineQueue(); }, 5 * 60 * 1000);
}

// ── Ambient Learning state ────────────────────────────────────────────────────
interface AmbientEntry { sampleEdit: string; count: number; prompted: boolean }
const ambientMap = new Map<string, AmbientEntry>();
let ambientDebounce: NodeJS.Timeout | undefined;

// Auto-context capture state: debounce + per-session dedupe so we POST each file
// at most once per editor session (no API spam).
let autoContextDebounce: ReturnType<typeof setTimeout> | undefined;
const capturedContextFiles = new Set<string>();

// ── CLS: Compiler Learning Stream state ──────────────────────────────────────
// Tracks diagnostic errors that appeared, then disappeared after an edit.
// When an error vanishes → infer a (problem, fix) pair and save as a brain lesson.
interface ClsTrackedDiag {
  message: string;
  source: string;
  code: string;
  languageId: string;
  uri: string;
  appearedAt: number;
}
// key = `${uri}::${code}::${message.slice(0,40)}`
const clsActiveErrors = new Map<string, ClsTrackedDiag>();
let clsLastEditedUri = '';
let clsLastEditTime = 0;

// ── Proactive notification budget ────────────────────────────────────────────
// Cachly grew five surfaces that may interrupt unasked — proactive briefing,
// the ambient "save this pattern?" prompt, CLS auto-learn, framework detection
// and the session summary. Each gated itself locally (once per file, once per
// session, …), which looked reasonable per surface and added up to a popup
// every few minutes.
//
// They now share one budget: at most one interruption every
// PROACTIVE_MIN_GAP_MS, and PROACTIVE_MAX_PER_SESSION in total. Whatever the
// budget denies degrades to the status bar — always visible, never in the way.
// `cachly.quietMode` turns every proactive popup off outright.
const PROACTIVE_MIN_GAP_MS = 20 * 60_000;
const PROACTIVE_MAX_PER_SESSION = 3;
let lastProactiveAt = 0;
let proactiveCount = 0;

/**
 * Ask for permission to interrupt the user. Returns true at most
 * PROACTIVE_MAX_PER_SESSION times per session and never twice within
 * PROACTIVE_MIN_GAP_MS — the caller must fall back to a status-bar message.
 * Callers spend the budget by asking, so only call it right before showing.
 */
function claimInterrupt(): boolean {
  if (vscode.workspace.getConfiguration('cachly').get<boolean>('quietMode', false)) return false;
  if (proactiveCount >= PROACTIVE_MAX_PER_SESSION) return false;
  if (Date.now() - lastProactiveAt < PROACTIVE_MIN_GAP_MS) return false;
  lastProactiveAt = Date.now();
  proactiveCount++;
  return true;
}

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let lastHealth: BrainHealth | undefined;

// Last snapshot that actually carried data, persisted across editor restarts.
// On a cold start the first fetch often runs before the network is up (or while
// the instance is still waking) and comes back zeroed — which repainted real
// monthly counters as "0/500 recalls" after every reboot. We render this
// snapshot instead until a good fetch replaces it.
const LAST_GOOD_HEALTH_KEY = 'cachly.lastGoodHealth';
interface HealthSnapshot {
  lessons: number;
  totalRecalls: number;
  recallLimit: number;
  estimatedTokensSaved: number;
  ts: number;
}
let brainPanel: vscode.WebviewPanel | undefined;
let extensionContext: vscode.ExtensionContext;

// Resolved once on activation from the real extension manifest so telemetry
// always reports the installed version (was hardcoded → analytics stuck on one).
let extensionVersion = '0.0.0';

// Session-summary tracking: count lessons saved during this VS Code window session
let sessionLessonsAtActivation = 0;
let sessionActivatedAt = 0;

// ── Ambient recall net-token accounting (Ambient Recall Tier B, §6.7) ──────────
// The roadmap (§6.2) requires measuring the *net* token impact of pushing recall
// into context — not just the gross injected cost. We record injected tokens at
// the real injection surface (the @cachly participant streams lessons into chat)
// and, per the extension's own ~TOKENS_PER_RECALL-saved-per-recall model, derive
// a net estimate that is shown in the Brain Health panel and status-bar tooltip.
// Persisted cumulatively in globalState; the session view resets each activation.
const AMBIENT_INJECTED_KEY = 'cachly.ambientInjectedTokens';
const AMBIENT_INJECTIONS_KEY = 'cachly.ambientInjectionCount';
let sessionInjectedTokens = 0;
let sessionInjections = 0;

function estimateTokens(s: string): number {
  return Math.ceil((s ?? '').length / 4);
}

// Record one ambient injection (lessons surfaced into the AI's context). Bumps
// the session + cumulative counters and logs the gross cost. Best-effort — an
// accounting failure must never affect the recall itself.
function recordAmbientInjection(injectedTokens: number, lessonsSurfaced: number): void {
  if (injectedTokens <= 0 || lessonsSurfaced <= 0) return;
  sessionInjectedTokens += injectedTokens;
  sessionInjections += lessonsSurfaced;
  try {
    if (extensionContext) {
      const totalTok = extensionContext.globalState.get<number>(AMBIENT_INJECTED_KEY, 0) + injectedTokens;
      const totalInj = extensionContext.globalState.get<number>(AMBIENT_INJECTIONS_KEY, 0) + lessonsSurfaced;
      void extensionContext.globalState.update(AMBIENT_INJECTED_KEY, totalTok);
      void extensionContext.globalState.update(AMBIENT_INJECTIONS_KEY, totalInj);
    }
  } catch { /* best-effort */ }
  log(`ambient-recall: injected ~${injectedTokens} tok across ${lessonsSurfaced} lesson(s) ` +
    `(session ~${sessionInjectedTokens} tok / ${sessionInjections} surfaced)`);
}

// Canonical production API base. Read via apiBaseUrl() — never inline config.get
// with a string default, because vscode's get(key, default) only falls back to
// the default when the value is `undefined`. A user who has `cachly.apiUrl` set
// to an EMPTY STRING (a very common mistake / stale setting) would otherwise get
// `''` back, making every request a host-less relative URL that always fails →
// the Brain shows "OFFLINE" forever. apiBaseUrl() treats empty/whitespace as
// "unset" and also strips trailing slashes so URL concatenation stays correct.
const DEFAULT_API_URL = 'https://api.cachly.dev';
function apiBaseUrl(config?: vscode.WorkspaceConfiguration): string {
  const cfg = config ?? vscode.workspace.getConfiguration('cachly');
  return normalizeBaseUrl(cfg.get<string>('apiUrl', ''), DEFAULT_API_URL);
}

// ── Output channel / structured logging ───────────────────────────────────────
// A single "Cachly Brain" output channel that records every config resolution,
// HTTP call (status + latency) and diagnostic. When a user reports "OFFLINE",
// the logs here (or the Brain Doctor below) say exactly why — no guessing.
let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Cachly Brain');
  }
  return outputChannel;
}
function log(message: string, ...details: unknown[]): void {
  const ts = new Date().toISOString();
  let line = `[${ts}] ${message}`;
  if (details.length) {
    line += ' ' + details.map((d) =>
      typeof d === 'string' ? d : (() => { try { return JSON.stringify(d); } catch { return String(d); } })(),
    ).join(' ');
  }
  getOutputChannel().appendLine(line);
}

// VS Code's .vscode/settings.json is JSONC. parseJsonc (from ./lib/config) is
// used everywhere we read it — plain JSON.parse throws on comments/trailing
// commas, which used to cause stale-cache fallback and settings.json wipes.


export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  // Read the real installed version from the manifest (cachly-dev.cachly-brain).
  extensionVersion =
    (vscode.extensions.getExtension('cachly-dev.cachly-brain')?.packageJSON?.version as string | undefined) ??
    (context.extension?.packageJSON?.version as string | undefined) ??
    extensionVersion;
  context.subscriptions.push({ dispose: () => brainPanel?.dispose() });
  context.subscriptions.push(getOutputChannel());
  log(`Cachly Brain activated (v${extensionVersion})`);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'cachly.showBrainHealth';
  statusBarItem.tooltip = 'Cachly Brain — click for details';
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cachly.showBrainHealth', showBrainHealthPanel),
    vscode.commands.registerCommand('cachly.showLessons', showLessonsPanel),
    vscode.commands.registerCommand('cachly.refreshBrain', () => updateStatusBar()),
    vscode.commands.registerCommand('cachly.saveLesson', saveLessonCommand),
    vscode.commands.registerCommand('cachly.setupAI', setupAICommand),
    vscode.commands.registerCommand('cachly.setup', setupAICommand),
    vscode.commands.registerCommand('cachly.linkAccount', linkAccountCommand),
    vscode.commands.registerCommand('cachly.recallForFile', recallForFileCommand),
    vscode.commands.registerCommand('cachly.resetAuth', resetAuthCommand),
    vscode.commands.registerCommand('cachly.diagnose', runBrainDoctor),
    vscode.commands.registerCommand('cachly.showLogs', () => getOutputChannel().show(true)),
  );

  registerChatParticipant(context);

  // Record session start lesson count for end-of-session summary
  sessionActivatedAt = Date.now();
  void fetchBrainHealth().then((h) => { sessionLessonsAtActivation = h?.lessons ?? 0; }).catch(() => {});

  // Session-summary on window close
  context.subscriptions.push({
    dispose: () => void showSessionSummary(),
  });

  // Config change → restart loop
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cachly')) startRefreshLoop();
    }),
  );

  // ── Ambient Learning: detect repeated edit patterns, prompt to save as lesson ─
  const cfg = vscode.workspace.getConfiguration('cachly');
  if (cfg.get<boolean>('ambientLearning', true)) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        // Track last edited URI + time for CLS pairing
        clsLastEditedUri = e.document.uri.toString();
        clsLastEditTime = Date.now();

        if (ambientDebounce) clearTimeout(ambientDebounce);
        ambientDebounce = setTimeout(() => handleAmbientEdit(e), 1500);
      }),
    );
  }

  // ── CLS: Compiler Learning Stream — auto-learn from compiler errors ────────
  // When a diagnostic error appears, we track it. When it disappears after an
  // edit to that file, we infer a (problem→fix) pair and save it as a brain lesson.
  if (cfg.get<boolean>('clsLearning', true)) {
    context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        void handleClsDiagnosticsChange(e);
      }),
    );
  }

  // ── Proactive briefing: warn the moment a risky file is opened (push, not pull) ─
  // v4 Move 2. Calls /instances/:id/briefing with event_type=file_open; if the
  // Brain holds a high-confidence failure pattern for this file, surface it before
  // the developer types anything. Debounced + deduped so it never nags.
  if (cfg.get<boolean>('proactiveBriefing', true)) {
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') return;
        if (briefingDebounce) clearTimeout(briefingDebounce);
        briefingDebounce = setTimeout(() => void proactiveBriefingForDocument(doc), 1200);
      }),
    );
  }

  // ── Auto-capture WIP context → fills the Brain's "Context Entries" ─────────────
  // The plugin captures what you're working on (once per file per session, heavily
  // debounced) so context populates without an MCP agent. Opt-out: cachly.autoContext.
  if (cfg.get<boolean>('autoContext', true)) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document.uri.scheme !== 'file') return;
        const docRef = editor.document;
        if (autoContextDebounce) clearTimeout(autoContextDebounce);
        autoContextDebounce = setTimeout(() => void captureWipContext(docRef), 8000);
      }),
    );
  }

  // ── CodeLens: Brain lessons relevant to open file ─────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      new CachlyCodeLensProvider(),
    ),
  );

  startRefreshLoop();

  // ── Trial expiry banner — shown on startup if trial key is stored ──────────
  {
    const trialConfig = vscode.workspace.getConfiguration('cachly');
    const trialExpiresAt = trialConfig.get<string>('trialExpiresAt', '');
    if (trialExpiresAt) {
      const expiresDate = new Date(trialExpiresAt);
      const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 0) {
        void vscode.window.showWarningMessage(
          '🧠 Cachly Brain trial has expired. Link your account to continue.',
          'Link Account',
        ).then((choice) => { if (choice === 'Link Account') void linkAccountCommand(); });
      } else if (daysLeft <= 7) {
        void vscode.window.showInformationMessage(
          `🧠 Cachly Brain trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. Link your account to keep data.`,
          'Link Account', 'Later',
        ).then((choice) => { if (choice === 'Link Account') void linkAccountCommand(); });
      }
    }
  }

  // ── Auto-Onboarding: silently provision credentials on every activation ─────
  // Zero-friction: try GitHub silent auth first, then instant-trial — no clicks.
  // Only falls back to the manual wizard if both methods are unavailable (offline).
  {
    const bootConfig = vscode.workspace.getConfiguration('cachly');
    const bootKey = bootConfig.get<string>('apiKey', '');
    const bootInstance = bootConfig.get<string>('instanceId', '');
    if (!isValidApiKey(bootKey) || !bootInstance) {
      // Small delay so VS Code finishes loading before hitting the network
      setTimeout(() => {
        void silentAutoSetup(context).then((provisioned) => {
          if (!provisioned) {
            // Both GitHub auth and instant-trial failed (fully offline / API down).
            // Show the manual wizard as a last resort — but only once.
            const onboardingShown = context.globalState.get<boolean>('onboardingShown', false);
            if (!onboardingShown) {
              void context.globalState.update('onboardingShown', true);
              void vscode.window.showInformationMessage(
                '🧠 Your AI forgets everything between sessions. Cachly gives it permanent memory — free, 60-second setup.',
                'Set up now',
                'Later',
              ).then((action) => {
                if (action === 'Set up now') void vscode.commands.executeCommand('cachly.setup');
              });
            }
          }
        });
      }, 2000);
    }
  }

  // Visible "welcome back" briefing once per activation (the startup wow).
  // Note: the extension must never POST /recall as a heartbeat — those pings
  // used to inflate the recall counter every ROI metric is derived from.
  // Recalls are only counted when an AI (or @cachly chat) actually reuses a lesson.
  void showStartupBriefing();

  // Offline queue: try to sync immediately on activation, then every 5 min
  startSyncTimer();
  void flushOfflineQueue().then((n) => {
    if (n > 0) {
      if (!vscode.workspace.getConfiguration('cachly').get<boolean>('quietMode', false)) {
        void vscode.window.showInformationMessage(
          `🧠 cachly: synced ${n} offline lesson${n === 1 ? '' : 's'} to your Brain.`,
        );
      }
      updateStatusBar();
    }
  });

  // Zero-Config Framework Detection — run once after workspace opens
  detectAndSuggestFrameworks(context);

  // MCP setup-detection: if Brain is configured but no .mcp.json found in workspace,
  // auto-write it — runs after silentAutoSetup has had time to complete (6s delay)
  setTimeout(() => checkMcpSetupAndNudge(context), 6000);
}

// ── Refresh loop ──────────────────────────────────────────────────────────────

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);

  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  // Use getEffectiveInstanceId async — for the synchronous gate we check global first,
  // then let updateStatusBar do the full async resolution on every tick.
  const instanceIdQuick = config.get<string>('instanceId', '');

  if (!isValidApiKey(apiKey) || !instanceIdQuick) {
    statusBarItem.text = '$(brain) cachly: click to connect';
    statusBarItem.command = 'cachly.setup';
    statusBarItem.tooltip = 'Connect your AI Brain — free, one-click setup (no credit card)';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  // Restore normal click target after setup
  statusBarItem.command = 'cachly.showBrainHealth';
  statusBarItem.tooltip = 'Cachly Brain — click for details';
  statusBarItem.backgroundColor = undefined;

  updateStatusBar();
  const interval = config.get<number>('refreshInterval', 300) * 1000;
  refreshTimer = setInterval(() => updateStatusBar(), interval);
}

// ── Der stille Nutzer: nach 100 Lektionen einmal nach einer Adresse fragen ───
//
// ─── DER FALL, DEN DAS HIER SCHLIESST ────────────────────────────────────────
//
// Der Sofort-Test (silentAutoSetup, Schritt 2) ist absichtlich klickfrei: Kein
// Konto, keine Adresse, sofort ein Brain. Genau das erzeugt aber Nutzer, die
// niemand erreichen kann. Ihre Adresse lautet <uuid>@trial.cachly.dev, und
// isLikelyTestEmail im Backend sortiert sie aus jeder Rundmail aus.
//
// Gemessen am 13.08.2026 in der Produktionsdatenbank: Der aktivste Nutzer des
// Tages war ein solcher Sofort-Test — 400 Lektionen an einem Tag, 1370 seit
// dem 12.07., taeglich in Benutzung. Er bekommt weder die Warnung vor dem
// Testende noch einen Hinweis, wenn sein Speicher voll laeuft. Der wertvollste
// Nutzer, den cachly hatte, war unerreichbar.
//
// ─── WARUM AN DIESER STELLE ──────────────────────────────────────────────────
//
// Die Zahl kommt aus fetchBrainHealth, also vom Server — nicht aus einem
// eigenen Zaehler in der Erweiterung. Ein zweiter Zaehler waere eine zweite
// Wahrheit: Er wuerde Lektionen uebersehen, die ueber MCP oder die
// Weboberflaeche entstanden sind, und beim Neuaufsetzen der Erweiterung wieder
// bei null anfangen.
//
// ─── WANN ER SCHWEIGT ────────────────────────────────────────────────────────
//
// Bei einem verknuepften Konto (cky_live_), bei weniger als 100 Lektionen, im
// Notbetrieb (dann ist die API nicht erreichbar und Verknuepfen wuerde ohnehin
// scheitern), und nach einem "Nicht mehr fragen". Ein "Spaeter" verstummt fuer
// 14 Tage. Ein Hinweis, der sich wiederholt, wird weggeklickt statt gelesen.
const ADRESSE_GEFRAGT_KEY = 'cachly.addressPromptState';
const ADRESSE_SCHWELLE = 100;
const ADRESSE_ERNEUT_NACH_MS = 14 * 24 * 60 * 60 * 1000;

type AdressStand = { zuletzt: number; nie?: boolean };

async function frageNachAdresse(lessons: number, imNotbetrieb: boolean): Promise<void> {
  if (imNotbetrieb || lessons < ADRESSE_SCHWELLE) return;
  if (!extensionContext) return;

  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  // Nur Sofort-Test-Schluessel haben kein Konto dahinter. cky_live_ ist
  // verknuepft, cky_test_ gehoert uns selbst.
  if (!apiKey.startsWith('cky_trial_')) return;

  const stand = extensionContext.globalState.get<AdressStand>(ADRESSE_GEFRAGT_KEY);
  if (stand?.nie) return;
  if (stand && Date.now() - stand.zuletzt < ADRESSE_ERNEUT_NACH_MS) return;

  // Zuerst merken, dann fragen. Andersherum wuerde ein Absturz zwischen Frage
  // und Merken den Hinweis bei jedem Aktualisieren erneut zeigen.
  await extensionContext.globalState.update(ADRESSE_GEFRAGT_KEY, { zuletzt: Date.now() } as AdressStand);
  trackVSCodeEvent('vscode_address_prompt_shown', {
    apiKey,
    instanceId: config.get<string>('instanceId', ''),
    once: true,
  });

  const antwort = await vscode.window.showInformationMessage(
    `🧠 Your Brain holds ${lessons} lessons — and we have no way to reach you. ` +
    `This setup has no email attached, so you won't hear from us before your trial ends ` +
    `or your Brain runs out of space. Linking an account takes about 20 seconds and keeps everything you have.`,
    'Link account', 'Later', "Don't ask again",
  );

  if (antwort === 'Link account') {
    await linkAccountCommand();
  } else if (antwort === "Don't ask again") {
    await extensionContext.globalState.update(ADRESSE_GEFRAGT_KEY, { zuletzt: Date.now(), nie: true } as AdressStand);
  }
}

async function updateStatusBar() {
  try {
    // Never-connected state: a fresh install has no apiKey/instance. fetchBrainHealth
    // would report 'unreachable' (→ "OFFLINE"), which wrongly reads as a network blip.
    // Show a loud, friendly "Connect your Brain" instead so nobody sits in silence.
    const cfg0 = vscode.workspace.getConfiguration('cachly');
    const hasKey = isValidApiKey(cfg0.get<string>('apiKey', ''));
    const hasInstance = !!(await getEffectiveInstanceId());
    if (!hasKey || !hasInstance) {
      statusBarItem.text = '$(plug) Connect your Brain';
      statusBarItem.tooltip = new vscode.MarkdownString(
        `**🧠 cachly is installed — but not connected yet**\n\n` +
          `Click to connect your Brain (one browser click). Then your AI gets persistent ` +
          `memory, automatic learning from your fixes, and a briefing at the start of every session.`,
      );
      statusBarItem.command = 'cachly.setup';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.show();
      return;
    }

    const prevRecalls = lastHealth?.totalRecalls ?? 0;
    const health = await fetchBrainHealth();

    // Cold-start guard: an empty-handed fetch (network still down, instance
    // waking, transient zeroed stats) must not repaint real counters as zeros.
    const snapshot = extensionContext?.globalState.get<HealthSnapshot>(LAST_GOOD_HEALTH_KEY);
    const cameBackEmpty = health.lessons === 0 && health.totalRecalls === 0
      && (health.status === 'unreachable' || health.status === 'degraded' || health.status === 'empty');
    let showingSnapshot = false;
    if (cameBackEmpty && snapshot && (snapshot.lessons > 0 || snapshot.totalRecalls > 0)) {
      health.lessons = snapshot.lessons;
      health.totalRecalls = snapshot.totalRecalls;
      health.recallLimit = snapshot.recallLimit;
      health.estimatedTokensSaved = snapshot.estimatedTokensSaved;
      health.estimatedCostSaved = snapshot.estimatedTokensSaved * COST_PER_TOKEN;
      health.status = 'degraded';
      showingSnapshot = true;
    } else if (health.lessons > 0 || health.totalRecalls > 0) {
      const next: HealthSnapshot = {
        lessons: health.lessons,
        totalRecalls: health.totalRecalls,
        recallLimit: health.recallLimit,
        estimatedTokensSaved: health.estimatedTokensSaved,
        ts: Date.now(),
      };
      void extensionContext?.globalState.update(LAST_GOOD_HEALTH_KEY, next);
    }
    lastHealth = health;

    // Fragt hoechstens einmal alle 14 Tage und nur bei einem Sofort-Test ohne
    // Konto. void: die Statuszeile darf nicht auf eine Nutzerantwort warten.
    void frageNachAdresse(health.lessons, showingSnapshot);

    if (health.status === 'setup_needed') {
      statusBarItem.text = '$(warning) Brain: re-auth needed';
      statusBarItem.tooltip = new vscode.MarkdownString(
        `**🔐 Brain needs re-authentication**\n\nYour API key looks expired or revoked. Click to reconnect — takes 10 seconds.`,
      );
      statusBarItem.command = 'cachly.setup';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.show();
      return;
    }

    if (health.status === 'empty') {
      statusBarItem.text = '$(brain) Brain: ready';
      statusBarItem.tooltip = new vscode.MarkdownString(
        `**🧠 Brain is ready and listening**\n\n` +
        `No lessons yet — that's normal for a fresh setup.\n\n` +
        `Just code as usual. The brain learns automatically from repeated patterns, ` +
        `bug-fix commits, and lessons you save with **Cachly: Save Lesson**.\n\n` +
        `_Click to open Brain Health._`,
      );
      statusBarItem.command = 'cachly.showBrainHealth';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.show();
      return;
    }

    if (health.status === 'unreachable') {
      const offlineCount = extensionContext?.globalState.get<OfflineLesson[]>(OFFLINE_QUEUE_KEY, []).length ?? 0;
      const offlineSuffix = offlineCount > 0 ? ` · ${offlineCount} offline` : '';
      statusBarItem.text = `$(error) Brain: OFFLINE${offlineSuffix}`;
      statusBarItem.tooltip = new vscode.MarkdownString(
        `**🧠 Brain unreachable**\n\n` +
        (offlineCount > 0
          ? `${offlineCount} lesson${offlineCount === 1 ? '' : 's'} queued locally — they'll sync automatically when the connection is back.\n\n`
          : `Your editor can't reach the Brain right now.\n\n`) +
        `This is usually a temporary network blip or a provisioning instance.\n\n` +
        `_Click to open Brain Health and check the connection._`,
      );
      statusBarItem.command = 'cachly.showBrainHealth';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      const icon = health.status === 'healthy' ? '$(brain)' : '$(warning)';
      // Limited tiers report a monthly counter, unlimited tiers all-time —
      // say which one, and never decorate the bar with fabricated derivatives.
      const monthly = health.recallLimit > 0;
      const recallLabel = monthly
        ? `${health.totalRecalls}/${health.recallLimit} recalls`
        : `${health.totalRecalls} recalls`;
      const tokenSuffix = health.estimatedTokensSaved >= 1000
        ? ` · ${fmtTokens(health.estimatedTokensSaved).replace(' tokens', ' tok')}`
        : '';
      statusBarItem.text = `${icon} Brain: ${health.lessons} lessons · ${recallLabel}${tokenSuffix}`;
      statusBarItem.tooltip = new vscode.MarkdownString(
        `**🧠 Brain active — learning from your work**\n\n` +
        `- 📚 **${health.lessons}** lessons remembered\n` +
        `- 🔁 **${health.totalRecalls}** recalls ${monthly ? `of ${health.recallLimit} this month` : 'all-time'}\n` +
        (health.estimatedTokensSaved >= 1000 ? `- 💰 ${fmtTokens(health.estimatedTokensSaved)} saved (est. ~${TOKENS_PER_RECALL} tok per reused lesson)\n` : '') +
        (sessionInjections > 0 ? `- 🔬 Ambient recall (session): ${sessionInjections} surfaced · ~${sessionInjectedTokens} tok injected\n` : '') +
        (health.status === 'degraded'
          ? (showingSnapshot
            ? `\n⚠️ _Showing last known counts — reconnecting to your Brain…_\n`
            : `\n⚠️ _Degraded: brain is reachable but some features are slow._\n`)
          : '') +
        `\n_Click to open Brain Health._`,
      );
      statusBarItem.command = 'cachly.showBrainHealth';
      statusBarItem.backgroundColor = health.status === 'degraded'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    }
    statusBarItem.show();

    // ── First Success Moment ─────────────────────────────────────────────────
    const config2 = vscode.workspace.getConfiguration('cachly');
    const instanceId = config2.get<string>('instanceId', '');
    const firstHitKey = `firstHit:${instanceId}`;
    const alreadyShown = extensionContext.globalState.get<boolean>(firstHitKey, false);

    if (!alreadyShown && prevRecalls === 0 && health.totalRecalls > 0 && health.topLessons.length > 0) {
      const lesson = health.topLessons[0];
      await extensionContext.globalState.update(firstHitKey, true);
      const action = await vscode.window.showInformationMessage(
        `🎉 First Brain hit! Recalled "${lesson.topic}" — saved ~1,200 tokens (~$0.004). Your AI won't re-research this again.`,
        'Show Brain',
        'Dismiss',
      );
      if (action === 'Show Brain') showBrainHealthPanel();
    }
  } catch {
    statusBarItem.text = '$(brain) Brain: setup needed';
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**🧠 Brain not connected**\n\n` +
      `Couldn't read your Brain — usually means setup isn't finished yet.\n\n` +
      `_Click to run setup and connect your Brain._`,
    );
    statusBarItem.command = 'cachly.setup';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.show();
  }
}

// ── Brain Health fetch ────────────────────────────────────────────────────────

async function fetchBrainHealth(): Promise<BrainHealth> {
  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  const baseUrl = apiBaseUrl(config);

  const result: BrainHealth = {
    lessons: 0, contexts: 0, lastSession: null,
    status: 'unreachable', tier: 'unknown',
    totalRecalls: 0, recallLimit: -1, estimatedTokensSaved: 0, estimatedCostSaved: 0,
    topLessons: [], topics: [],
    memoryUsedBytes: 0, memoryLimitBytes: 0, memoryUsedPct: 0,
    iqBoostPct: 0, teamAuthors: [], crystal: null,
    pendingLessons: extensionContext?.globalState.get<OfflineLesson[]>(OFFLINE_QUEUE_KEY, []).length ?? 0,
    goodwillMessage: null,
    insights: null,
  };

  if (!isValidApiKey(apiKey) || !instanceId) return result;

  // Instance fetch with one transient-retry — a single network blip or slow
  // container restart must not flip the status bar to OFFLINE permanently.
  const fetchInstOnce = () => apiGet(`${baseUrl}/api/v1/instances/${instanceId}`, apiKey) as Promise<{ tier?: string } | null>;
  let instData: { tier?: string } | null = null;
  try {
    instData = await fetchInstOnce();
  } catch (e1) {
    const status = e1 instanceof HttpError ? e1.status : 0;
    if (status === 401 || status === 403) { result.status = 'setup_needed'; return result; }
    try {
      await new Promise((r) => setTimeout(r, 1200));
      instData = await fetchInstOnce();
    } catch { return result; }
  }
  if (instData !== null && instData !== undefined) {
    result.status = 'healthy';
    if (instData.tier) { result.tier = instData.tier; }
  }

  // Memory fetch with one transient-retry to avoid showing "Degraded" on a single network blip.
  const fetchMemOnce = () => apiGet(`${baseUrl}/api/v1/instances/${instanceId}/memory`, apiKey) as Promise<MemoryData | null>;
  let memData: MemoryData | null = null;
  let memErr: unknown = null;
  try {
    memData = await fetchMemOnce();
  } catch (e1) {
    memErr = e1;
    // 401/403 → auth/setup problem, no point retrying.
    const status = e1 instanceof HttpError ? e1.status : 0;
    if (status !== 401 && status !== 403) {
      try {
        await new Promise((r) => setTimeout(r, 800));
        memData = await fetchMemOnce();
        memErr = null;
      } catch (e2) { memErr = e2; }
    }
  }
  if (memData) {
    result.lessons = memData.lesson_count ?? 0;
    result.contexts = memData.context_count ?? 0;
    result.topics = memData.topics ?? [];
    result.topLessons = memData.top_lessons ?? [];
    result.memoryUsedBytes = memData.memory_used_bytes ?? 0;
    result.memoryLimitBytes = memData.memory_limit_bytes ?? 0;
    result.memoryUsedPct = memData.memory_used_pct ?? 0;
    result.totalRecalls = memData.total_recall_count
      ?? result.topLessons.reduce((s, l) => s + (l.recall_count ?? 0), 0);
    result.recallLimit = memData.recall_limit ?? -1;
    result.goodwillMessage = memData.goodwill_message || null;
    result.estimatedTokensSaved = result.totalRecalls * TOKENS_PER_RECALL;
    result.estimatedCostSaved = result.estimatedTokensSaved * COST_PER_TOKEN;
    result.iqBoostPct = memData.iq_boost_pct ?? 0;
    result.teamAuthors = memData.team_authors ?? [];
    result.crystal = memData.crystal ?? null;
    if (memData.last_session) {
      result.lastSession = memData.last_session.summary ?? memData.last_session.focus ?? null;
    }
    // Differentiate empty-but-healthy from real degradation so the UI can guide the user.
    if (result.lessons === 0 && result.totalRecalls === 0) {
      result.status = 'empty';
    }
  } else if (memErr) {
    const status = memErr instanceof HttpError ? memErr.status : 0;
    result.status = (status === 401 || status === 403) ? 'setup_needed' : 'degraded';
  }

  // Insights (best-effort — graceful 404/error means endpoint not yet available)
  try {
    const insightsData = await apiGet(`${baseUrl}/api/v1/insights`, apiKey) as BrainInsights | null;
    if (insightsData && typeof insightsData.minutes_saved === 'number') {
      result.insights = insightsData;
    }
  } catch { /* insights endpoint unavailable — ignore */ }

  return result;
}

// ── Brain Doctor — actionable connection diagnostics ──────────────────────────
// Runs a sequence of checks and writes a ✓/✗ report to the output channel, then
// shows a one-line summary with Connect/Show-Logs buttons. This is the single
// place a confused user is sent to when the status bar is red — it tells them
// exactly which link in the chain is broken instead of a generic "OFFLINE".

interface DoctorCheck { label: string; ok: boolean; detail: string; }

async function runBrainDoctor(): Promise<void> {
  const ch = getOutputChannel();
  ch.show(true);
  const checks: DoctorCheck[] = [];
  const config = vscode.workspace.getConfiguration('cachly');
  const baseUrl = apiBaseUrl(config);
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();

  ch.appendLine('');
  ch.appendLine('═══════════════════════════════════════════════');
  ch.appendLine(`  Cachly Brain Doctor — ${new Date().toLocaleString()}`);
  ch.appendLine('═══════════════════════════════════════════════');

  // 1. API key present + well-formed
  if (!apiKey) {
    checks.push({ label: 'API key', ok: false, detail: 'not set (cachly.apiKey is empty) — run "Cachly: Connect Brain"' });
  } else if (!isValidApiKey(apiKey)) {
    checks.push({ label: 'API key', ok: false, detail: 'malformed — expected cky_live_… / cky_trial_… / cky_test_…' });
  } else {
    checks.push({ label: 'API key', ok: true, detail: `present (${apiKey.slice(0, 12)}…)` });
  }

  // 2. Instance id present + well-formed
  if (!instanceId) {
    checks.push({ label: 'Instance id', ok: false, detail: 'not set — run "Cachly: Connect Brain" to provision one' });
  } else if (!isValidInstanceId(instanceId)) {
    checks.push({ label: 'Instance id', ok: false, detail: `not a valid UUID: "${instanceId}"` });
  } else {
    checks.push({ label: 'Instance id', ok: true, detail: instanceId });
  }

  ch.appendLine(`  base URL: ${baseUrl}`);
  ch.appendLine('');

  // 3. Live instance fetch (only if we have both credentials)
  let instanceStatus: BrainStatus = 'unreachable';
  if (apiKey && instanceId) {
    const t0 = Date.now();
    try {
      await apiGet(`${baseUrl}/api/v1/instances/${instanceId}`, apiKey);
      const ms = Date.now() - t0;
      instanceStatus = 'healthy';
      checks.push({ label: 'Instance reachable', ok: true, detail: `HTTP 200 in ${ms}ms` });
    } catch (e) {
      const ms = Date.now() - t0;
      const status = e instanceof HttpError ? e.status : 0;
      instanceStatus = classifyInstanceError(status);
      const why = status === 401 || status === 403 ? 'auth rejected — key may be expired/revoked'
        : status === 404 ? 'instance not found for this key — stale or foreign instance id'
          : status === 0 ? `network error: ${(e as Error).message}`
            : `HTTP ${status}`;
      checks.push({ label: 'Instance reachable', ok: false, detail: `${why} (${ms}ms)` });
    }
  } else {
    checks.push({ label: 'Instance reachable', ok: false, detail: 'skipped — missing credentials' });
  }

  // 4. Live memory fetch
  if (apiKey && instanceId && instanceStatus === 'healthy') {
    const t0 = Date.now();
    try {
      await apiGet(`${baseUrl}/api/v1/instances/${instanceId}/memory`, apiKey);
      checks.push({ label: 'Memory readable', ok: true, detail: `HTTP 200 in ${Date.now() - t0}ms` });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      checks.push({ label: 'Memory readable', ok: false, detail: status ? `HTTP ${status}` : `network error: ${(e as Error).message}` });
    }
  } else {
    checks.push({ label: 'Memory readable', ok: false, detail: 'skipped — instance not reachable' });
  }

  // Report
  for (const c of checks) {
    ch.appendLine(`  ${c.ok ? '✓' : '✗'}  ${c.label}: ${c.detail}`);
  }
  ch.appendLine('═══════════════════════════════════════════════');

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    ch.appendLine('  Result: ✓ Brain is healthy.');
    void vscode.window.showInformationMessage('Cachly Brain Doctor: everything looks healthy ✓');
    return;
  }

  ch.appendLine(`  Result: ✗ ${failed.length} problem(s) found — see above.`);
  const needsSetup = !apiKey || !instanceId || instanceStatus === 'setup_needed' || instanceStatus === 'not_found';
  const buttons = needsSetup ? ['Connect Brain', 'Show Logs'] : ['Show Logs'];
  const choice = await vscode.window.showWarningMessage(
    `Cachly Brain Doctor found ${failed.length} problem(s): ${failed.map((f) => f.label).join(', ')}.`,
    ...buttons,
  );
  if (choice === 'Connect Brain') { void vscode.commands.executeCommand('cachly.setup'); }
  else if (choice === 'Show Logs') { ch.show(true); }
}

// ── Chat participant: @cachly ─────────────────────────────────────────────────
// Brings the Brain into the native Chat view. Subcommands:
//   @cachly /recall <query>  → search lessons        @cachly /status → health
//   @cachly /save <lesson>   → store a lesson         @cachly /doctor → diagnose
// A bare "@cachly <text>" defaults to recall so it's useful with zero ceremony.

function registerChatParticipant(context: vscode.ExtensionContext): void {
  // chat API is only present on VS Code ≥ 1.85; guard so older hosts (or
  // environments without it) don't crash on activate.
  const chatApi = (vscode as unknown as { chat?: typeof vscode.chat }).chat;
  if (!chatApi?.createChatParticipant) {
    log('Chat API unavailable — skipping @cachly participant registration');
    return;
  }

  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, _token) => {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get<string>('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    const baseUrl = apiBaseUrl(config);

    if (!apiKey || !instanceId) {
      stream.markdown('🧠 Your Brain isn\'t connected yet. ');
      stream.button({ command: 'cachly.setup', title: 'Connect Brain' });
      return {};
    }
    if (!isValidApiKey(apiKey)) {
      stream.markdown('⚠️ API key looks malformed (expected `cky_live_…`). Check your settings.');
      return {};
    }

    const command = request.command;
    const prompt = request.prompt.trim();

    if (command === 'doctor') {
      stream.markdown('Running Brain Doctor — see the **Cachly Brain** output channel for the full report.\n\n');
      stream.button({ command: 'cachly.diagnose', title: 'Open Brain Doctor' });
      return {};
    }

    if (command === 'status') {
      const h = await fetchBrainHealth();
      stream.markdown(
        `### 🧠 Brain status: \`${h.status}\`\n\n` +
        `- **Lessons:** ${h.lessons}\n` +
        `- **Contexts:** ${h.contexts}\n` +
        `- **Total recalls:** ${h.totalRecalls}\n` +
        `- **Tier:** ${h.tier}\n` +
        (h.estimatedCostSaved > 0 ? `- **Est. cost saved:** $${h.estimatedCostSaved.toFixed(2)}\n` : '') +
        (h.lastSession ? `- **Last session:** ${h.lastSession}\n` : ''),
      );
      return {};
    }

    if (command === 'save') {
      if (!prompt) {
        stream.markdown('Tell me what to remember, e.g. `@cachly /save Always run go build ./... before pushing`.');
        return {};
      }
      try {
        await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/learn`, apiKey, {
          topic: prompt.slice(0, 60),
          outcome: 'success',
          what_worked: prompt,
          source: 'vscode-chat',
        });
        stream.markdown(`✓ Saved to your Brain: _${prompt}_`);
      } catch (e) {
        stream.markdown(`✗ Couldn't save: ${(e as Error).message}`);
      }
      return {};
    }

    // Default + /recall → semantic recall
    const query = prompt || (vscode.window.activeTextEditor
      ? path.basename(vscode.window.activeTextEditor.document.fileName)
      : '');
    if (!query) {
      stream.markdown('What should I recall? Try `@cachly /recall hydration mismatch` or just `@cachly <topic>`.');
      return {};
    }
    try {
      const limit = 8;
      const res = await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/recall`, apiKey, {
        source: 'vscode-chat',
        query,
        limit,
      }) as { top_lessons?: Array<{ topic: string; what_worked: string; outcome: string }>; lessons?: Array<{ topic: string; what_worked: string; outcome: string }> } | undefined;
      // The /recall endpoint returns `top_lessons` (not `lessons`); keep `lessons`
      // as a fallback in case the API shape changes.
      const allLessons = res?.top_lessons ?? res?.lessons ?? [];
      if (allLessons.length === 0) {
        stream.markdown(`No lessons found for **${query}** yet. Save one with \`@cachly /save …\`.`);
        return {};
      }
      // The endpoint ignores `limit` and returns every lesson; cap client-side.
      const lessons = allLessons.slice(0, limit);
      const more = allLessons.length - lessons.length;

      // Lesson bodies can contain raw markdown (---, #, code, YAML), URL-encoded
      // junk, and newlines. Sanitize to a single-line plain-text preview so the
      // chat output never renders stray headings or horizontal rules.
      const preview = (s: string): string => {
        let t = (s ?? '').replace(/\s+/g, ' ').trim();
        try { t = decodeURIComponent(t); } catch { /* leave as-is if not valid */ }
        t = t.replace(/[`*_#>|]/g, ''); // strip markdown control chars
        return t.length > 140 ? t.slice(0, 140).trimEnd() + '…' : t;
      };

      stream.markdown(`🧠 **${lessons.length}** lesson${lessons.length === 1 ? '' : 's'} for **${query}**\n\n`);
      let injectedText = '';
      for (const l of lessons) {
        const body = preview(l.what_worked);
        const line = `- **${l.topic}** _(${l.outcome})_${body ? ` — ${body}` : ''}\n`;
        injectedText += line;
        stream.markdown(line);
      }
      if (more > 0) {
        stream.markdown(`\n_+${more} more in your Brain._`);
      }
      // Net-token accounting: these lessons were pushed into the AI's context.
      recordAmbientInjection(estimateTokens(injectedText), lessons.length);
    } catch (e) {
      stream.markdown(`✗ Recall failed: ${(e as Error).message}`);
    }
    return {};
  };

  try {
    const participant = chatApi.createChatParticipant('cachly.brain', handler);
    participant.iconPath = new vscode.ThemeIcon('lightbulb');
    context.subscriptions.push(participant);
    log('@cachly chat participant registered');
  } catch (e) {
    log('Failed to register @cachly chat participant', (e as Error).message);
  }
}

// ── Startup briefing: a visible "welcome back" the moment the editor opens ──────
// The single most tangible wow — surfaces what the Brain holds instead of leaving
// the value invisible. Fires once per activation, only when there's something to
// brief (lessons > 0), so it never nags an empty/unconnected Brain. Opt-out via
// cachly.startupBriefing.
async function showStartupBriefing() {
  const config = vscode.workspace.getConfiguration('cachly');
  if (!config.get<boolean>('startupBriefing', true)) return;
  // quietMode silences every unasked-for popup — the briefing is one of them.
  // The same numbers stay visible in the status bar and the Brain Health panel.
  if (config.get<boolean>('quietMode', false)) return;
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  if (!isValidApiKey(apiKey) || !instanceId) return;
  try {
    const h = await fetchBrainHealth();
    if (!h || (h.lessons ?? 0) === 0) return;
    const recallLabel =
      h.recallLimit > 0 ? `${h.totalRecalls}/${h.recallLimit} recalls this month` : `${h.totalRecalls} recalls`;
    void vscode.window
      .showInformationMessage(
        `🧠 Welcome back — your Brain has ${h.lessons} lesson${h.lessons === 1 ? '' : 's'} · ${recallLabel}. It's briefing your AI this session.`,
        'Open Brain',
      )
      .then((c) => {
        if (c === 'Open Brain') void showBrainHealthPanel();
      });
  } catch {
    /* non-critical */
  }
}

// Capture a compact WIP context note for the active file — once per session,
// heavily debounced — so the Brain's Context Entries populate from your work
// without needing an MCP agent. POSTs to the /context endpoint.
async function captureWipContext(doc: vscode.TextDocument) {
  const config = vscode.workspace.getConfiguration('cachly');
  if (!config.get<boolean>('autoContext', true)) return;
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  const baseUrl = apiBaseUrl(config);
  if (!isValidApiKey(apiKey) || !instanceId) return;
  const fileName = doc.uri.path.split('/').pop() ?? doc.uri.path;
  if (!fileName || capturedContextFiles.has(fileName)) return;
  const firstLine = (doc.lineCount > 0 ? doc.lineAt(0).text : '').trim().slice(0, 80);
  const content = `EDITING ${fileName}${firstLine ? ` — ${firstLine}` : ''} (${doc.languageId})`;
  try {
    await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/context`, apiKey, {
      key: fileName,
      content,
      ttl: 86400,
    });
    capturedContextFiles.add(fileName);
  } catch {
    /* non-critical */
  }
}

// ── Save Lesson command ───────────────────────────────────────────────────────
// Modes (cachly.lessonSaveMode):
//   auto    – save immediately, no prompts (uses prefill data or empty defaults)
//   confirm – one notification: [Save] [Edit] [Skip]   ← default
//   manual  – full 3-step form (topic → description → outcome)

async function saveLessonCommand(prefillTopic?: string, prefillWhatWorked?: string) {
  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  const baseUrl = apiBaseUrl(config);
  const saveMode = config.get<string>('lessonSaveMode', 'confirm');

  // ── Helper: persist a lesson (online first, offline fallback) ─────────────
  const persistLesson = async (topic: string, whatWorked: string, outcome: string) => {
    const source = prefillTopic ? 'vscode-ambient' : 'vscode-manual';
    const authorName = config.get<string>('authorName', '');
    if (apiKey && instanceId) {
      try {
        await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/learn`, apiKey, {
          topic, outcome, what_worked: whatWorked, source,
          ...(authorName ? { author: authorName } : {}),
        });
        trackVSCodeEvent('vscode_lesson_saved', { apiKey, instanceId, once: true });
        vscode.window.showInformationMessage(`🧠 Lesson saved: "${topic}"`);
        updateStatusBar();
        return;
      } catch {
        // API unreachable — fall through to offline queue
      }
    }
    // Offline fallback (no Brain connected, or API temporarily down)
    enqueueOfflineLesson({ topic, outcome, what_worked: whatWorked, source, savedAt: Date.now() });
    const queue = extensionContext.globalState.get<OfflineLesson[]>(OFFLINE_QUEUE_KEY, []);
    if (!apiKey || !instanceId) {
      void vscode.window.showWarningMessage(
        `🧠 Lesson queued offline (${queue.length} total). Connect a Brain to sync it.`,
        'Connect Brain',
      ).then(c => { if (c === 'Connect Brain') void setupAICommand(); });
    } else {
      vscode.window.showInformationMessage(`🧠 Lesson queued offline (${queue.length} total). Will retry automatically.`);
    }
  };

  // ── Helper: collect all fields via full form ──────────────────────────────
  const collectManual = async (): Promise<{ topic: string; whatWorked: string; outcome: string } | undefined> => {
    const topic = await vscode.window.showInputBox({
      prompt: 'Lesson topic (e.g. deploy:k8s-timeout)',
      value: prefillTopic ?? '',
      placeHolder: 'category:keyword',
    });
    if (!topic) return undefined;
    const whatWorked = await vscode.window.showInputBox({
      prompt: 'What worked? (short description)',
      value: prefillWhatWorked ?? '',
      placeHolder: 'e.g. Increase readinessProbe.failureThreshold to 10',
    });
    if (!whatWorked) return undefined;
    const outcome = await vscode.window.showQuickPick(
      ['success', 'failure', 'partial'],
      { placeHolder: 'Outcome (default: success)' },
    );
    if (!outcome) return undefined;
    return { topic, whatWorked, outcome };
  };

  // ── auto: save immediately, no interaction ────────────────────────────────
  if (saveMode === 'auto') {
    const topic = prefillTopic ?? 'lesson:general';
    const whatWorked = prefillWhatWorked ?? 'Recorded by Cachly ambient learning';
    await persistLesson(topic, whatWorked, 'success');
    return;
  }

  // ── confirm: single notification, one click ───────────────────────────────
  if (saveMode === 'confirm') {
    const topic = prefillTopic ?? 'lesson:general';
    const preview = prefillWhatWorked
      ? prefillWhatWorked.slice(0, 60) + (prefillWhatWorked.length > 60 ? '…' : '')
      : '(no description)';
    const action = await vscode.window.showInformationMessage(
      `🧠 Save Brain lesson "${topic}"? — ${preview}`,
      'Save',
      'Edit',
      'Skip',
    );
    if (!action || action === 'Skip') return;
    if (action === 'Edit') {
      const fields = await collectManual();
      if (!fields) return;
      await persistLesson(fields.topic, fields.whatWorked, fields.outcome);
      return;
    }
    // Save
    await persistLesson(topic, prefillWhatWorked ?? preview, 'success');
    return;
  }

  // ── manual: full form ─────────────────────────────────────────────────────
  const fields = await collectManual();
  if (!fields) return;
  await persistLesson(fields.topic, fields.whatWorked, fields.outcome);
}

// ── CLS: Compiler Learning Stream ────────────────────────────────────────────

/** The CLS explainer is worth showing once — after that it is just noise. */
const CLS_EXPLAINED_KEY = 'cachly.clsExplained';

/** Make the invisible auto-learning visible AND reviewable. */
async function notifyClsLearned(topic: string, whatWorked: string, lessonContext: string): Promise<void> {
  // Explain auto-learning once per install, then stay in the status bar
  // forever. Repeating it every session taught the user nothing new and just
  // added to the notification pile.
  const explained = extensionContext?.globalState.get<boolean>(CLS_EXPLAINED_KEY, false) ?? false;
  if (explained || !claimInterrupt()) {
    vscode.window.setStatusBarMessage(`$(brain) cachly learned: ${topic}`, 6000);
    return;
  }
  await extensionContext?.globalState.update(CLS_EXPLAINED_KEY, true);
  const action = await vscode.window.showInformationMessage(
    `🧠 cachly auto-learned "${topic}" — a compiler error disappeared after your edit. This happens quietly from now on.`,
    'Show lesson',
    'Disable auto-learn',
  );
  if (action === 'Show lesson') {
    const panel = vscode.window.createWebviewPanel(
      'cachlyClsLesson',
      `🧠 Auto-learned: ${topic}`,
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );
    panel.webview.html = buildRecallHtml(topic, [
      { topic, what_worked: whatWorked, outcome: 'success', what_failed: lessonContext },
    ]);
  } else if (action === 'Disable auto-learn') {
    await vscode.workspace.getConfiguration('cachly').update('clsLearning', false, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      '🧠 cachly: Compiler Learning Stream disabled (cachly.clsLearning). Re-enable it anytime in Settings.',
    );
  }
}

async function handleClsDiagnosticsChange(e: vscode.DiagnosticChangeEvent) {
  const config = vscode.workspace.getConfiguration('cachly');
  // Re-check on every event so "Disable auto-learn" takes effect immediately —
  // the listener registration only reads the setting once at activation.
  if (!config.get<boolean>('clsLearning', true)) return;
  const apiKey = config.get<string>('apiKey', '');
  const baseUrl = apiBaseUrl(config);
  const instanceId = await getEffectiveInstanceId();
  if (!isValidApiKey(apiKey) || !instanceId) return;

  const MAX_TRACK = 50; // cap to avoid memory growth

  for (const uri of e.uris) {
    const uriStr = uri.toString();
    const docs = vscode.workspace.textDocuments;
    const doc = docs.find(d => d.uri.toString() === uriStr);
    const langId = doc?.languageId ?? uri.path.split('.').pop() ?? 'unknown';

    const currentDiags = vscode.languages.getDiagnostics(uri)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

    const currentKeys = new Set(
      currentDiags.map(d => {
        const c = d.code;
        const codeStr = c === undefined ? '' : typeof c === 'object' ? String(c.value) : String(c);
        return `${uriStr}::${codeStr}::${d.message.slice(0, 40)}`;
      }),
    );

    // Add newly appeared errors to tracking map
    for (const diag of currentDiags) {
      if (clsActiveErrors.size >= MAX_TRACK) break;
      const c = diag.code;
      const codeStr = c === undefined ? '' : typeof c === 'object' ? String(c.value) : String(c);
      const key = `${uriStr}::${codeStr}::${diag.message.slice(0, 40)}`;
      if (!clsActiveErrors.has(key)) {
        clsActiveErrors.set(key, {
          message: diag.message,
          source: diag.source ?? '',
          code: codeStr,
          languageId: langId,
          uri: uriStr,
          appearedAt: Date.now(),
        });
      }
    }

    // Find errors that just disappeared for this URI
    const disappeared: ClsTrackedDiag[] = [];
    for (const [key, tracked] of clsActiveErrors) {
      if (tracked.uri === uriStr && !currentKeys.has(key)) {
        disappeared.push(tracked);
        clsActiveErrors.delete(key);
      }
    }

    // Only auto-learn if: the file was recently edited (within 60s) AND error lived ≥ 2s
    const editedThisFile = clsLastEditedUri === uriStr && (Date.now() - clsLastEditTime) < 60_000;
    if (!editedThisFile || disappeared.length === 0) continue;

    for (const diag of disappeared) {
      // Only save if the error was alive for at least 2 seconds (not a transient parse flicker)
      if (Date.now() - diag.appearedAt < 2000) continue;

      const codeStr = diag.code;
      const topic = `fix:${diag.languageId}${codeStr ? `-${codeStr}` : ''}`;
      const fileName = uriStr.split('/').pop() ?? uriStr;
      const whatWorked = `Fixed "${diag.message.slice(0, 100)}" in ${fileName} after edit`;
      const lessonContext = codeStr
        ? `${diag.source ?? diag.languageId} error ${codeStr}: ${diag.message.slice(0, 200)}`
        : diag.message.slice(0, 200);

      try {
        const clsAuthorName = vscode.workspace.getConfiguration('cachly').get<string>('authorName', '');
        await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/learn`, apiKey, {
          topic,
          outcome: 'success',
          what_worked: whatWorked,
          context: lessonContext,
          severity: 'minor',
          tags: ['cls', 'compiler', diag.languageId, diag.source ?? ''].filter(Boolean),
          source: 'vscode-cls',
          ...(clsAuthorName ? { author: clsAuthorName } : {}),
        });
        trackVSCodeEvent('vscode_cls_lesson_saved', { apiKey, instanceId, once: true });
        void notifyClsLearned(topic, whatWorked, lessonContext);
      } catch {
        // Network or auth failure — queue locally for later sync
        enqueueOfflineLesson({
          topic, outcome: 'success', what_worked: whatWorked,
          context: lessonContext,
          severity: 'minor', tags: ['cls', 'compiler', diag.languageId],
          source: 'vscode-cls', savedAt: Date.now(),
        });
      }
    }
  }
}

// ── Ambient Learning ──────────────────────────────────────────────────────────

function handleAmbientEdit(e: vscode.TextDocumentChangeEvent) {
  for (const change of e.contentChanges) {
    const added = change.text.trim();
    if (added.length < 15 || /^[\s{}()[\];,]+$/.test(added)) continue;

    const uri = e.document.uri.toString();
    const entry = ambientMap.get(uri) ?? { sampleEdit: '', count: 0, prompted: false };

    if (entry.prompted) continue;

    if (entry.sampleEdit && diceSimilarity(added, entry.sampleEdit) > 0.6) {
      entry.count++;
      if (entry.count >= 3) {
        entry.prompted = true;
        ambientMap.set(uri, entry);
        promptAmbientLesson(e.document, entry.sampleEdit);
        return;
      }
    } else if (added.length > entry.sampleEdit.length) {
      entry.sampleEdit = added;
      entry.count = 1;
    }
    ambientMap.set(uri, entry);
  }
}

async function promptAmbientLesson(doc: vscode.TextDocument, sample: string) {
  const fileName = doc.fileName.split('/').pop() ?? doc.fileName;
  const suggestedTopic = inferTopic(doc.fileName, sample);

  // Gated per file, this asked once per file — i.e. all day long. Saving a
  // lesson is never urgent, so an unaffordable prompt is simply dropped rather
  // than queued: the next repeated pattern will ask again when there is budget.
  if (!claimInterrupt()) return;

  const action = await vscode.window.showInformationMessage(
    `🧠 You've typed a similar pattern 3× in ${fileName}. Save as a Brain lesson?`,
    'Save Lesson',
    'Not now',
    'Stop asking',
  );
  if (action === 'Save Lesson') {
    saveLessonCommand(suggestedTopic, sample);
  } else if (action === 'Stop asking') {
    await vscode.workspace.getConfiguration('cachly')
      .update('ambientLearning', false, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage('$(brain) cachly: ambient learning off (cachly.ambientLearning)', 5000);
  }
}

function inferTopic(filePath: string, _sample: string): string {
  const lower = filePath.toLowerCase();
  if (lower.includes('deploy') || lower.includes('docker') || lower.includes('k8s')) return 'deploy:';
  if (lower.includes('auth') || lower.includes('login')) return 'auth:';
  if (lower.includes('api') || lower.includes('route') || lower.includes('handler')) return 'api:';
  if (lower.includes('test') || lower.includes('spec')) return 'test:';
  if (lower.includes('db') || lower.includes('schema') || lower.includes('migrat')) return 'db:';
  return 'code:';
}

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;
  const aBigrams = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) aBigrams.add(a.slice(i, i + 2));
  let match = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (aBigrams.has(b.slice(i, i + 2))) match++;
  }
  return (2 * match) / (a.length - 1 + b.length - 1);
}

// ── Git-root detection ────────────────────────────────────────────────────────

async function findGitRoot(filePath: string): Promise<string | undefined> {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, '.git')));
      return dir;
    } catch { /* not found, go up */ }
    dir = path.dirname(dir);
  }
  return undefined;
}

async function getEffectiveInstanceId(): Promise<string> {
  const config = vscode.workspace.getConfiguration('cachly');
  const globalId = config.get<string>('instanceId', '');

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (!activeUri) return globalId;

  // Multi-root workspace: VS Code scopes settings per folder automatically
  const wsFolder = vscode.workspace.getWorkspaceFolder(activeUri);
  if (wsFolder) {
    const folderConfig = vscode.workspace.getConfiguration('cachly', wsFolder.uri);
    const folderId = folderConfig.get<string>('instanceId', '');
    if (folderId && folderId !== globalId) return folderId;
  }

  // Git-root mapping. The on-disk .vscode/settings.json is the source of truth;
  // the globalState cache is only a fallback for when the file can't be read.
  // (Previously the cache was checked FIRST and never invalidated, so editing
  //  settings.json — e.g. fixing a stale/foreign instance id — had no effect and
  //  the status bar stayed OFFLINE forever. Read-through fixes that.)
  const gitRoot = await findGitRoot(activeUri.fsPath);
  if (gitRoot) {
    // Try reading .vscode/settings.json inside that git root directly (authoritative).
    // NOTE: settings.json is JSONC — use parseJsonc, NOT JSON.parse (which throws
    // on comments/trailing commas and would silently fall back to a stale cache).
    try {
      const raw = await vscode.workspace.fs.readFile(
        vscode.Uri.file(path.join(gitRoot, '.vscode', 'settings.json')),
      );
      const parsed = parseJsonc(Buffer.from(raw).toString('utf8'));
      const id = parsed['cachly.instanceId'];
      if (typeof id === 'string' && id) {
        const m = extensionContext.globalState.get<Record<string, string>>('gitRootInstanceMap', {});
        if (m[gitRoot] !== id) {
          m[gitRoot] = id;
          void extensionContext.globalState.update('gitRootInstanceMap', m);
          log(`instanceId resolved from git-root settings.json: ${id} (was cached: ${m[gitRoot] ?? 'none'})`);
        }
        return id;
      }
    } catch (e) {
      log('could not read/parse git-root .vscode/settings.json', (e as Error).message);
    }

    // Fallback: use the cached mapping only when the file is unreadable/missing.
    // But NEVER let a cached id override a valid global setting that differs —
    // that's how a stale/foreign id used to stick (→ 404 / OFFLINE).
    const mapping = extensionContext.globalState.get<Record<string, string>>('gitRootInstanceMap', {});
    const cached = mapping[gitRoot];
    if (cached) {
      if (globalId && isValidInstanceId(globalId) && cached !== globalId) {
        // Global is authoritative and differs from the stale cache → drop the cache entry.
        delete mapping[gitRoot];
        void extensionContext.globalState.update('gitRootInstanceMap', mapping);
        log(`dropped stale cached instanceId ${cached} for ${gitRoot}; using global ${globalId}`);
        return globalId;
      }
      return cached;
    }
  }

  return globalId;
}

// ── Silent Auto-Setup — runs on every activation when credentials are missing ─

/**
 * Silently provision an API key + Brain instance without any user interaction.
 *
 * Strategy:
 *  1. GitHub silent OAuth exchange (zero-click — reuses existing VS Code GitHub session)
 *  2. Instant-trial fallback (also zero-click — no account needed)
 *  3. Write credentials + auto-provision instance via /api/v1/instances/auto
 *  4. Show a single success toast
 *
 * Returns true if credentials were successfully provisioned, false if both methods
 * failed (e.g. fully offline). The caller shows the manual wizard in that case.
 */
async function silentAutoSetup(context: vscode.ExtensionContext): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('cachly');
  const BASE_URL = apiBaseUrl(config);

  // Re-check inside the timeout — another activation path may have filled them already.
  // Use isValidApiKey so a malformed/partial key from a race doesn't count as "done".
  const existingKey = config.get<string>('apiKey', '');
  if (isValidApiKey(existingKey) && config.get<string>('instanceId', '')) return true;

  let apiKey = '';
  let instanceId = '';
  let githubLogin = '';
  let isTrial = false;

  // ── 1. GitHub silent exchange (zero-click) ───────────────────────────────
  const ghResult = await tryGitHubSilentAuth(BASE_URL);
  if (ghResult) {
    apiKey = ghResult.apiKey;
    instanceId = ghResult.instanceId ?? '';
    githubLogin = ghResult.githubLogin;
  }

  // ── 2. Instant-trial fallback (also zero-click) ──────────────────────────
  if (!apiKey) {
    try {
      type TrialResp = { api_key: string; expires_at: string; instance_id: string; trial: boolean };
      const trialResp = await apiPostAnon(`${BASE_URL}/auth/instant-trial`, {}) as TrialResp | null;
      if (trialResp?.api_key) {
        apiKey = trialResp.api_key;
        instanceId = trialResp.instance_id ?? '';
        isTrial = true;
        await config.update('trialExpiresAt', trialResp.expires_at, vscode.ConfigurationTarget.Global);
      }
    } catch { /* offline — caller will show onboarding wizard */ }
  }

  if (!apiKey) return false; // Both methods failed

  // ── 3. Write API key ─────────────────────────────────────────────────────
  await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

  // ── 4. Auto-provision Brain instance (if not returned by auth step) ──────
  if (!instanceId) {
    try {
      type AutoResp = { instance_id?: string; instance?: { id: string } };
      const autoData = await apiPost(`${BASE_URL}/api/v1/instances/auto`, apiKey, {}) as AutoResp | null;
      instanceId = autoData?.instance?.id ?? autoData?.instance_id ?? '';
    } catch { /* non-fatal — instance will be provisioned on next call */ }
  }

  if (instanceId) {
    await config.update('instanceId', instanceId, vscode.ConfigurationTarget.Global);
  }

  // ── 5. Write workspace files (.mcp.json, copilot-instructions.md, settings) ──
  if (instanceId) {
    try { await writeWorkspaceFiles(BASE_URL, apiKey, instanceId); } catch { /* non-fatal */ }
  }

  // ── 6. Track + notify ─────────────────────────────────────────────────────
  if (githubLogin) {
    trackVSCodeEvent('vscode_github_linked', { apiKey, instanceId, once: true });
    void vscode.window.showInformationMessage(
      `🧠 Brain connected via GitHub @${githubLogin} — permanent memory active! Restart your AI tool to begin.`,
      'Show Brain', 'Dismiss',
    ).then(a => { if (a === 'Show Brain') showBrainHealthPanel(); });
  } else if (isTrial) {
    trackVSCodeEvent('vscode_trial_started', { apiKey, instanceId, once: true });
    void vscode.window.showInformationMessage(
      '🧠 14-day free Brain trial started! Restart your AI tool (Copilot, Claude, Cursor…) to activate memory.',
      'Link Account', 'Later',
    ).then(async (choice) => {
      if (choice === 'Link Account') await linkAccountCommand();
    });
  }

  // Mark onboarding done so the fallback wizard doesn't appear redundantly
  void context.globalState.update('onboardingShown', true);

  // Restart refresh loop, flush offline lessons + framework detection
  startRefreshLoop();
  void flushOfflineQueue();
  detectAndSuggestFrameworks(context);

  return true;
}

// ── Setup AI command — zero-friction Device Code Flow ────────────────────────

/**
 * Attempt a truly zero-click setup via VS Code's built-in GitHub authentication.
 *
 * Returns the linked Cachly api_key + instance_id if successful, or null if the
 * user isn't signed into GitHub, declined the prompt, or our backend rejected
 * the token. In all "null" cases the caller falls through to instant-trial /
 * device flow so onboarding is never blocked.
 *
 * `silent: true` means VS Code reuses an existing GitHub session WITHOUT a
 * permission dialog if one exists — most developers using Copilot or Pull
 * Request reviews already have this. Only the `read:user` scope is requested
 * (the minimum needed to call `GET /user`); we do not touch any repo data.
 */
async function tryGitHubSilentAuth(
  baseUrl: string,
): Promise<{ apiKey: string; instanceId?: string; githubLogin: string } | null> {
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['read:user'],
      { silent: true },
    );
    if (!session?.accessToken) return null;

    type GhExchangeResp = {
      api_key?: string;
      instance_id?: string;
      github_login?: string;
      trial?: boolean;
      error?: string;
    };
    const resp = (await apiPostAnon(`${baseUrl}/auth/github-vscode`, {
      github_token: session.accessToken,
    })) as GhExchangeResp | null;

    if (!resp?.api_key) return null;
    return {
      apiKey: resp.api_key,
      instanceId: resp.instance_id,
      githubLogin: resp.github_login ?? session.account?.label ?? 'user',
    };
  } catch {
    // No GitHub session available, network glitch, etc. — caller falls back.
    return null;
  }
}

async function setupAICommand() {
  const config = vscode.workspace.getConfiguration('cachly');
  const BASE_URL = apiBaseUrl(config);

  trackVSCodeEvent('vscode_setup_started', { once: true });

  // If already wired up, confirm before re-configuring
  const existingKey = config.get<string>('apiKey', '');
  const existingInstance = await getEffectiveInstanceId();
  if (existingKey && existingInstance) {
    const action = await vscode.window.showInformationMessage(
      '🧠 Cachly Brain is already connected to this workspace. Reconnect with a different account?',
      'Reconnect', 'Cancel',
    );
    if (action !== 'Reconnect') return;
  }

  let token = '';

  // ── Step 0a: GitHub silent auth (TRULY zero-click) ────────────────────────
  // If the user is already signed into GitHub in VS Code (true for ~95% of devs),
  // we obtain an OAuth token silently — no browser popup, no permission dialog —
  // and exchange it for a *real* (non-trial) cachly key + Brain instance.
  // This gives them a permanent account from minute 1, no "Link Account" needed.
  let apiKey = config.get<string>('apiKey', '');
  if (!apiKey) {
    const ghKey = await tryGitHubSilentAuth(BASE_URL);
    if (ghKey) {
      apiKey = ghKey.apiKey;
      await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
      if (ghKey.instanceId) {
        await config.update('instanceId', ghKey.instanceId, vscode.ConfigurationTarget.Global);
      }
      trackVSCodeEvent('vscode_github_linked', { apiKey, instanceId: ghKey.instanceId ?? '', once: true });

      void vscode.window.showInformationMessage(
        `🧠 Cachly Brain connected via GitHub @${ghKey.githubLogin}. Your AI now has permanent memory — no expiry, no upgrade needed.`,
      );

      token = apiKey;
      await finishSetup(token, BASE_URL);
      return;
    }
  }

  // ── Step 0b: Instant Trial (zero-friction fallback, no account needed) ────
  // Try to get a 14-day trial key immediately, no sign-up required.
  // If the user already has a key (trial or real), skip this step.
  type TrialResp = { api_key: string; expires_at: string; instance_id: string; trial: boolean };
  if (!apiKey) {
    let trialResp: TrialResp | null = null;
    try {
      trialResp = await apiPostAnon(`${BASE_URL}/auth/instant-trial`, {}) as TrialResp | null;
    } catch { /* fallback to device flow */ }

    if (trialResp?.api_key) {
      apiKey = trialResp.api_key;
      await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
      // Store trial expiry so the status bar can show a countdown
      await config.update('trialExpiresAt', trialResp.expires_at, vscode.ConfigurationTarget.Global);

      // If the API already provisioned an instance, store it directly
      if (trialResp.instance_id) {
        await config.update('instanceId', trialResp.instance_id, vscode.ConfigurationTarget.Global);
      }

      trackVSCodeEvent('vscode_trial_started', { apiKey, instanceId: trialResp.instance_id ?? '', once: true });

      // Show "Link Account" banner — clicking upgrades the trial to a real account
      void vscode.window.showInformationMessage(
        '🧠 Cachly Brain: 14-day free trial started! Link your account to keep data permanently.',
        'Link Account',
        'Later',
      ).then(async (choice) => {
        if (choice === 'Link Account') {
          await linkAccountCommand();
        }
      });

      token = apiKey;
      await finishSetup(token, BASE_URL);
      return;
    }
  }

  // ── Step 1: Device Authorization Flow (RFC 8628) — for returning users ────
  // Reaches here if: instant trial failed OR user already has a key and clicked Reconnect.
  if (!apiKey) {
    // 1a. Request a device code from the API.
    type DeviceResp = { device_code: string; user_code: string; verification_uri: string };
    let deviceResp: DeviceResp | null = null;
    try {
      deviceResp = await apiPostAnon(`${BASE_URL}/auth/device`, {}) as DeviceResp | null;
    } catch {
      // Fallback: let user paste key manually if device flow endpoint is unreachable.
    }

    if (deviceResp?.device_code) {
      // 1b. Open browser to approval page with the code pre-filled.
      const approvalUrl = `${deviceResp.verification_uri}?code=${deviceResp.user_code}`;
      void vscode.env.openExternal(vscode.Uri.parse(approvalUrl));

      // 1c. Poll in background while showing progress notification.
      const obtained = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `🧠 Cachly Brain Setup — enter code  ${deviceResp.user_code}  at cachly.dev/device`,
          cancellable: true,
        },
        async (_progress, cancelToken) => {
          const { device_code } = deviceResp!;
          for (let i = 0; i < 120; i++) {
            if (cancelToken.isCancellationRequested) return null;
            await new Promise<void>((r) => setTimeout(r, 5000));
            try {
              const poll = await apiPostAnon(`${BASE_URL}/auth/device/token`, { device_code }) as
                { access_token?: string; error?: string } | null;
              if (poll?.access_token) return poll.access_token;
              if (poll?.error === 'expired_token' || poll?.error === 'access_denied') return null;
              // 'authorization_pending' → keep polling
            } catch { /* network glitch – keep polling */ }
          }
          return null; // timed out after 10 min
        },
      );

      if (!obtained) {
        vscode.window.showWarningMessage('Cachly: setup cancelled or timed out.');
        return;
      }
      apiKey = obtained;
      await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
    } else {
      // Device flow unavailable — retry instant-trial once more (covers transient API restart),
      // then open dashboard as last resort. No paste-box: users should never need to copy keys.
      await new Promise<void>((r) => setTimeout(r, 2000));
      let retryResp: TrialResp | null = null;
      try {
        retryResp = await apiPostAnon(`${BASE_URL}/auth/instant-trial`, {}) as TrialResp | null;
      } catch { /* ignore */ }

      if (retryResp?.api_key) {
        apiKey = retryResp.api_key;
        await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        if (retryResp.expires_at) await config.update('trialExpiresAt', retryResp.expires_at, vscode.ConfigurationTarget.Global);
        if (retryResp.instance_id) await config.update('instanceId', retryResp.instance_id, vscode.ConfigurationTarget.Global);
        token = apiKey;
        await finishSetup(token, BASE_URL);
        return;
      }

      // Both instant-trial and device flow unavailable → open dashboard.
      void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/dashboard'));
      void vscode.window.showWarningMessage(
        '🧠 Cachly Brain: Auto-setup temporarily unavailable. Copy your API key from the dashboard and paste it in Settings → cachly.apiKey.',
        'Open Dashboard',
      ).then((a) => { if (a === 'Open Dashboard') void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/dashboard')); });
      return;
    }
  }
  token = apiKey;

  await finishSetup(token, BASE_URL);
}

// ── Link Account command — upgrades a trial to a real account via Device Flow ─
async function linkAccountCommand() {
  const config = vscode.workspace.getConfiguration('cachly');
  const BASE_URL = apiBaseUrl(config);

  type DeviceResp = { device_code: string; user_code: string; verification_uri: string };
  let deviceResp: DeviceResp | null = null;
  try {
    deviceResp = await apiPostAnon(`${BASE_URL}/auth/device`, {}) as DeviceResp | null;
  } catch { /* show manual fallback */ }

  if (!deviceResp?.device_code) {
    void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/dashboard'));
    return;
  }

  const approvalUrl = `${deviceResp.verification_uri}?code=${deviceResp.user_code}`;
  void vscode.env.openExternal(vscode.Uri.parse(approvalUrl));

  const obtained = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `🧠 Cachly: enter code  ${deviceResp.user_code}  at cachly.dev/device to link your account`,
      cancellable: true,
    },
    async (_progress, cancelToken) => {
      const { device_code } = deviceResp!;
      for (let i = 0; i < 120; i++) {
        if (cancelToken.isCancellationRequested) return null;
        await new Promise<void>((r) => setTimeout(r, 5000));
        try {
          const poll = await apiPostAnon(`${BASE_URL}/auth/device/token`, { device_code }) as
            { access_token?: string; error?: string } | null;
          if (poll?.access_token) return poll.access_token;
          if (poll?.error === 'expired_token' || poll?.error === 'access_denied') return null;
        } catch { /* keep polling */ }
      }
      return null;
    },
  );

  if (!obtained) {
    vscode.window.showWarningMessage('Cachly: account linking cancelled or timed out.');
    return;
  }

  // Replace trial key with real account key
  await config.update('apiKey', obtained, vscode.ConfigurationTarget.Global);
  await config.update('trialExpiresAt', undefined, vscode.ConfigurationTarget.Global);
  trackVSCodeEvent('vscode_account_linked', { apiKey: obtained, once: true });
  vscode.window.showInformationMessage('🧠 Cachly Brain: account linked! Your data is now permanent.');
}

// Clears all stored auth state (apiKey + instanceId) so the next setup starts fresh.
// Surfaced as command 'cachly.resetAuth' AND auto-invoked when the API rejects our token.
async function resetAuthCommand() {
  const config = vscode.workspace.getConfiguration('cachly');
  await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
  await config.update('instanceId', undefined, vscode.ConfigurationTarget.Global);
  await config.update('trialExpiresAt', undefined, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    '🧠 cachly: signed out. Run "Cachly: Connect Brain" to reconnect.',
    'Connect now',
  ).then(a => { if (a === 'Connect now') void vscode.commands.executeCommand('cachly.setup'); });
}

async function showAuthErrorAndOfferReset(reason: string) {
  const choice = await vscode.window.showWarningMessage(
    `🧠 cachly: ${reason} Sign out and reconnect to fix it.`,
    'Sign out & reconnect',
    'Sign out',
    'Cancel',
  );
  if (choice === 'Sign out & reconnect') {
    await resetAuthCommand();
    void vscode.commands.executeCommand('cachly.setup');
  } else if (choice === 'Sign out') {
    await resetAuthCommand();
  }
}

async function finishSetup(token: string, baseUrl: string) {
  const config = vscode.workspace.getConfiguration('cachly');

  // Exchange short-lived Keycloak JWT → long-lived cky_live_ API key
  if (token.startsWith('eyJ')) {
    try {
      const keyRes = await apiPost(`${baseUrl}/api/v1/api-keys`, token, {
        name: 'cachly-vscode', scope: 'read_write',
      }) as { key?: string } | null;
      if (keyRes?.key) token = keyRes.key;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        await showAuthErrorAndOfferReset('Sign-in expired while exchanging your token.');
        return;
      }
      /* transient — fall back to JWT directly */
    }
  }
  await config.update('apiKey', token, vscode.ConfigurationTarget.Global);

  // Auto-provision a free Brain instance (idempotent — returns existing or creates one).
  // The response gives us the instance_id immediately — no need to search the list.
  type AutoResp = {
    instance_id?: string;
    status?: string;
    created?: boolean;
    instance?: { id: string; status: string; name: string };
  };
  let instanceId = config.get<string>('instanceId', '');
  let alreadyRunning = false;
  try {
    const autoData = await apiPost(`${baseUrl}/api/v1/instances/auto`, token, {}) as AutoResp | null;
    if (autoData?.instance?.id) {
      // Existing instance — use its id directly
      instanceId = autoData.instance.id;
      alreadyRunning = autoData.instance.status === 'running';
    } else if (autoData?.instance_id) {
      // Newly provisioned — id returned from creation
      instanceId = autoData.instance_id;
    }
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      await showAuthErrorAndOfferReset('Your stored API key was rejected by the server.');
      return;
    }
    /* non-fatal — will fall back to polling */
  }

  // If the existing instance is already running we can skip the poll entirely.
  let instanceStillProvisioning = false;
  let authFailed = false;
  if (!alreadyRunning) {
    // Poll up to 3 minutes (60 × 3s) for the instance to become running.
    // Free-tier cold-start on Hetzner can take 1-2 minutes.
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: '🧠 cachly: starting Brain instance…',
      cancellable: true,
    }, async (progress, cancelToken) => {
      const maxAttempts = 60;
      for (let i = 0; i < maxAttempts; i++) {
        if (cancelToken.isCancellationRequested) {
          // User dismissed — configs will be written with the current instanceId;
          // MCP will connect automatically once the Brain finishes starting.
          instanceStillProvisioning = !!instanceId;
          void vscode.window.showInformationMessage(
            '🧠 cachly: Setup cancelled. Your Brain is still starting — MCP will connect automatically once it\'s ready.',
          );
          return;
        }
        await new Promise(r => setTimeout(r, 3000));
        const elapsed = Math.round((i + 1) * 3);
        const remaining = Math.max(0, maxAttempts * 3 - elapsed);
        progress.report({ message: `${elapsed}s elapsed — free tier takes up to 3 min on cold start (${remaining}s remaining)` });
        try {
          if (instanceId) {
            // Fast path: poll the single-instance endpoint directly
            const inst = await apiGet(`${baseUrl}/api/v1/instances/${instanceId}`, token) as
              { id?: string; status?: string } | null;
            if (inst?.status === 'running') { instanceStillProvisioning = false; return; }
          } else {
            // Fallback: scan the list for any active instance
            const data = await apiGet(`${baseUrl}/api/v1/instances`, token) as
              { data?: { id: string; status: string }[] } | null;
            const instances = data?.data ?? [];
            const running = instances.find(inst => inst.status === 'running');
            if (running) { instanceId = running.id; instanceStillProvisioning = false; return; }
            // Capture provisioning instance ID even if not yet running —
            // we still write the configs so the MCP server can connect once ready.
            if (!instanceId) {
              const provisioning = instances.find(inst =>
                inst.status === 'provisioning' || inst.status === 'starting' || inst.status === 'pending_payment'
              );
              if (provisioning) { instanceId = provisioning.id; }
            }
          }
        } catch (e) {
          // Auth failure: don't waste 3 minutes — bail immediately so the user can re-auth.
          if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
            authFailed = true;
            return;
          }
          /* transient error — retry next tick */
        }
      }
      // Timed out — if we have an ID, continue with configs (instance will be ready soon).
      instanceStillProvisioning = !!instanceId;
    });
  }

  if (authFailed) {
    await showAuthErrorAndOfferReset('Your stored API key was rejected by the server.');
    return;
  }

  if (!instanceId) {
    void vscode.window.showWarningMessage(
      '🧠 cachly: Could not reach your Brain. Check your connection and run "Cachly: Connect Brain" again.',
      'Retry',
    ).then(a => { if (a === 'Retry') void vscode.commands.executeCommand('cachly.setup'); });
    return;
  }

  if (instanceStillProvisioning) {
    // Write configs now so the MCP server is ready to connect as soon as the Brain starts.
    // Show a non-blocking toast — user can continue coding.
    void vscode.window.showInformationMessage(
      '🧠 cachly: Your Brain is still starting up (free tier cold-start ~2 min). MCP will connect automatically — keep coding!',
    );
  }

  // Write workspace configs (.mcp.json, copilot-instructions.md, .vscode/settings.json)
  try { await writeWorkspaceFiles(baseUrl, token, instanceId); } catch { /* non-fatal */ }

  await config.update('instanceId', instanceId, vscode.ConfigurationTarget.Workspace);

  trackVSCodeEvent('vscode_setup_completed', { instanceId, once: true });

  if (!instanceStillProvisioning) {
    const action = await vscode.window.showInformationMessage(
      `🧠 Brain connected! Your AI now has persistent memory. Restart your AI tool to activate.`,
      'Show Brain', 'Dismiss',
    );
    if (action === 'Show Brain') showBrainHealthPanel();
  }
  updateStatusBar();
}

function buildCopilotInstructions(instanceId: string): string {
  // Full lifecycle protocol — kept in sync with the MCP autopilot's CLAUDE.md
  // block (sdk/mcp/src/index.ts buildClaudeMdBlock) so VS-Code-only users get
  // exactly the same "always active" behaviour as users who ran `autopilot`.
  return `## Cachly AI Brain — Always Active

This project uses the Cachly AI Brain for persistent memory across sessions.
Instance: \`${instanceId}\`. The Brain MCP server should be running (see \`.mcp.json\`).

### AT THE START of every new conversation (mandatory — before anything else):
\`\`\`
session_start(instance_id="${instanceId}", workspace_path="<absolute path to this project>", focus="<first topic the user mentioned>")
\`\`\`
Show the briefing to the user. If the Brain is empty, seed it:
\`\`\`
brain_from_git(instance_id="${instanceId}", repo_path="<workspace_path>", limit=100)
\`\`\`

### BEFORE every task (mandatory):
\`\`\`
smart_recall(instance_id="${instanceId}", query="<what you are about to do>")
\`\`\`
If relevant lessons are found, use them before researching.

### BEFORE editing any file (mandatory):
\`\`\`
remember_context(instance_id="${instanceId}", key="wip:<filename>", content="EDITING: <file:line> — <goal>", ttl=86400)
\`\`\`

### AFTER every fix, deploy, or discovery (mandatory):
\`\`\`
learn_from_attempts(instance_id="${instanceId}", topic="<category:keyword>", outcome="success"|"failure",
  what_worked="...", what_failed="...", severity="critical"|"major"|"minor",
  file_paths=["..."], commands=["..."], tags=["..."])
\`\`\`

### WHEN debugging any error (before grepping/reading files):
\`\`\`
causal_trace(instance_id="${instanceId}", problem="<exact error or symptom>")
\`\`\`
If the Brain already has a known fix, use it directly.

### AT THE END of every conversation (mandatory):
\`\`\`
session_end(instance_id="${instanceId}", summary="<one sentence: what was done>", files_changed=["..."])
\`\`\`

### Half-finished code rule:
Never commit code that does not compile. Run \`tsc --noEmit\` / \`go build ./...\` before every commit.

### Why this matters
Each recall saves ~1,200 tokens. The Brain survives IDE restarts, team switches, and model upgrades.
`;
}

async function writeFileContent(filePath: string, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf8'));
}

/**
 * Write .mcp.json, .github/copilot-instructions.md, and .vscode/settings.json
 * for the current workspace / git-root. Idempotent — safe to call multiple times.
 * Called from silentAutoSetup (background), finishSetup (manual wizard), and
 * checkMcpSetupAndNudge (catch-all safety net).
 */
async function writeWorkspaceFiles(baseUrl: string, apiKey: string, instanceId: string): Promise<void> {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const gitRoot = activeFile ? await findGitRoot(activeFile) : undefined;
  const targetRoot = gitRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!targetRoot) return;

  // .mcp.json — merge cachly entry; preserve all other MCP servers the user has configured
  const mcpPath = path.join(targetRoot, '.mcp.json');
  let mcpJson: { mcpServers?: Record<string, unknown> } = {};
  try {
    const rawMcp = await vscode.workspace.fs.readFile(vscode.Uri.file(mcpPath));
    mcpJson = parseJsonc(Buffer.from(rawMcp).toString('utf8')) as { mcpServers?: Record<string, unknown> };
  } catch { /* new file or invalid JSON — start fresh */ }
  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
  mcpJson.mcpServers['cachly'] = {
    command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'],
    env: { CACHLY_API_URL: baseUrl, CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId },
  };
  await writeFileContent(mcpPath, JSON.stringify(mcpJson, null, 2));

  // Instruction/rules files — write the SAME marked block to every AI tool's
  // convention so a user on any harness gets the full lifecycle protocol:
  // CLAUDE.md (Claude Code), AGENTS.md (Codex/agents), copilot-instructions.md
  // (Copilot), .windsurfrules (Windsurf), .clinerules (Cline). Cursor uses a
  // frontmatter .mdc handled separately below. Marker-based + idempotent: we
  // replace only our section and never wipe the user's content.
  // Cross-Harness Tier A — see docs/make_cachly_great_again.md §6.7.
  const BRAIN_START = '<!-- cachly-brain-start -->';
  const BRAIN_END = '<!-- cachly-brain-end -->';
  const brainBlock = `${BRAIN_START}\n${buildCopilotInstructions(instanceId)}${BRAIN_END}`;

  try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(targetRoot, '.github'))); } catch { /* exists */ }
  const instructionTargets = [
    path.join(targetRoot, 'CLAUDE.md'),
    path.join(targetRoot, 'AGENTS.md'),
    path.join(targetRoot, '.github', 'copilot-instructions.md'),
    path.join(targetRoot, '.windsurfrules'),
    path.join(targetRoot, '.clinerules'),
  ];
  for (const instructionsPath of instructionTargets) {
    let existingInstructions = '';
    try {
      const rawInstr = await vscode.workspace.fs.readFile(vscode.Uri.file(instructionsPath));
      existingInstructions = Buffer.from(rawInstr).toString('utf8');
    } catch { /* new file */ }
    let newInstructions: string;
    if (existingInstructions.includes(BRAIN_START) && existingInstructions.includes(BRAIN_END)) {
      // Replace only our section between the markers; everything else stays
      const before = existingInstructions.substring(0, existingInstructions.indexOf(BRAIN_START));
      const after = existingInstructions.substring(existingInstructions.indexOf(BRAIN_END) + BRAIN_END.length);
      newInstructions = before + brainBlock + after;
    } else if (existingInstructions.trim().length > 0) {
      // File has existing user content — append our section
      newInstructions = existingInstructions.trimEnd() + '\n\n' + brainBlock + '\n';
    } else {
      newInstructions = brainBlock + '\n';
    }
    await writeFileContent(instructionsPath, newInstructions);
  }

  // Cursor: .cursor/rules/cachly.mdc — YAML frontmatter (alwaysApply) makes the
  // block active every request. Frontmatter lives outside the brain markers, so
  // idempotent marker-replacement leaves it intact.
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(targetRoot, '.cursor', 'rules')));
    const mdcPath = path.join(targetRoot, '.cursor', 'rules', 'cachly.mdc');
    const frontmatter =
      '---\n' +
      'description: Cachly AI Brain — persistent memory protocol (recall before tasks, learn after fixes)\n' +
      'alwaysApply: true\n' +
      '---\n\n';
    let existingMdc = '';
    try {
      existingMdc = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(mdcPath))).toString('utf8');
    } catch { /* new file */ }
    let newMdc: string;
    if (existingMdc.includes(BRAIN_START) && existingMdc.includes(BRAIN_END)) {
      const before = existingMdc.substring(0, existingMdc.indexOf(BRAIN_START));
      const after = existingMdc.substring(existingMdc.indexOf(BRAIN_END) + BRAIN_END.length);
      newMdc = before + brainBlock + after;
    } else if (existingMdc.trim().length > 0) {
      newMdc = existingMdc.trimEnd() + '\n\n' + brainBlock + '\n';
    } else {
      newMdc = frontmatter + brainBlock + '\n';
    }
    await writeFileContent(mdcPath, newMdc);
  } catch { /* non-fatal */ }

  // .vscode/settings.json — bind instance to this git root
  const vsDir = path.join(targetRoot, '.vscode');
  try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(vsDir)); } catch { /* exists */ }
  const settingsPath = path.join(vsDir, 'settings.json');
  let existing: Record<string, unknown> = {};
  let settingsReadOk = true;
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath));
    // JSONC-tolerant: plain JSON.parse throws on comments/trailing commas, which
    // would reset `existing` to {} and WIPE the user's entire settings.json.
    existing = parseJsonc(Buffer.from(raw).toString('utf8'));
  } catch (e) {
    // Distinguish "file doesn't exist" (fine) from "file exists but unparseable"
    // (must NOT overwrite — that would destroy the user's settings).
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(settingsPath));
      settingsReadOk = false; // exists but couldn't parse → leave it alone
      log('settings.json exists but could not be parsed — not overwriting', (e as Error).message);
    } catch { /* truly new file */ }
  }
  if (settingsReadOk) {
    existing['cachly.instanceId'] = instanceId;
    await writeFileContent(settingsPath, JSON.stringify(existing, null, 2));
  }

  // .git/hooks/post-commit — CLS (Continuous Learning Stream): auto-learns every
  // commit into the brain. Mirrors the MCP autopilot so VS-Code-only users get
  // ambient learning too. Best-effort, idempotent, preserves existing hooks.
  // The API key is embedded (into local .git/, never committed) so the hook's
  // cls-ingest call can authenticate — same posture as the editor MCP config.
  const clsKey = vscode.workspace.getConfiguration('cachly').get<string>('apiKey', '');
  await installClsHook(targetRoot, instanceId, clsKey || undefined);

  // .claude/hooks + settings.json — Ambient Recall (push-based memory) for
  // users who also run Claude Code in this workspace. Mirrors the MCP `init`
  // so recall/briefing/auto-learn happen automatically, no manual calls.
  await installAmbientHooksVs(targetRoot, instanceId, clsKey || undefined);

  // CI scaffold — auto-detect GitHub vs GitLab from the origin remote and write
  // the matching config (GitHub Action workflow or GitLab include). Idempotent.
  await writeCiConfig(targetRoot, instanceId);

  const m = extensionContext.globalState.get<Record<string, string>>('gitRootInstanceMap', {});
  m[targetRoot] = instanceId;
  void extensionContext.globalState.update('gitRootInstanceMap', m);
}

/**
 * Install the CLS git post-commit hook. Kept in sync with the MCP autopilot
 * (sdk/mcp/src/index.ts). Idempotent: skips if our marker is already present,
 * appends if another hook exists, creates+chmods otherwise. Never throws.
 */
async function installClsHook(targetRoot: string, instanceId: string, apiKey?: string): Promise<void> {
  try {
    const gitDir = path.join(targetRoot, '.git');
    if (!fs.existsSync(gitDir)) return; // not a git repo (or a worktree file — skip)
    const hookDir = path.join(gitDir, 'hooks');
    const hookPath = path.join(hookDir, 'post-commit');
    await fs.promises.mkdir(hookDir, { recursive: true });
    const hookScript = buildClsPostCommitHook(instanceId, apiKey);
    let existingHook = '';
    try { existingHook = await fs.promises.readFile(hookPath, 'utf8'); } catch { /* no existing hook */ }

    if (!existingHook) {
      await fs.promises.writeFile(hookPath, hookScript + '\n', 'utf8');
      try { await fs.promises.chmod(hookPath, 0o755); } catch { /* Windows: chmod is a no-op */ }
      log('Installed CLS hook at .git/hooks/post-commit');
      return;
    }
    if (existingHook.includes(`cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`)) {
      log('CLS hook already current in .git/hooks/post-commit');
      return;
    }
    // Matches any prior cachly block (marker → exit 0), optionally its shebang —
    // so old/broken v1 hooks are upgraded in place rather than skipped forever.
    const oldBlock = /(?:#!\/bin\/sh\n)?# cachly CLS[\s\S]*?\nexit 0\n?/;
    if (oldBlock.test(existingHook)) {
      const replaced = existingHook.replace(oldBlock, hookScript);
      await fs.promises.writeFile(hookPath, replaced.endsWith('\n') ? replaced : replaced + '\n', 'utf8');
      try { await fs.promises.chmod(hookPath, 0o755); } catch { /* no-op on Windows */ }
      log('Upgraded CLS hook in .git/hooks/post-commit');
      return;
    }
    // Foreign hook with no cachly block → append ours.
    await fs.promises.writeFile(hookPath, existingHook.trimEnd() + '\n\n' + hookScript + '\n', 'utf8');
    log('Appended CLS hook to existing .git/hooks/post-commit');
  } catch (e) {
    log('CLS hook install skipped (non-critical)', (e as Error).message);
  }
}

/**
 * Install the Ambient Recall hooks (.claude/hooks/*.sh + settings.json merge).
 * Kept in sync with sdk/mcp/src/ambient-hooks.ts installAmbientHooks. Idempotent
 * and non-destructive (foreign hooks preserved, stale cachly entries upgraded).
 * Never throws. API key goes into local scripts only — .claude/hooks is
 * meant for the user's machine, same posture as the CLS hook.
 */
async function installAmbientHooksVs(targetRoot: string, instanceId: string, apiKey?: string): Promise<void> {
  try {
    const hookDir = path.join(targetRoot, '.claude', 'hooks');
    await fs.promises.mkdir(hookDir, { recursive: true });

    const events: AmbientHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
    const paths = {} as AmbientHookPaths;
    let wrote = false;
    for (const event of events) {
      const p = path.join(hookDir, AMBIENT_SCRIPT_NAMES[event]);
      paths[event] = p;
      const script = buildAmbientHook(event, instanceId, apiKey) + '\n';
      let prev = '';
      try { prev = await fs.promises.readFile(p, 'utf8'); } catch { /* new file */ }
      if (prev !== script) {
        await fs.promises.writeFile(p, script, 'utf8');
        try { await fs.promises.chmod(p, 0o755); } catch { /* Windows: chmod is a no-op */ }
        wrote = true;
      }
    }

    const settingsPath = path.join(targetRoot, '.claude', 'settings.json');
    let existing: ClaudeSettingsLike = {};
    let parseOk = true;
    try {
      existing = parseJsonc(await fs.promises.readFile(settingsPath, 'utf8')) as ClaudeSettingsLike;
    } catch (e) {
      try {
        await fs.promises.stat(settingsPath);
        parseOk = false; // exists but unparseable → never overwrite the user's file
        log('.claude/settings.json exists but could not be parsed — not overwriting', (e as Error).message);
      } catch { /* truly new file */ }
    }
    if (parseOk) {
      const { settings, changed } = mergeAmbientSettings(existing, paths);
      if (changed) {
        await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        wrote = true;
      }
    }
    if (wrote) log(`Ambient Recall hooks installed/updated (.claude/hooks, ${AMBIENT_HOOK_VERSION})`);
  } catch (e) {
    log('Ambient hooks install skipped (non-critical)', (e as Error).message);
  }
}

// ── CI provider auto-detection ───────────────────────────────────────────────

type CiHost = 'github' | 'gitlab' | undefined;

/**
 * Detect whether the repo's origin remote points at GitHub or GitLab by reading
 * .git/config. Returns undefined when there's no recognizable remote (so we
 * write nothing rather than guess). Never throws.
 */
async function detectGitRemoteHost(targetRoot: string): Promise<CiHost> {
  try {
    const cfg = await fs.promises.readFile(path.join(targetRoot, '.git', 'config'), 'utf8');
    const urls = [...cfg.matchAll(/url\s*=\s*(.+)/g)].map(m => m[1].toLowerCase());
    if (urls.some(u => u.includes('gitlab.com') || u.includes('gitlab'))) return 'gitlab';
    if (urls.some(u => u.includes('github.com') || u.includes('github'))) return 'github';
  } catch { /* no .git/config — not a git repo or unreadable */ }
  return undefined;
}

const CI_BRAIN_MARKER = 'cachly-brain';

/**
 * Write a ready-to-use CI scaffold matching the detected host:
 *   GitHub → .github/workflows/cachly.yml (uses cachly-dev/cachly-action)
 *   GitLab → include block appended to .gitlab-ci.yml (uses the GitLab template)
 * Idempotent and non-destructive: never overwrites an existing cachly CI file,
 * and for GitLab only appends our include once (marker-guarded). Best-effort.
 */
async function writeCiConfig(targetRoot: string, instanceId: string): Promise<void> {
  try {
    const host = await detectGitRemoteHost(targetRoot);
    if (!host) return;

    if (host === 'github') {
      const wfDir = path.join(targetRoot, '.github', 'workflows');
      const wfPath = path.join(wfDir, 'cachly.yml');
      if (fs.existsSync(wfPath)) return; // don't clobber an existing workflow
      await fs.promises.mkdir(wfDir, { recursive: true });
      await fs.promises.writeFile(wfPath, buildGithubWorkflow(instanceId), 'utf8');
      log('Wrote .github/workflows/cachly.yml');
      return;
    }

    // GitLab — merge an include into .gitlab-ci.yml (create if absent).
    const ciPath = path.join(targetRoot, '.gitlab-ci.yml');
    let existing = '';
    try { existing = await fs.promises.readFile(ciPath, 'utf8'); } catch { /* new file */ }
    if (existing.includes(CI_BRAIN_MARKER)) return; // already wired
    const block = buildGitlabInclude(instanceId);
    const merged = existing.trim().length > 0 ? existing.trimEnd() + '\n\n' + block : block;
    await fs.promises.writeFile(ciPath, merged, 'utf8');
    log('Wired Cachly Brain into .gitlab-ci.yml');
  } catch (e) {
    log('CI config write skipped (non-critical)', (e as Error).message);
  }
}

function buildGithubWorkflow(instanceId: string): string {
  return `# ${CI_BRAIN_MARKER}: auto-generated by the Cachly Brain VS Code extension.
# Learns from merged commits and predicts MR/PR failures. Set CACHLY_API_KEY in
# your repo secrets (Settings → Secrets and variables → Actions).
name: Cachly Brain

on:
  push:
    branches: [main]
  pull_request:

jobs:
  learn:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 20
      - uses: cachly-dev/cachly-action@main
        with:
          mode: learn
          api-key: \${{ secrets.CACHLY_API_KEY }}
          instance-id: ${instanceId}

  scan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachly-dev/cachly-action@main
        with:
          mode: scan
          api-key: \${{ secrets.CACHLY_API_KEY }}
          instance-id: ${instanceId}
          pr-number: \${{ github.event.number }}
          pr-title: \${{ github.event.pull_request.title }}
          pr-body: \${{ github.event.pull_request.body }}
`;
}

function buildGitlabInclude(instanceId: string): string {
  return `# ${CI_BRAIN_MARKER}: auto-generated by the Cachly Brain VS Code extension.
# Set CACHLY_API_KEY (masked) and confirm CACHLY_INSTANCE_ID in
# Settings → CI/CD → Variables. Docs: https://cachly.dev/docs/gitlab
include:
  - remote: 'https://raw.githubusercontent.com/cachly-dev/cachly-action/main/templates/cachly.gitlab-ci.yml'

variables:
  CACHLY_INSTANCE_ID: "${instanceId}"

cachly-learn:
  extends: .cachly_learn
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

cachly-scan:
  extends: .cachly_scan
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
`;
}

// ── Zero-Config Framework Detection ──────────────────────────────────────────

async function detectAndSuggestFrameworks(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('cachly');
  if (!config.get<string>('apiKey') || !config.get<string>('instanceId')) return;

  // Only run once per workspace
  const wsKey = `frameworkDetected:${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''}`;
  if (context.workspaceState.get<boolean>(wsKey, false)) return;

  const frameworks: string[] = [];
  const suggestions: string[] = [];

  // package.json
  try {
    const pkgFiles = await vscode.workspace.findFiles('package.json', '**/node_modules/**', 1);
    if (pkgFiles.length > 0) {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(pkgFiles[0])).toString();
      const pkg = JSON.parse(raw);
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps['next']) { frameworks.push('Next.js'); suggestions.push('deploy:nextjs', 'api:routes'); }
      if (deps['react']) { frameworks.push('React'); suggestions.push('code:react'); }
      if (deps['vue']) { frameworks.push('Vue.js'); suggestions.push('code:vue'); }
      if (deps['@nestjs/core']) { frameworks.push('NestJS'); suggestions.push('api:nestjs'); }
      if (deps['express']) { frameworks.push('Express'); suggestions.push('api:express'); }
      if (deps['fastify']) { frameworks.push('Fastify'); suggestions.push('api:fastify'); }
      if (deps['langchain']) { frameworks.push('LangChain JS'); suggestions.push('ai:langchain'); }
      if (deps['openai']) { frameworks.push('OpenAI JS'); suggestions.push('ai:openai'); }
    }
  } catch { /* no package.json */ }

  // go.mod
  try {
    const goFiles = await vscode.workspace.findFiles('go.mod', undefined, 1);
    if (goFiles.length > 0) {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(goFiles[0])).toString();
      if (raw.includes('gin-gonic')) { frameworks.push('Gin'); suggestions.push('api:gin'); }
      if (raw.includes('gofiber')) { frameworks.push('Fiber'); suggestions.push('api:fiber'); }
      if (raw.includes('google.golang.org/grpc')) { frameworks.push('gRPC'); suggestions.push('api:grpc'); }
      if (raw.includes('langchain')) { frameworks.push('LangChain Go'); suggestions.push('ai:langchain'); }
    }
  } catch { /* no go.mod */ }

  // requirements.txt / pyproject.toml
  try {
    const pyFiles = await vscode.workspace.findFiles('{requirements*.txt,pyproject.toml}', undefined, 3);
    for (const f of pyFiles) {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(f)).toString().toLowerCase();
      if (raw.includes('langchain')) { frameworks.push('LangChain Python'); suggestions.push('ai:langchain'); }
      if (raw.includes('fastapi')) { frameworks.push('FastAPI'); suggestions.push('api:fastapi'); }
      if (raw.includes('django')) { frameworks.push('Django'); suggestions.push('api:django'); }
      if (raw.includes('flask')) { frameworks.push('Flask'); suggestions.push('api:flask'); }
      if (raw.includes('openai')) { frameworks.push('OpenAI Python'); suggestions.push('ai:openai'); }
    }
  } catch { /* no requirements */ }

  if (frameworks.length === 0) return;

  await context.workspaceState.update(wsKey, true);
  const unique = [...new Set(frameworks)];

  if (!claimInterrupt()) return; // once-per-workspace already, and never urgent
  const action = await vscode.window.showInformationMessage(
    `🧠 Cachly detected: ${unique.join(', ')}. Load relevant Brain lessons for this stack?`,
    'Load Lessons',
    'Dismiss',
  );
  if (action === 'Load Lessons') {
    showLessonsPanel();
  }
}

// ── CodeLens Provider ─────────────────────────────────────────────────────────

class CachlyCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration('cachly');
    if (!config.get<string>('apiKey') || !config.get<string>('instanceId')) return [];
    if (!config.get<boolean>('codeLens', true)) return [];
    if (!lastHealth || lastHealth.topLessons.length === 0) return [];

    const fileName = document.fileName.toLowerCase();
    const relevant = lastHealth.topLessons.filter((l) => {
      const parts = l.topic.toLowerCase().split(':');
      return parts.some((p) => p.length >= 3 && fileName.includes(p));
    });

    if (relevant.length === 0) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const plural = relevant.length > 1 ? 's' : '';
    return [
      new vscode.CodeLens(range, {
        title: `🧠 cachly: ${relevant.length} Brain lesson${plural} for this file — click to view`,
        command: 'cachly.showLessons',
      }),
    ];
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpPostForm(url: string, params: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const mod = new URL(url).protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// HttpError carries the response status so callers can distinguish auth failures
// (401/403) from transient network issues and bail out of polling loops early.
class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// ── HTTP helpers ──

/**
 * Every request carries an honest User-Agent.
 *
 * Node's raw https module sends NONE by default. Today that happens to pass
 * our Cloudflare, but the WAF already bans other library signatures
 * (Python-urllib gets 403 error 1010, measured 2026-08-16) — one rule change
 * away from every installed panel going "Unreachable" at once, with nothing
 * in any log naming the extension. An identified client can be allowlisted
 * and found in access logs; an anonymous one can only be debugged by outage.
 */
const USER_AGENT = `cachly-vscode/${(() => { try { return (vscode.extensions.getExtension('cachly.cachly-brain')?.packageJSON as { version?: string })?.version ?? '0'; } catch { return '0'; } })()}`;

function apiGet(url: string, apiKey: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(data); } catch { /* empty/non-json body */ }
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) { resolve(parsed); return; }
        reject(new HttpError(status, parsed));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function apiPost(url: string, apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(data); } catch { /* empty/non-json body */ }
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) { resolve(parsed); return; }
        reject(new HttpError(status, parsed));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Extension Telemetry ─────────────────────────────────────────────────────
// Fire-and-forget; never throws; does not block the calling action.
// Uses a per-session set to avoid spamming repeated events.
const _trackedThisSession = new Set<string>();

function trackVSCodeEvent(
  event: string,
  opts?: { apiKey?: string; instanceId?: string; once?: boolean },
): void {
  const { apiKey = '', instanceId = '', once = false } = opts ?? {};
  if (once) {
    if (_trackedThisSession.has(event)) return;
    _trackedThisSession.add(event);
  }
  const config = vscode.workspace.getConfiguration('cachly');
  const baseUrl = apiBaseUrl(config);
  const effectiveKey = apiKey || config.get<string>('apiKey', '');
  void apiPostAnon(`${baseUrl}/api/v1/telemetry/mcp`, {
    event,
    version: extensionVersion,
    editor: 'vscode',
    source: 'vscode',
    api_key: effectiveKey,
    instance_id: instanceId,
  }).catch(() => { /* silently ignore — telemetry must never break UX */ });
}

/** POST without authentication — used for device flow (no API key yet). */
function apiPostAnon(url: string, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': USER_AGENT,
      },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── WebView panels ────────────────────────────────────────────────────────────

async function showBrainHealthPanel() {
  const health = await fetchBrainHealth();
  lastHealth = health;
  trackVSCodeEvent('vscode_brain_panel_opened', { once: true });
  showInBrainWebview('🧠 Cachly Brain Health', buildHealthHtml(health));
}

async function showLessonsPanel() {
  const health = lastHealth ?? await fetchBrainHealth();
  lastHealth = health;
  if (health.topLessons.length === 0) {
    vscode.window.showInformationMessage(
      'No lessons yet. AI assistants store lessons via learn_from_attempts after fixing bugs.',
    );
    return;
  }
  showInBrainWebview('📖 Cachly Brain — Lessons', buildLessonsHtml(health));
}

function showInBrainWebview(title: string, html: string) {
  if (brainPanel) {
    brainPanel.title = title;
    brainPanel.webview.html = wrapHtml(html);
    brainPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    brainPanel = vscode.window.createWebviewPanel(
      'cachlyBrain', title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Scripts are CSP-locked to a per-render nonce (see wrapHtml) and only
      // power local interactivity (filter box, toolbar postMessage) — the panel
      // never loads remote code.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    brainPanel.webview.onDidReceiveMessage((msg) => void handleBrainPanelMessage(msg));
    brainPanel.webview.html = wrapHtml(html);
    brainPanel.onDidDispose(() => { brainPanel = undefined; });
  }
}

async function handleBrainPanelMessage(msg: { cmd?: string; text?: string } | undefined): Promise<void> {
  try {
    switch (msg?.cmd) {
      case 'refresh':
      case 'showHealth':
        await showBrainHealthPanel();
        break;
      case 'showLessons':
        await showLessonsPanel();
        break;
      case 'saveLesson':
        await vscode.commands.executeCommand('cachly.saveLesson');
        break;
      case 'doctor':
        await vscode.commands.executeCommand('cachly.diagnose');
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'cachly');
        break;
      case 'upgrade':
        await vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/billing'));
        break;
      case 'setAuthor': {
        const current = vscode.workspace.getConfiguration('cachly').get<string>('authorName') ?? '';
        const name = await vscode.window.showInputBox({
          prompt: 'Your name or handle — lessons you save are attributed to it (Team Brain)',
          placeHolder: 'e.g. heinrich',
          value: current,
        });
        if (name !== undefined) {
          await vscode.workspace.getConfiguration('cachly')
            .update('authorName', name.trim(), vscode.ConfigurationTarget.Global);
          await showBrainHealthPanel();
        }
        break;
      }
      case 'copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('🧠 Copied to clipboard', 2000);
        }
        break;
    }
  } catch (e) {
    log('brain panel message failed', (e as Error).message);
  }
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHealthHtml(health: BrainHealth): string {
  const statusLabel = health.status === 'healthy' ? '✅ Healthy'
    : health.status === 'empty' ? '🌱 Ready (no lessons yet)'
    : health.status === 'setup_needed' ? '🔐 Re-auth needed'
    : health.status === 'degraded' ? '⚠️ Degraded' : '❌ Unreachable';

  // Limited tiers report a MONTHLY recall counter (resets each month);
  // unlimited tiers report the all-time total. Label accordingly — mixing the
  // two up is exactly what made the old "15450/500" display meaningless.
  const monthly = health.recallLimit > 0;
  const scopeLabel = monthly ? 'this month' : 'all-time';
  const recallPct = monthly ? (health.totalRecalls / health.recallLimit) * 100 : 0;
  const overLimit = monthly && health.totalRecalls >= health.recallLimit;

  const usedMB = (health.memoryUsedBytes / (1024 * 1024)).toFixed(1);
  const limitMB = (health.memoryLimitBytes / (1024 * 1024)).toFixed(0);

  const meter = (pct: number, danger = false) =>
    `<div class="meter${danger ? ' danger' : ''}"><span style="width:${Math.round(Math.min(pct, 100))}%"></span></div>`;

  const toolbar = `
    <div class="toolbar">
      <button data-cmd="refresh" title="Re-fetch Brain data">⟳ Refresh</button>
      <button data-cmd="showLessons" title="Browse all lessons">📖 Lessons</button>
      <button data-cmd="saveLesson" title="Save a lesson manually">＋ Save lesson</button>
      <button data-cmd="doctor" title="Run connection diagnostics">🩺 Doctor</button>
      <button data-cmd="openSettings" title="Open cachly settings">⚙ Settings</button>
      <span class="updated">updated ${new Date().toLocaleTimeString()}</span>
    </div>`;

  const banners: string[] = [];
  if (health.status === 'unreachable') {
    banners.push(`<div class="banner error">🧠 <strong>Offline</strong> — cannot reach the Cachly API. Check your API key, instance ID, and network. <button class="mini" data-cmd="doctor">Run Brain Doctor</button></div>`);
  }
  if (health.pendingLessons > 0) {
    banners.push(`<div class="banner warn">⏳ <strong>${health.pendingLessons} lesson${health.pendingLessons === 1 ? '' : 's'} saved offline</strong> — not yet counted below. They sync automatically once the Brain is reachable.</div>`);
  }
  if (health.goodwillMessage) {
    banners.push(`<div class="banner info">${esc(health.goodwillMessage)}</div>`);
  }
  if (overLimit) {
    banners.push(`<div class="banner error">🚦 <strong>Monthly recall limit reached</strong> (${health.totalRecalls.toLocaleString()} of ${health.recallLimit.toLocaleString()}). Recalls may be throttled until next month. <button class="mini" data-cmd="upgrade">Upgrade for unlimited</button></div>`);
  } else if (monthly && recallPct >= 80) {
    banners.push(`<div class="banner warn">🚀 <strong>${recallPct.toFixed(0)}% of your monthly recall limit used.</strong> <button class="mini" data-cmd="upgrade">Upgrade for unlimited</button></div>`);
  }

  const cards = `
    <div class="cards">
      <div class="card">
        <div class="card-label">Lessons</div>
        <div class="card-value">${health.lessons.toLocaleString()}</div>
        <div class="card-sub">${health.topics.length} topic${health.topics.length === 1 ? '' : 's'} · ${health.contexts} context entr${health.contexts === 1 ? 'y' : 'ies'}</div>
      </div>
      <div class="card">
        <div class="card-label">Recalls ${scopeLabel}</div>
        <div class="card-value${overLimit ? ' over' : ''}">${health.totalRecalls.toLocaleString()}${monthly ? `<span class="of"> / ${health.recallLimit.toLocaleString()}</span>` : ''}</div>
        ${monthly ? meter(recallPct, recallPct >= 90) : ''}
        <div class="card-sub">${monthly
          ? (overLimit ? 'monthly limit reached' : `${recallPct.toFixed(0)}% of the ${esc(health.tier)} monthly limit`)
          : 'unlimited plan — counter never resets'}</div>
      </div>
      <div class="card">
        <div class="card-label">Est. tokens saved ${scopeLabel}</div>
        <div class="card-value">${fmtTokens(health.estimatedTokensSaved).replace('~', '')}</div>
        <div class="card-sub">estimate: ~${TOKENS_PER_RECALL.toLocaleString()} tokens per reused lesson</div>
      </div>
      ${health.memoryLimitBytes > 0 ? `
      <div class="card">
        <div class="card-label">Storage</div>
        <div class="card-value">${usedMB}<span class="of"> / ${limitMB} MB</span></div>
        ${meter(health.memoryUsedPct, health.memoryUsedPct >= 90)}
        <div class="card-sub">${health.memoryUsedPct.toFixed(1)}% used</div>
      </div>` : ''}
    </div>`;

  const metaLine = `<p class="meta">${statusLabel} · Tier <strong>${esc(health.tier)}</strong>${
    health.lastSession ? ` · Last session: <em>${esc(health.lastSession.slice(0, 110))}${health.lastSession.length > 110 ? '…' : ''}</em>` : ''}</p>`;

  // ── Value estimate — every number here is a labeled heuristic, never
  // presented as measured fact (the fastest way to lose user trust is a
  // "€3,300 saved" line that can't survive one skeptical question). ──
  let roiSection = '';
  if (health.insights) {
    const ins = health.insights;
    const rows: string[] = [];
    if (ins.minutes_saved > 0) {
      rows.push(`<tr><td>Developer time saved</td><td><strong>${fmtDuration(ins.minutes_saved * 60)}</strong></td><td class="hint">heuristic: 30–240 min per reused lesson, weighted by severity</td></tr>`);
    }
    if (ins.dollars_saved > 0) {
      rows.push(`<tr><td>Cost saved</td><td><strong>${fmtMoney(ins.dollars_saved, ins.currency)}</strong></td><td class="hint">at ${fmtMoney(ins.hourly_rate, ins.currency)}/h — adjust your rate at cachly.dev/team</td></tr>`);
    }
    if (ins.ttfr_p50_sec > 0) {
      rows.push(`<tr><td>Time to first payoff</td><td><strong>${fmtDuration(ins.ttfr_p50_sec)}</strong></td><td class="hint">from Brain creation until a saved lesson was first reused</td></tr>`);
    }
    if (rows.length > 0) {
      roiSection = `<h2>💰 Value estimate</h2>
        <p class="hint">Estimates derived from recall activity — not measured billing data.</p>
        <table>${rows.join('')}</table>`;
    }
  }

  // ── Team Brain — honest solo state. A solo Brain mathematically cannot have
  // cross-author reuse, so showing "0.0%" reads as failure when it isn't. ──
  const configuredAuthor = (vscode.workspace.getConfiguration('cachly').get<string>('authorName') ?? '').trim();
  let teamSection: string;
  if (health.teamAuthors.length >= 2) {
    const reusePct = health.insights?.reuse_pct ?? 0;
    const reuseLine = reusePct > 0
      ? `<p><strong>Knowledge reuse:</strong> ${reusePct.toFixed(1)}% of recalls reused a teammate's lesson</p>`
      : `<p class="hint">No cross-author recalls yet — this fills up once teammates recall each other's lessons.</p>`;
    teamSection = `<h2>👥 Team Brain <span class="count">(${health.teamAuthors.length} contributors)</span></h2>
      ${reuseLine}
      <p>${health.teamAuthors.map(a => `<code>${esc(a)}</code>`).join(' · ')}</p>
      ${!configuredAuthor ? `<p><button class="mini" data-cmd="setAuthor">Set your author name</button> <span class="hint">so your lessons are attributed to you</span></p>` : ''}`;
  } else {
    teamSection = `<h2>👥 Team Brain</h2>
      <p class="hint">Solo Brain — ${configuredAuthor
        ? `lessons are attributed to <code>${esc(configuredAuthor)}</code>`
        : 'lessons are currently unattributed'}. Cross-author metrics appear once a teammate uses this instance.</p>
      ${!configuredAuthor ? `<p><button class="mini" data-cmd="setAuthor">Set your author name</button></p>` : ''}
      <p class="hint">Invite a teammate: same instance ID + API key in their editor — their AI instantly knows everything this Brain knows.</p>`;
  }

  const crystalSection = health.crystal
    ? `<h2>💎 Memory Crystal</h2><blockquote>${esc(health.crystal.summary)}</blockquote><p class="hint">Generated ${esc(health.crystal.created_at)} · ${health.crystal.patterns_hit} patterns</p>`
    : '';

  // Ambient recall net-token accounting (§6.2 "measure net, not gross"). Net =
  // est. tokens the surfaced lessons save (~TOKENS_PER_RECALL each, the same
  // model used for "Tokens Saved") minus the tokens injected to surface them.
  // We show the injected cost openly — net can be negative if recall is noisy.
  const ambientInjectedTotal = extensionContext?.globalState.get<number>(AMBIENT_INJECTED_KEY, 0) ?? 0;
  const ambientInjectionsTotal = extensionContext?.globalState.get<number>(AMBIENT_INJECTIONS_KEY, 0) ?? 0;
  const ambientSavedEst = ambientInjectionsTotal * TOKENS_PER_RECALL;
  const ambientNet = ambientSavedEst - ambientInjectedTotal;
  const ambientSection = ambientInjectionsTotal > 0
    ? `<h2>🔬 Ambient Recall — net token impact</h2>
       <table>
         <tr><td>Lessons surfaced (@cachly)</td><td><strong>${ambientInjectionsTotal.toLocaleString()}</strong></td><td></td></tr>
         <tr><td>Tokens injected (gross cost)</td><td>${fmtTokens(ambientInjectedTotal)}</td><td></td></tr>
         <tr><td>Est. tokens saved</td><td>${fmtTokens(ambientSavedEst)}</td><td class="hint">~${TOKENS_PER_RECALL}/lesson</td></tr>
         <tr><td><strong>Net</strong></td><td><strong class="${ambientNet >= 0 ? 'pos' : 'neg'}">${ambientNet >= 0 ? '+' : '−'}${fmtTokens(Math.abs(ambientNet)).replace('~', '')}</strong></td><td></td></tr>
       </table>
       <p class="hint">This session: ${sessionInjections} surfaced · ~${sessionInjectedTokens} tok injected. Honest accounting — the injected cost is shown, not just the savings.</p>`
    : '';

  // ── Lessons — searchable, copyable. data-lesson carries the lowercase
  // search key; the filter script in wrapHtml toggles row visibility. ──
  let lessonsSection: string;
  if (health.topLessons.length > 0) {
    const lessonRows = health.topLessons.map(l => {
      const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
      const sev = l.severity === 'critical' ? '🔴 critical' : l.severity === 'major' ? '🟠 major' : '🟡 minor';
      const worked = esc(l.what_worked.slice(0, 90)) + (l.what_worked.length > 90 ? '…' : '');
      const date = l.ts ? new Date(l.ts).toLocaleDateString() : '—';
      const searchKey = esc(`${l.topic} ${l.what_worked} ${l.author ?? ''} ${l.severity ?? ''}`.toLowerCase());
      return `<tr data-lesson="${searchKey}">
        <td><code>${esc(l.topic)}</code></td><td>${icon}</td><td class="num">${l.recall_count}</td>
        <td>${sev}</td><td>${worked}</td><td>${l.author ? esc(l.author) : '<span class="hint">—</span>'}</td><td>${date}</td>
        <td><button class="mini" data-cmd="copy" data-text="${esc(l.what_worked)}" title="Copy full lesson text">⧉</button></td>
      </tr>`;
    }).join('');
    lessonsSection = `
      <h2>🏆 Lessons <span class="count">(top ${health.topLessons.length} of ${health.lessons})</span></h2>
      <input id="lesson-filter" type="text" placeholder="Filter lessons — topic, text, author, severity…" />
      <table class="lessons">
        <tr><th>Topic</th><th></th><th>Recalls</th><th>Severity</th><th>What worked</th><th>Author</th><th>Learned</th><th></th></tr>
        ${lessonRows}
      </table>
      <p id="filter-empty" class="hint" style="display:none">No lessons match your filter.</p>
      ${health.lessons > health.topLessons.length ? `<p class="hint">Showing the ${health.topLessons.length} most-recalled lessons. <button class="mini" data-cmd="showLessons">Browse all</button></p>` : ''}`;
  } else {
    lessonsSection = `<h2>🏆 Lessons</h2>
      <p class="hint">No lessons yet. Your AI saves one automatically after each fix (<code>learn_from_attempts</code> via MCP), or save one yourself:</p>
      <p><button data-cmd="saveLesson">＋ Save your first lesson</button></p>`;
  }

  const primer = `<details>
      <summary>💡 How this works</summary>
      <blockquote>
        <strong>Lessons:</strong> AI assistants call <code>learn_from_attempts</code> after fixing bugs; recalls happen when a saved lesson is actually reused (<code>recall_best_solution</code>, <code>smart_recall</code>, or <code>@cachly</code> chat) — passive IDE activity is never counted.
        <br/><br/>
        <strong>Ambient Learning:</strong> Cachly watches for repeated typing patterns and <em>asks</em> whether to save them as a Brain lesson — never saves automatically.
      </blockquote>
    </details>`;

  return `
    ${toolbar}
    <h1>🧠 Cachly Brain</h1>
    ${metaLine}
    ${banners.join('\n')}
    ${cards}
    ${roiSection}
    ${ambientSection}
    ${lessonsSection}
    ${teamSection}
    ${crystalSection}
    ${primer}
  `;
}

function buildLessonsHtml(health: BrainHealth): string {
  const scopeLabel = health.recallLimit > 0 ? 'recalls this month' : 'recalls';
  const rows = health.topLessons.map(l => {
    const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
    const date = l.ts ? new Date(l.ts).toLocaleDateString() : 'unknown';
    const searchKey = esc(`${l.topic} ${l.what_worked} ${l.author ?? ''} ${l.severity ?? ''}`.toLowerCase());
    return `
      <div class="lesson" data-lesson="${searchKey}">
        <h2>${icon} <code>${esc(l.topic)}</code>
          <button class="mini" data-cmd="copy" data-text="${esc(l.what_worked)}" title="Copy lesson text">⧉ copy</button>
        </h2>
        <p class="hint">${esc(l.severity ?? 'minor')} · recalled ${l.recall_count} time${l.recall_count !== 1 ? 's' : ''} · learned ${date}${l.author ? ` · by ${esc(l.author)}` : ''}</p>
        <p>${esc(l.what_worked)}</p>
      </div>`;
  }).join('');

  const truncationNote = health.lessons > health.topLessons.length
    ? `<p class="hint">Showing the ${health.topLessons.length} most-recalled of ${health.lessons} lessons. The full archive is available via <code>brain_search</code> / <code>smart_recall</code> in your AI, or at cachly.dev.</p>`
    : '';

  return `
    <div class="toolbar">
      <button data-cmd="showHealth">🧠 Brain Health</button>
      <button data-cmd="refresh">⟳ Refresh</button>
      <button data-cmd="saveLesson">＋ Save lesson</button>
      <span class="updated">updated ${new Date().toLocaleTimeString()}</span>
    </div>
    <h1>📖 Lessons</h1>
    <p class="meta">${health.lessons} lessons · ${health.totalRecalls.toLocaleString()} ${scopeLabel}</p>
    <input id="lesson-filter" type="text" placeholder="Filter lessons — topic, text, author, severity…" />
    ${rows}
    <p id="filter-empty" class="hint" style="display:none">No lessons match your filter.</p>
    ${truncationNote}
    <hr/>
    <blockquote>
      💡 Lessons are created when an AI assistant calls <code>learn_from_attempts()</code> via the Cachly MCP server,
      or when you save one manually via <em>＋ Save lesson</em>.
    </blockquote>
  `;
}

function wrapHtml(body: string): string {
  // Per-render nonce: the CSP only executes the inline script below — the
  // panel can never load or run remote code.
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 28px 28px; max-width: 960px; }
    h1 { font-size: 1.45em; margin: 10px 0 2px; }
    h2 { font-size: 1.05em; margin-top: 26px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    td, th { padding: 6px 12px; border: 1px solid var(--vscode-panel-border); text-align: left; vertical-align: top; }
    th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
    tr:nth-child(even) td { background: var(--vscode-list-hoverBackground); }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    ul { padding-left: 20px; }
    li { margin: 3px 0; }
    hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 20px 0; }
    blockquote { border-left: 3px solid var(--vscode-activityBarBadge-background); padding: 8px 16px; color: var(--vscode-descriptionForeground); margin: 0; background: var(--vscode-textBlockQuote-background); }
    details { margin-top: 24px; }
    details summary { cursor: pointer; color: var(--vscode-descriptionForeground); }

    .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .meta { color: var(--vscode-descriptionForeground); margin-top: 0; }
    .count { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .pos { color: var(--vscode-charts-green, #4ade80); }
    .neg { color: var(--vscode-charts-red, #f87171); }

    .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; position: sticky; top: 0; background: var(--vscode-editor-background); padding: 6px 0; z-index: 2; }
    .toolbar .updated { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    button { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-family: inherit; font-size: 0.9em; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
    button.mini { padding: 1px 7px; font-size: 0.85em; }

    .banner { margin: 10px 0; padding: 10px 14px; border-radius: 4px; border-left: 3px solid var(--vscode-panel-border); background: var(--vscode-textBlockQuote-background); }
    .banner.warn { border-left-color: var(--vscode-editorWarning-foreground, #fbbf24); }
    .banner.error { border-left-color: var(--vscode-editorError-foreground, #f87171); }
    .banner.info { border-left-color: var(--vscode-charts-blue, #60a5fa); }

    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 14px 0; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px; background: var(--vscode-editorWidget-background, transparent); }
    .card-label { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
    .card-value { font-size: 1.6em; font-weight: 600; margin: 2px 0; font-variant-numeric: tabular-nums; }
    .card-value.over { color: var(--vscode-editorError-foreground, #f87171); }
    .card-value .of { font-size: 0.6em; font-weight: 400; color: var(--vscode-descriptionForeground); }
    .card-sub { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
    .meter { height: 5px; border-radius: 3px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); margin: 6px 0 4px; overflow: hidden; }
    .meter span { display: block; height: 100%; background: var(--vscode-progressBar-background, #a78bfa); }
    .meter.danger span { background: var(--vscode-editorError-foreground, #f87171); }

    #lesson-filter { width: 100%; box-sizing: border-box; margin: 8px 0; padding: 6px 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: inherit; }
    #lesson-filter:focus { outline: 1px solid var(--vscode-focusBorder); }
    .lesson { margin-bottom: 18px; }
    .lesson h2 { border: none; margin: 0 0 2px; }
  </style>
</head>
<body>${body}
<script nonce="${nonce}">
  (function () {
    const vscodeApi = acquireVsCodeApi();
    document.addEventListener('click', function (e) {
      const el = e.target && e.target.closest ? e.target.closest('[data-cmd]') : null;
      if (!el) return;
      vscodeApi.postMessage({ cmd: el.getAttribute('data-cmd'), text: el.getAttribute('data-text') || undefined });
    });
    const filter = document.getElementById('lesson-filter');
    if (filter) {
      filter.addEventListener('input', function () {
        const q = filter.value.toLowerCase().trim();
        let visible = 0;
        document.querySelectorAll('[data-lesson]').forEach(function (row) {
          const show = !q || (row.getAttribute('data-lesson') || '').indexOf(q) !== -1;
          row.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        const empty = document.getElementById('filter-empty');
        if (empty) empty.style.display = visible === 0 ? '' : 'none';
      });
    }
  })();
</script>
</body>
</html>`;
}

// ── MCP setup-detection nudge ─────────────────────────────────────────────────
// If the Brain is connected (apiKey set) but no MCP config found in workspace,
// the user's AI editor isn't actually using the Brain. Show a one-time nudge.

async function checkMcpSetupAndNudge(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  if (!isValidApiKey(apiKey)) return; // Brain not connected (or key malformed) — let auto-onboarding handle it

  const nudgeShown = context.globalState.get<boolean>('mcpNudgeShown', false);
  if (nudgeShown) return;

  // Check all workspace folders for known MCP config files
  const mcpPaths = ['.mcp.json', '.cursor/mcp.json', '.windsurf/mcp.json', '.vscode/mcp.json', '.zed/settings.json'];
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    for (const p of mcpPaths) {
      const uri = vscode.Uri.joinPath(folder.uri, p);
      try {
        await vscode.workspace.fs.stat(uri);
        // Found a config — MCP is set up, no nudge needed
        return;
      } catch { /* file doesn't exist */ }
    }
  }

  // No MCP config found — auto-write it for zero-friction setup
  await context.globalState.update('mcpNudgeShown', true);
  const instanceId2 = config.get<string>('instanceId', '') || await getEffectiveInstanceId();
  const baseUrl2 = apiBaseUrl(config);
  if (instanceId2) {
    try {
      await writeWorkspaceFiles(baseUrl2, apiKey, instanceId2);
      void vscode.window.showInformationMessage(
        '🧠 cachly: MCP wired to your AI editor! Restart Copilot, Claude Code, or Cursor to activate Brain memory.',
        'Show Brain',
      ).then(a => { if (a === 'Show Brain') showBrainHealthPanel(); });
      return;
    } catch { /* non-fatal — fall through to nudge */ }
  }
  void vscode.window.showInformationMessage(
    '🧠 cachly Brain is connected, but your AI editor isn\'t using it yet. Connect Claude Code, Cursor, or Windsurf in 30 seconds.',
    'Connect AI Editor',
    'Later',
  ).then(a => { if (a === 'Connect AI Editor') void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/setup-ai')); });
}

// ── Quick Recall for current file ─────────────────────────────────────────────
// Command: cachly.recallForFile
// Fetches lessons relevant to the currently open file and shows them in a panel.

// Proactive-briefing module state: debounce timer + per-session dedupe so a file
// is briefed at most once until its content meaningfully changes.
let briefingDebounce: ReturnType<typeof setTimeout> | undefined;
const briefedFiles = new Set<string>();

// Per-session dedupe by TOPIC, not just by file. Deduping only by file meant one
// lesson could pop up again for every new file it matched — the same warning
// dozens of times a day. A lesson gets one shot per session; the Brain panel
// still lists it, and "Not helpful" silences it for good.
const briefedTopics = new Set<string>();

// "Not helpful" suppressions, keyed by topic — persisted in globalState so a
// rejected lesson never comes back, across restarts. Keyed by topic rather than
// by file: a lesson that is noise is noise everywhere, and per-file keys meant
// the same warning kept reappearing on the next file it matched.
const BRIEFING_SUPPRESSED_KEY = 'cachly.briefingSuppressed';
const BRIEFING_SUPPRESSED_MAX = 300;

function briefingSuppressions(): Record<string, number> {
  return extensionContext?.globalState.get<Record<string, number>>(BRIEFING_SUPPRESSED_KEY, {}) ?? {};
}

async function suppressBriefing(topic: string): Promise<void> {
  if (!extensionContext) return;
  const all = briefingSuppressions();
  all[topic] = Date.now();
  const keys = Object.keys(all);
  if (keys.length > BRIEFING_SUPPRESSED_MAX) {
    keys.sort((a, b) => all[a] - all[b]);
    for (const k of keys.slice(0, keys.length - BRIEFING_SUPPRESSED_MAX)) delete all[k];
  }
  await extensionContext.globalState.update(BRIEFING_SUPPRESSED_KEY, all);
}

interface BriefingWarning {
  topic: string; confidence: number; severity: string; message: string; fix: string;
  risk?: number; outcome?: string; author?: string; learned_at?: string; matched_on?: string[];
}
interface BriefingResponse { risk_level?: string; warnings?: BriefingWarning[]; matched_lessons?: number }

// Client-side fallback for the "why did this fire" line when the API doesn't
// send matched_on yet — mirrors the server matcher: whole words (≥3 chars,
// camelCase split) shared by the path and the topic.
function matchedPathTokens(relPath: string, topic: string): string[] {
  const words = (s: string) => new Set(
    s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
      .split(/[^a-z0-9]+/).filter(w => w.length >= 3),
  );
  const topicWords = words(topic);
  return [...words(relPath)].filter(w => topicWords.has(w)).slice(0, 5);
}

/**
 * Push a brain briefing for a just-opened file. Surfaces a warning only when the
 * Brain holds a medium/high-risk failure pattern for it — otherwise stays silent.
 */
async function proactiveBriefingForDocument(doc: vscode.TextDocument): Promise<void> {
  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  const baseUrl = apiBaseUrl(config);
  if (!isValidApiKey(apiKey) || !instanceId) return;

  // Dedupe: only brief a given file once per session.
  const fileKey = doc.uri.toString();
  if (briefedFiles.has(fileKey)) return;
  briefedFiles.add(fileKey);

  // Use a workspace-relative path as the briefing context — richer signal than basename.
  const relPath = vscode.workspace.asRelativePath(doc.uri, false);

  try {
    const res = await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/briefing`, apiKey, {
      event_type: 'file_open',
      context: relPath,
    }) as BriefingResponse | undefined;

    const risk = (res?.risk_level ?? 'low').toLowerCase();
    const suppressed = briefingSuppressions();
    const warnings = (res?.warnings ?? []).filter(w =>
      // `${relPath}::${topic}` is the pre-0.12.1 per-file key — still honoured.
      !suppressed[w.topic] && !suppressed[`${relPath}::${w.topic}`] && !briefedTopics.has(w.topic),
    );
    if ((risk !== 'medium' && risk !== 'high') || warnings.length === 0) return;

    const top = warnings[0];
    briefedTopics.add(top.topic);
    const icon = risk === 'high' ? '🛑' : '⚠️';

    // Out of interruption budget: still surface it, just quietly. The lesson
    // stays in the Brain panel and the CodeLens for this file.
    if (!claimInterrupt()) {
      vscode.window.setStatusBarMessage(
        `$(brain) cachly: ${warnings.length} Brain warning(s) for ${path.basename(relPath)} — open the Brain panel`,
        8000,
      );
      return;
    }
    // Show what the hint is based on, not just the claim: severity + confidence
    // in the toast, full provenance in the panel.
    const pct = Math.round((top.confidence ?? 0) * 100);
    const meta = [top.severity, pct > 0 ? `${pct}%` : ''].filter(Boolean).join(' · ');
    const more = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
    const label = `${icon} cachly${meta ? ` [${meta}]` : ''}: ${top.message || top.topic}${more}`;

    trackVSCodeEvent('vscode_briefing_shown', { apiKey, instanceId });
    const action = await vscode.window.showWarningMessage(label, 'Show fix', 'Copy fix', 'Not helpful');
    if (action === 'Show fix') {
      trackVSCodeEvent('vscode_briefing_fix_opened', { apiKey, instanceId });
      const panel = vscode.window.createWebviewPanel(
        'cachlyBriefing',
        `${icon} Brain warning: ${path.basename(relPath)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false },
      );
      panel.webview.html = buildRecallHtml(relPath, warnings.map(w => ({
        topic: w.topic,
        what_worked: w.fix,
        outcome: w.outcome || 'failure',
        what_failed: w.message,
        confidence: w.confidence,
        severity: w.severity,
        author: w.author,
        learned_at: w.learned_at,
        matched_on: w.matched_on?.length ? w.matched_on : matchedPathTokens(relPath, w.topic),
      })), { matchedLessons: res?.matched_lessons });
    } else if (action === 'Copy fix') {
      trackVSCodeEvent('vscode_briefing_fix_copied', { apiKey, instanceId });
      await vscode.env.clipboard.writeText(top.fix || top.message || top.topic);
      vscode.window.setStatusBarMessage('$(brain) cachly: fix copied to clipboard', 4000);
    } else if (action === 'Not helpful') {
      trackVSCodeEvent('vscode_briefing_not_helpful', { apiKey, instanceId });
      await suppressBriefing(top.topic);
      vscode.window.setStatusBarMessage(`$(brain) cachly: won't warn about "${top.topic}" again`, 5000);
    } else {
      trackVSCodeEvent('vscode_briefing_dismissed', { apiKey, instanceId });
    }
  } catch {
    // Proactive feature — never surface errors for it. Allow a retry later.
    briefedFiles.delete(fileKey);
  }
}

async function recallForFileCommand(): Promise<void> {
  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  const instanceId = await getEffectiveInstanceId();
  const baseUrl = apiBaseUrl(config);

  if (!apiKey || !instanceId) {
    const action = await vscode.window.showWarningMessage(
      '🧠 cachly: Brain not connected. Set up in 30 seconds.',
      'Connect Brain',
    );
    if (action === 'Connect Brain') void setupAICommand();
    return;
  }
  // Guard against a malformed key that passes the truthy check but would 401 at the API.
  if (!isValidApiKey(apiKey)) return;

  const editor = vscode.window.activeTextEditor;
  const fileName = editor ? path.basename(editor.document.fileName) : '';
  const query = fileName || 'current file';

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `🧠 Recalling lessons for ${query}…`, cancellable: false },
    async () => {
      try {
        const res = await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/recall`, apiKey, {
          source: 'vscode-file-recall',
          query,
          limit: 10,
        }) as { top_lessons?: Array<{ topic: string; what_worked: string; outcome: string }>; lessons?: Array<{ topic: string; what_worked: string; outcome: string }> } | undefined;

        // The /recall endpoint returns `top_lessons` (not `lessons`); keep `lessons`
        // as a fallback in case the API shape changes.
        const lessons: Array<{ topic: string; what_worked: string; outcome: string }> = res?.top_lessons ?? res?.lessons ?? [];

        if (lessons.length === 0) {
          void vscode.window.showInformationMessage(`🧠 No lessons found for "${query}" yet. Use cachly.saveLesson to add some!`);
          return;
        }

        // Show results in a webview panel
        const panel = vscode.window.createWebviewPanel(
          'cachlyRecall',
          `🧠 Brain Recall: ${query}`,
          vscode.ViewColumn.Beside,
          { enableScripts: false },
        );
        panel.webview.html = buildRecallHtml(query, lessons);
      } catch (e) {
        void vscode.window.showErrorMessage(`🧠 cachly: recall failed — ${(e as Error).message}`);
      }
    },
  );
}

// One "lesson card" shape for every surface that renders a lesson (briefing
// panel, file recall, CLS review) — provenance and confidence render whenever
// the caller has them, so no surface silently drops trust signals again.
interface RecallLesson {
  topic: string; what_worked: string; outcome: string;
  what_failed?: string; confidence?: number; severity?: string;
  author?: string; learned_at?: string; matched_on?: string[];
}

function buildRecallHtml(query: string, lessons: RecallLesson[], opts?: { matchedLessons?: number }): string {
  const fmtDate = (iso?: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };
  const rows = lessons.map(l => {
    const pct = typeof l.confidence === 'number' && l.confidence > 0 ? `${Math.round(l.confidence * 100)}%` : '';
    const badges = [
      `<span class="outcome ${escapeHtml(l.outcome)}">${escapeHtml(l.outcome)}</span>`,
      l.severity ? `<span class="badge">${escapeHtml(l.severity)}</span>` : '',
      pct ? `<span class="badge" title="Brain confidence in this lesson">${pct} confidence</span>` : '',
    ].filter(Boolean).join(' ');
    const why = l.matched_on?.length
      ? `<div class="why">Triggered because <code>${escapeHtml(query)}</code> matches: ${l.matched_on.map(t => `<code>${escapeHtml(t)}</code>`).join(', ')}</div>`
      : '';
    const problem = l.what_failed
      ? `<div class="section"><span class="label">Problem</span> ${escapeHtml(l.what_failed)}</div>`
      : '';
    const fix = l.what_worked
      ? `<div class="section"><span class="label">Fix</span> ${escapeHtml(l.what_worked)}</div>`
      : '';
    const provParts = [fmtDate(l.learned_at) ? `learned ${fmtDate(l.learned_at)}` : '', l.author ? `by ${escapeHtml(l.author)}` : ''].filter(Boolean);
    const prov = provParts.length ? `<div class="prov">${provParts.join(' · ')}</div>` : '';
    return `
    <div class="lesson">
      <div class="topic">${escapeHtml(l.topic)} ${badges}</div>
      ${why}
      ${problem}
      ${fix}
      ${prov}
    </div>`;
  }).join('');
  const matchedNote = opts?.matchedLessons && opts.matchedLessons > lessons.length
    ? ` · top ${lessons.length} of ${opts.matchedLessons} matched lessons`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 16px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  h2 { font-size: 15px; margin-bottom: 12px; }
  .lesson { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
  .topic { font-family: monospace; font-size: 12px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
  .section { font-size: 13px; line-height: 1.5; margin-top: 4px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-right: 4px; }
  .why { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0 4px; }
  .why code { font-size: 11px; }
  .prov { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 9px; margin-left: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .outcome { font-size: 10px; padding: 1px 6px; border-radius: 9px; margin-left: 6px; }
  .outcome.success { background: #1a3a1a; color: #4ec94e; }
  .outcome.failure { background: #3a1a1a; color: #e06c6c; }
  .outcome.partial { background: #3a2a0a; color: #e0c06c; }
</style>
</head>
<body>
<h2>🧠 Brain recall: <code>${escapeHtml(query)}</code></h2>
<p style="color: var(--vscode-descriptionForeground); margin-bottom: 16px;">${lessons.length} lesson${lessons.length === 1 ? '' : 's'} found${matchedNote}</p>
${rows}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Session-summary notification ──────────────────────────────────────────────
// Shows "Your Brain learned X new lessons this session" when VS Code closes,
// but only if the session was long enough and new lessons were actually saved.

async function showSessionSummary(): Promise<void> {
  const sessionMinutes = (Date.now() - sessionActivatedAt) / 60_000;
  if (sessionMinutes < 5) return; // don't show for very short sessions

  const config = vscode.workspace.getConfiguration('cachly');
  const apiKey = config.get<string>('apiKey', '');
  if (!apiKey) return;

  try {
    const health = await fetchBrainHealth();
    if (!health) return;
    const newLessons = Math.max(0, health.lessons - sessionLessonsAtActivation);
    if (newLessons === 0) return;

    void vscode.window.showInformationMessage(
      `🧠 cachly: Your Brain learned ${newLessons} new lesson${newLessons === 1 ? '' : 's'} this session. Total: ${health.lessons} lessons.`,
      'View Brain',
    ).then((action) => {
      if (action === 'View Brain') void vscode.commands.executeCommand('cachly.showBrainHealth');
    });
  } catch { /* non-critical */ }
}

export function deactivate() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (syncTimer) clearInterval(syncTimer);
  if (ambientDebounce) clearTimeout(ambientDebounce);
  brainPanel?.dispose();
}
