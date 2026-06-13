"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const config_1 = require("./lib/config");
// ~$3 per 1M tokens (GPT-4o input blended rate)
const TOKENS_PER_RECALL = 1200;
const COST_PER_TOKEN = 0.000003;
function fmtTokens(n) {
    if (n >= 1000000)
        return `~${(n / 1000000).toFixed(1)}M tokens`;
    if (n >= 1000)
        return `~${(n / 1000).toFixed(0)}k tokens`;
    return `~${n} tokens`;
}
const OFFLINE_QUEUE_KEY = 'cachly.offlineLessonQueue';
let syncTimer;
function enqueueOfflineLesson(lesson) {
    if (!extensionContext)
        return;
    const queue = extensionContext.globalState.get(OFFLINE_QUEUE_KEY, []);
    // Cap at 500 lessons to avoid unbounded growth
    queue.push(lesson);
    if (queue.length > 500)
        queue.splice(0, queue.length - 500);
    void extensionContext.globalState.update(OFFLINE_QUEUE_KEY, queue);
}
async function flushOfflineQueue() {
    if (!extensionContext)
        return 0;
    const queue = extensionContext.globalState.get(OFFLINE_QUEUE_KEY, []);
    if (queue.length === 0)
        return 0;
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    const baseUrl = apiBaseUrl(config);
    if (!(0, config_1.isValidApiKey)(apiKey) || !instanceId)
        return 0;
    let synced = 0;
    const failed = [];
    for (const lesson of queue) {
        try {
            await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/learn`, apiKey, {
                ...lesson,
                source: lesson.source + '-offline-sync',
            });
            synced++;
        }
        catch {
            failed.push(lesson);
        }
    }
    await extensionContext.globalState.update(OFFLINE_QUEUE_KEY, failed);
    return synced;
}
function startSyncTimer() {
    if (syncTimer)
        clearInterval(syncTimer);
    // Try to flush offline queue every 5 minutes
    syncTimer = setInterval(() => { void flushOfflineQueue(); }, 5 * 60 * 1000);
}
const ambientMap = new Map();
let ambientDebounce;
// key = `${uri}::${code}::${message.slice(0,40)}`
const clsActiveErrors = new Map();
let clsLastEditedUri = '';
let clsLastEditTime = 0;
let statusBarItem;
let refreshTimer;
let recallTimer;
let lastHealth;
let brainPanel;
let extensionContext;
// Resolved once on activation from the real extension manifest so telemetry
// always reports the installed version (was hardcoded → analytics stuck on one).
let extensionVersion = '0.0.0';
// Session-summary tracking: count lessons saved during this VS Code window session
let sessionLessonsAtActivation = 0;
let sessionActivatedAt = 0;
// Canonical production API base. Read via apiBaseUrl() — never inline config.get
// with a string default, because vscode's get(key, default) only falls back to
// the default when the value is `undefined`. A user who has `cachly.apiUrl` set
// to an EMPTY STRING (a very common mistake / stale setting) would otherwise get
// `''` back, making every request a host-less relative URL that always fails →
// the Brain shows "OFFLINE" forever. apiBaseUrl() treats empty/whitespace as
// "unset" and also strips trailing slashes so URL concatenation stays correct.
const DEFAULT_API_URL = 'https://api.cachly.dev';
function apiBaseUrl(config) {
    const cfg = config ?? vscode.workspace.getConfiguration('cachly');
    return (0, config_1.normalizeBaseUrl)(cfg.get('apiUrl', ''), DEFAULT_API_URL);
}
// ── Output channel / structured logging ───────────────────────────────────────
// A single "Cachly Brain" output channel that records every config resolution,
// HTTP call (status + latency) and diagnostic. When a user reports "OFFLINE",
// the logs here (or the Brain Doctor below) say exactly why — no guessing.
let outputChannel;
function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Cachly Brain');
    }
    return outputChannel;
}
function log(message, ...details) {
    const ts = new Date().toISOString();
    let line = `[${ts}] ${message}`;
    if (details.length) {
        line += ' ' + details.map((d) => typeof d === 'string' ? d : (() => { try {
            return JSON.stringify(d);
        }
        catch {
            return String(d);
        } })()).join(' ');
    }
    getOutputChannel().appendLine(line);
}
// VS Code's .vscode/settings.json is JSONC. parseJsonc (from ./lib/config) is
// used everywhere we read it — plain JSON.parse throws on comments/trailing
// commas, which used to cause stale-cache fallback and settings.json wipes.
function activate(context) {
    extensionContext = context;
    // Read the real installed version from the manifest (cachly-dev.cachly-brain).
    extensionVersion =
        vscode.extensions.getExtension('cachly-dev.cachly-brain')?.packageJSON?.version ??
            context.extension?.packageJSON?.version ??
            extensionVersion;
    context.subscriptions.push({ dispose: () => brainPanel?.dispose() });
    context.subscriptions.push(getOutputChannel());
    log(`Cachly Brain activated (v${extensionVersion})`);
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'cachly.showBrainHealth';
    statusBarItem.tooltip = 'Cachly Brain — click for details';
    context.subscriptions.push(statusBarItem);
    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('cachly.showBrainHealth', showBrainHealthPanel), vscode.commands.registerCommand('cachly.showLessons', showLessonsPanel), vscode.commands.registerCommand('cachly.refreshBrain', () => updateStatusBar()), vscode.commands.registerCommand('cachly.saveLesson', saveLessonCommand), vscode.commands.registerCommand('cachly.setupAI', setupAICommand), vscode.commands.registerCommand('cachly.setup', setupAICommand), vscode.commands.registerCommand('cachly.linkAccount', linkAccountCommand), vscode.commands.registerCommand('cachly.recallForFile', recallForFileCommand), vscode.commands.registerCommand('cachly.resetAuth', resetAuthCommand), vscode.commands.registerCommand('cachly.diagnose', runBrainDoctor), vscode.commands.registerCommand('cachly.showLogs', () => getOutputChannel().show(true)));
    registerChatParticipant(context);
    // Record session start lesson count for end-of-session summary
    sessionActivatedAt = Date.now();
    void fetchBrainHealth().then((h) => { sessionLessonsAtActivation = h?.lessons ?? 0; }).catch(() => { });
    // Session-summary on window close
    context.subscriptions.push({
        dispose: () => void showSessionSummary(),
    });
    // Config change → restart loop
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cachly'))
            startRefreshLoop();
    }));
    // ── Ambient Learning: detect repeated edit patterns, prompt to save as lesson ─
    const cfg = vscode.workspace.getConfiguration('cachly');
    if (cfg.get('ambientLearning', true)) {
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
            // Track last edited URI + time for CLS pairing
            clsLastEditedUri = e.document.uri.toString();
            clsLastEditTime = Date.now();
            if (ambientDebounce)
                clearTimeout(ambientDebounce);
            ambientDebounce = setTimeout(() => handleAmbientEdit(e), 1500);
        }));
    }
    // ── CLS: Compiler Learning Stream — auto-learn from compiler errors ────────
    // When a diagnostic error appears, we track it. When it disappears after an
    // edit to that file, we infer a (problem→fix) pair and save it as a brain lesson.
    if (cfg.get('clsLearning', true)) {
        context.subscriptions.push(vscode.languages.onDidChangeDiagnostics((e) => {
            void handleClsDiagnosticsChange(e);
        }));
    }
    // ── CodeLens: Brain lessons relevant to open file ─────────────────────────
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new CachlyCodeLensProvider()));
    startRefreshLoop();
    // ── Trial expiry banner — shown on startup if trial key is stored ──────────
    {
        const trialConfig = vscode.workspace.getConfiguration('cachly');
        const trialExpiresAt = trialConfig.get('trialExpiresAt', '');
        if (trialExpiresAt) {
            const expiresDate = new Date(trialExpiresAt);
            const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            if (daysLeft <= 0) {
                void vscode.window.showWarningMessage('🧠 Cachly Brain trial has expired. Link your account to continue.', 'Link Account').then((choice) => { if (choice === 'Link Account')
                    void linkAccountCommand(); });
            }
            else if (daysLeft <= 7) {
                void vscode.window.showInformationMessage(`🧠 Cachly Brain trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. Link your account to keep data.`, 'Link Account', 'Later').then((choice) => { if (choice === 'Link Account')
                    void linkAccountCommand(); });
            }
        }
    }
    // ── Auto-Onboarding: silently provision credentials on every activation ─────
    // Zero-friction: try GitHub silent auth first, then instant-trial — no clicks.
    // Only falls back to the manual wizard if both methods are unavailable (offline).
    {
        const bootConfig = vscode.workspace.getConfiguration('cachly');
        const bootKey = bootConfig.get('apiKey', '');
        const bootInstance = bootConfig.get('instanceId', '');
        if (!(0, config_1.isValidApiKey)(bootKey) || !bootInstance) {
            // Small delay so VS Code finishes loading before hitting the network
            setTimeout(() => {
                void silentAutoSetup(context).then((provisioned) => {
                    if (!provisioned) {
                        // Both GitHub auth and instant-trial failed (fully offline / API down).
                        // Show the manual wizard as a last resort — but only once.
                        const onboardingShown = context.globalState.get('onboardingShown', false);
                        if (!onboardingShown) {
                            void context.globalState.update('onboardingShown', true);
                            void vscode.window.showInformationMessage('🧠 Your AI forgets everything between sessions. Cachly gives it permanent memory — free, 60-second setup.', 'Set up now', 'Later').then((action) => {
                                if (action === 'Set up now')
                                    void vscode.commands.executeCommand('cachly.setup');
                            });
                        }
                    }
                });
            }, 2000);
        }
    }
    // Session recall on activation + hourly
    triggerSessionRecall();
    const ONE_HOUR = 60 * 60 * 1000;
    recallTimer = setInterval(() => triggerSessionRecall(), ONE_HOUR);
    // Offline queue: try to sync immediately on activation, then every 5 min
    startSyncTimer();
    void flushOfflineQueue().then((n) => {
        if (n > 0) {
            void vscode.window.showInformationMessage(`🧠 cachly: synced ${n} offline lesson${n === 1 ? '' : 's'} to your Brain.`);
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
    if (refreshTimer)
        clearInterval(refreshTimer);
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    // Use getEffectiveInstanceId async — for the synchronous gate we check global first,
    // then let updateStatusBar do the full async resolution on every tick.
    const instanceIdQuick = config.get('instanceId', '');
    if (!(0, config_1.isValidApiKey)(apiKey) || !instanceIdQuick) {
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
    const interval = config.get('refreshInterval', 300) * 1000;
    refreshTimer = setInterval(() => updateStatusBar(), interval);
}
async function updateStatusBar() {
    try {
        const prevRecalls = lastHealth?.totalRecalls ?? 0;
        const health = await fetchBrainHealth();
        lastHealth = health;
        if (health.status === 'setup_needed') {
            statusBarItem.text = '$(warning) Brain: re-auth needed';
            statusBarItem.tooltip = new vscode.MarkdownString(`**🔐 Brain needs re-authentication**\n\nYour API key looks expired or revoked. Click to reconnect — takes 10 seconds.`);
            statusBarItem.command = 'cachly.setup';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.show();
            return;
        }
        if (health.status === 'empty') {
            statusBarItem.text = '$(brain) Brain: ready';
            statusBarItem.tooltip = new vscode.MarkdownString(`**🧠 Brain is ready and listening**\n\n` +
                `No lessons yet — that's normal for a fresh setup.\n\n` +
                `Just code as usual. The brain learns automatically from repeated patterns, ` +
                `bug-fix commits, and lessons you save with **Cachly: Save Lesson**.\n\n` +
                `_Click to open Brain Health._`);
            statusBarItem.command = 'cachly.showBrainHealth';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.show();
            return;
        }
        if (health.status === 'unreachable') {
            const offlineCount = extensionContext?.globalState.get(OFFLINE_QUEUE_KEY, []).length ?? 0;
            const offlineSuffix = offlineCount > 0 ? ` · ${offlineCount} offline` : '';
            statusBarItem.text = `$(error) Brain: OFFLINE${offlineSuffix}`;
            statusBarItem.tooltip = new vscode.MarkdownString(`**🧠 Brain unreachable**\n\n` +
                (offlineCount > 0
                    ? `${offlineCount} lesson${offlineCount === 1 ? '' : 's'} queued locally — they'll sync automatically when the connection is back.\n\n`
                    : `Your editor can't reach the Brain right now.\n\n`) +
                `This is usually a temporary network blip or a provisioning instance.\n\n` +
                `_Click to open Brain Health and check the connection._`);
            statusBarItem.command = 'cachly.showBrainHealth';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }
        else {
            const icon = health.status === 'healthy' ? '$(brain)' : '$(warning)';
            const recallLabel = health.recallLimit > 0
                ? `${health.totalRecalls}/${health.recallLimit} recalls`
                : `${health.totalRecalls} recalls`;
            const tokenSuffix = health.estimatedTokensSaved >= 1000
                ? ` · ${fmtTokens(health.estimatedTokensSaved).replace(' tokens', ' tok')}`
                : '';
            const iqSuffix = health.iqBoostPct > 0 ? ` · 📈${health.iqBoostPct.toFixed(0)}%` : '';
            statusBarItem.text = `${icon} Brain: ${health.lessons} lessons · ${recallLabel}${tokenSuffix}${iqSuffix}`;
            const savedHrs = (health.totalRecalls * 8 / 60).toFixed(1);
            statusBarItem.tooltip = new vscode.MarkdownString(`**🧠 Brain active — learning from your work**\n\n` +
                `- 📚 **${health.lessons}** lessons remembered\n` +
                `- 🔁 **${health.totalRecalls}** recalls${health.recallLimit > 0 ? ` of ${health.recallLimit}` : ''} · ~${savedHrs}h saved\n` +
                (health.estimatedTokensSaved >= 1000 ? `- 💰 ${fmtTokens(health.estimatedTokensSaved)} saved\n` : '') +
                (health.status === 'degraded' ? `\n⚠️ _Degraded: brain is reachable but some features are slow._\n` : '') +
                `\n_Click to open Brain Health._`);
            statusBarItem.command = 'cachly.showBrainHealth';
            statusBarItem.backgroundColor = health.status === 'degraded'
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : undefined;
        }
        statusBarItem.show();
        // ── First Success Moment ─────────────────────────────────────────────────
        const config2 = vscode.workspace.getConfiguration('cachly');
        const instanceId = config2.get('instanceId', '');
        const firstHitKey = `firstHit:${instanceId}`;
        const alreadyShown = extensionContext.globalState.get(firstHitKey, false);
        if (!alreadyShown && prevRecalls === 0 && health.totalRecalls > 0 && health.topLessons.length > 0) {
            const lesson = health.topLessons[0];
            await extensionContext.globalState.update(firstHitKey, true);
            const action = await vscode.window.showInformationMessage(`🎉 First Brain hit! Recalled "${lesson.topic}" — saved ~1,200 tokens (~$0.004). Your AI won't re-research this again.`, 'Show Brain', 'Dismiss');
            if (action === 'Show Brain')
                showBrainHealthPanel();
        }
    }
    catch {
        statusBarItem.text = '$(brain) Brain: setup needed';
        statusBarItem.tooltip = new vscode.MarkdownString(`**🧠 Brain not connected**\n\n` +
            `Couldn't read your Brain — usually means setup isn't finished yet.\n\n` +
            `_Click to run setup and connect your Brain._`);
        statusBarItem.command = 'cachly.setup';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        statusBarItem.show();
    }
}
// ── Brain Health fetch ────────────────────────────────────────────────────────
async function fetchBrainHealth() {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    const baseUrl = apiBaseUrl(config);
    const result = {
        lessons: 0, contexts: 0, lastSession: null,
        status: 'unreachable', tier: 'unknown',
        totalRecalls: 0, recallLimit: -1, estimatedTokensSaved: 0, estimatedCostSaved: 0,
        topLessons: [], topics: [],
        memoryUsedBytes: 0, memoryLimitBytes: 0, memoryUsedPct: 0,
        iqBoostPct: 0, teamAuthors: [], crystal: null,
        pendingLessons: extensionContext?.globalState.get(OFFLINE_QUEUE_KEY, []).length ?? 0,
        insights: null,
    };
    if (!(0, config_1.isValidApiKey)(apiKey) || !instanceId)
        return result;
    // Instance fetch with one transient-retry — a single network blip or slow
    // container restart must not flip the status bar to OFFLINE permanently.
    const fetchInstOnce = () => apiGet(`${baseUrl}/api/v1/instances/${instanceId}`, apiKey);
    let instData = null;
    try {
        instData = await fetchInstOnce();
    }
    catch (e1) {
        const status = e1 instanceof HttpError ? e1.status : 0;
        if (status === 401 || status === 403) {
            result.status = 'setup_needed';
            return result;
        }
        try {
            await new Promise((r) => setTimeout(r, 1200));
            instData = await fetchInstOnce();
        }
        catch {
            return result;
        }
    }
    if (instData !== null && instData !== undefined) {
        result.status = 'healthy';
        if (instData.tier) {
            result.tier = instData.tier;
        }
    }
    // Memory fetch with one transient-retry to avoid showing "Degraded" on a single network blip.
    const fetchMemOnce = () => apiGet(`${baseUrl}/api/v1/instances/${instanceId}/memory`, apiKey);
    let memData = null;
    let memErr = null;
    try {
        memData = await fetchMemOnce();
    }
    catch (e1) {
        memErr = e1;
        // 401/403 → auth/setup problem, no point retrying.
        const status = e1 instanceof HttpError ? e1.status : 0;
        if (status !== 401 && status !== 403) {
            try {
                await new Promise((r) => setTimeout(r, 800));
                memData = await fetchMemOnce();
                memErr = null;
            }
            catch (e2) {
                memErr = e2;
            }
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
    }
    else if (memErr) {
        const status = memErr instanceof HttpError ? memErr.status : 0;
        result.status = (status === 401 || status === 403) ? 'setup_needed' : 'degraded';
    }
    // Insights (best-effort — graceful 404/error means endpoint not yet available)
    try {
        const insightsData = await apiGet(`${baseUrl}/api/v1/insights`, apiKey);
        if (insightsData && typeof insightsData.minutes_saved === 'number') {
            result.insights = insightsData;
        }
    }
    catch { /* insights endpoint unavailable — ignore */ }
    return result;
}
async function runBrainDoctor() {
    const ch = getOutputChannel();
    ch.show(true);
    const checks = [];
    const config = vscode.workspace.getConfiguration('cachly');
    const baseUrl = apiBaseUrl(config);
    const apiKey = config.get('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    ch.appendLine('');
    ch.appendLine('═══════════════════════════════════════════════');
    ch.appendLine(`  Cachly Brain Doctor — ${new Date().toLocaleString()}`);
    ch.appendLine('═══════════════════════════════════════════════');
    // 1. API key present + well-formed
    if (!apiKey) {
        checks.push({ label: 'API key', ok: false, detail: 'not set (cachly.apiKey is empty) — run "Cachly: Connect Brain"' });
    }
    else if (!(0, config_1.isValidApiKey)(apiKey)) {
        checks.push({ label: 'API key', ok: false, detail: 'malformed — expected cky_live_… / cky_trial_… / cky_test_…' });
    }
    else {
        checks.push({ label: 'API key', ok: true, detail: `present (${apiKey.slice(0, 12)}…)` });
    }
    // 2. Instance id present + well-formed
    if (!instanceId) {
        checks.push({ label: 'Instance id', ok: false, detail: 'not set — run "Cachly: Connect Brain" to provision one' });
    }
    else if (!(0, config_1.isValidInstanceId)(instanceId)) {
        checks.push({ label: 'Instance id', ok: false, detail: `not a valid UUID: "${instanceId}"` });
    }
    else {
        checks.push({ label: 'Instance id', ok: true, detail: instanceId });
    }
    ch.appendLine(`  base URL: ${baseUrl}`);
    ch.appendLine('');
    // 3. Live instance fetch (only if we have both credentials)
    let instanceStatus = 'unreachable';
    if (apiKey && instanceId) {
        const t0 = Date.now();
        try {
            await apiGet(`${baseUrl}/api/v1/instances/${instanceId}`, apiKey);
            const ms = Date.now() - t0;
            instanceStatus = 'healthy';
            checks.push({ label: 'Instance reachable', ok: true, detail: `HTTP 200 in ${ms}ms` });
        }
        catch (e) {
            const ms = Date.now() - t0;
            const status = e instanceof HttpError ? e.status : 0;
            instanceStatus = (0, config_1.classifyInstanceError)(status);
            const why = status === 401 || status === 403 ? 'auth rejected — key may be expired/revoked'
                : status === 404 ? 'instance not found for this key — stale or foreign instance id'
                    : status === 0 ? `network error: ${e.message}`
                        : `HTTP ${status}`;
            checks.push({ label: 'Instance reachable', ok: false, detail: `${why} (${ms}ms)` });
        }
    }
    else {
        checks.push({ label: 'Instance reachable', ok: false, detail: 'skipped — missing credentials' });
    }
    // 4. Live memory fetch
    if (apiKey && instanceId && instanceStatus === 'healthy') {
        const t0 = Date.now();
        try {
            await apiGet(`${baseUrl}/api/v1/instances/${instanceId}/memory`, apiKey);
            checks.push({ label: 'Memory readable', ok: true, detail: `HTTP 200 in ${Date.now() - t0}ms` });
        }
        catch (e) {
            const status = e instanceof HttpError ? e.status : 0;
            checks.push({ label: 'Memory readable', ok: false, detail: status ? `HTTP ${status}` : `network error: ${e.message}` });
        }
    }
    else {
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
    const choice = await vscode.window.showWarningMessage(`Cachly Brain Doctor found ${failed.length} problem(s): ${failed.map((f) => f.label).join(', ')}.`, ...buttons);
    if (choice === 'Connect Brain') {
        void vscode.commands.executeCommand('cachly.setup');
    }
    else if (choice === 'Show Logs') {
        ch.show(true);
    }
}
// ── Chat participant: @cachly ─────────────────────────────────────────────────
// Brings the Brain into the native Chat view. Subcommands:
//   @cachly /recall <query>  → search lessons        @cachly /status → health
//   @cachly /save <lesson>   → store a lesson         @cachly /doctor → diagnose
// A bare "@cachly <text>" defaults to recall so it's useful with zero ceremony.
function registerChatParticipant(context) {
    // chat API is only present on VS Code ≥ 1.85; guard so older hosts (or
    // environments without it) don't crash on activate.
    const chatApi = vscode.chat;
    if (!chatApi?.createChatParticipant) {
        log('Chat API unavailable — skipping @cachly participant registration');
        return;
    }
    const handler = async (request, _ctx, stream, _token) => {
        const config = vscode.workspace.getConfiguration('cachly');
        const apiKey = config.get('apiKey', '');
        const instanceId = await getEffectiveInstanceId();
        const baseUrl = apiBaseUrl(config);
        if (!apiKey || !instanceId) {
            stream.markdown('🧠 Your Brain isn\'t connected yet. ');
            stream.button({ command: 'cachly.setup', title: 'Connect Brain' });
            return {};
        }
        if (!(0, config_1.isValidApiKey)(apiKey)) {
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
            stream.markdown(`### 🧠 Brain status: \`${h.status}\`\n\n` +
                `- **Lessons:** ${h.lessons}\n` +
                `- **Contexts:** ${h.contexts}\n` +
                `- **Total recalls:** ${h.totalRecalls}\n` +
                `- **Tier:** ${h.tier}\n` +
                (h.estimatedCostSaved > 0 ? `- **Est. cost saved:** $${h.estimatedCostSaved.toFixed(2)}\n` : '') +
                (h.lastSession ? `- **Last session:** ${h.lastSession}\n` : ''));
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
            }
            catch (e) {
                stream.markdown(`✗ Couldn't save: ${e.message}`);
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
            });
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
            const preview = (s) => {
                let t = (s ?? '').replace(/\s+/g, ' ').trim();
                try {
                    t = decodeURIComponent(t);
                }
                catch { /* leave as-is if not valid */ }
                t = t.replace(/[`*_#>|]/g, ''); // strip markdown control chars
                return t.length > 140 ? t.slice(0, 140).trimEnd() + '…' : t;
            };
            stream.markdown(`🧠 **${lessons.length}** lesson${lessons.length === 1 ? '' : 's'} for **${query}**\n\n`);
            for (const l of lessons) {
                const body = preview(l.what_worked);
                stream.markdown(`- **${l.topic}** _(${l.outcome})_${body ? ` — ${body}` : ''}\n`);
            }
            if (more > 0) {
                stream.markdown(`\n_+${more} more in your Brain._`);
            }
        }
        catch (e) {
            stream.markdown(`✗ Recall failed: ${e.message}`);
        }
        return {};
    };
    try {
        const participant = chatApi.createChatParticipant('cachly.brain', handler);
        participant.iconPath = new vscode.ThemeIcon('lightbulb');
        context.subscriptions.push(participant);
        log('@cachly chat participant registered');
    }
    catch (e) {
        log('Failed to register @cachly chat participant', e.message);
    }
}
// ── Session recall ────────────────────────────────────────────────────────────
async function triggerSessionRecall() {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    const baseUrl = apiBaseUrl(config);
    if (!(0, config_1.isValidApiKey)(apiKey) || !instanceId)
        return;
    try {
        await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/recall`, apiKey, { source: 'vscode' });
    }
    catch { /* non-critical */ }
}
// ── Save Lesson command ───────────────────────────────────────────────────────
// Modes (cachly.lessonSaveMode):
//   auto    – save immediately, no prompts (uses prefill data or empty defaults)
//   confirm – one notification: [Save] [Edit] [Skip]   ← default
//   manual  – full 3-step form (topic → description → outcome)
async function saveLessonCommand(prefillTopic, prefillWhatWorked) {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    const baseUrl = apiBaseUrl(config);
    const saveMode = config.get('lessonSaveMode', 'confirm');
    // ── Helper: persist a lesson (online first, offline fallback) ─────────────
    const persistLesson = async (topic, whatWorked, outcome) => {
        const source = prefillTopic ? 'vscode-ambient' : 'vscode-manual';
        const authorName = config.get('authorName', '');
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
            }
            catch {
                // API unreachable — fall through to offline queue
            }
        }
        // Offline fallback (no Brain connected, or API temporarily down)
        enqueueOfflineLesson({ topic, outcome, what_worked: whatWorked, source, savedAt: Date.now() });
        const queue = extensionContext.globalState.get(OFFLINE_QUEUE_KEY, []);
        if (!apiKey || !instanceId) {
            void vscode.window.showWarningMessage(`🧠 Lesson queued offline (${queue.length} total). Connect a Brain to sync it.`, 'Connect Brain').then(c => { if (c === 'Connect Brain')
                void setupAICommand(); });
        }
        else {
            vscode.window.showInformationMessage(`🧠 Lesson queued offline (${queue.length} total). Will retry automatically.`);
        }
    };
    // ── Helper: collect all fields via full form ──────────────────────────────
    const collectManual = async () => {
        const topic = await vscode.window.showInputBox({
            prompt: 'Lesson topic (e.g. deploy:k8s-timeout)',
            value: prefillTopic ?? '',
            placeHolder: 'category:keyword',
        });
        if (!topic)
            return undefined;
        const whatWorked = await vscode.window.showInputBox({
            prompt: 'What worked? (short description)',
            value: prefillWhatWorked ?? '',
            placeHolder: 'e.g. Increase readinessProbe.failureThreshold to 10',
        });
        if (!whatWorked)
            return undefined;
        const outcome = await vscode.window.showQuickPick(['success', 'failure', 'partial'], { placeHolder: 'Outcome (default: success)' });
        if (!outcome)
            return undefined;
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
        const action = await vscode.window.showInformationMessage(`🧠 Save Brain lesson "${topic}"? — ${preview}`, 'Save', 'Edit', 'Skip');
        if (!action || action === 'Skip')
            return;
        if (action === 'Edit') {
            const fields = await collectManual();
            if (!fields)
                return;
            await persistLesson(fields.topic, fields.whatWorked, fields.outcome);
            return;
        }
        // Save
        await persistLesson(topic, prefillWhatWorked ?? preview, 'success');
        return;
    }
    // ── manual: full form ─────────────────────────────────────────────────────
    const fields = await collectManual();
    if (!fields)
        return;
    await persistLesson(fields.topic, fields.whatWorked, fields.outcome);
}
// ── CLS: Compiler Learning Stream ────────────────────────────────────────────
async function handleClsDiagnosticsChange(e) {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    const baseUrl = apiBaseUrl(config);
    const instanceId = await getEffectiveInstanceId();
    if (!(0, config_1.isValidApiKey)(apiKey) || !instanceId)
        return;
    const MAX_TRACK = 50; // cap to avoid memory growth
    for (const uri of e.uris) {
        const uriStr = uri.toString();
        const docs = vscode.workspace.textDocuments;
        const doc = docs.find(d => d.uri.toString() === uriStr);
        const langId = doc?.languageId ?? uri.path.split('.').pop() ?? 'unknown';
        const currentDiags = vscode.languages.getDiagnostics(uri)
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        const currentKeys = new Set(currentDiags.map(d => {
            const c = d.code;
            const codeStr = c === undefined ? '' : typeof c === 'object' ? String(c.value) : String(c);
            return `${uriStr}::${codeStr}::${d.message.slice(0, 40)}`;
        }));
        // Add newly appeared errors to tracking map
        for (const diag of currentDiags) {
            if (clsActiveErrors.size >= MAX_TRACK)
                break;
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
        const disappeared = [];
        for (const [key, tracked] of clsActiveErrors) {
            if (tracked.uri === uriStr && !currentKeys.has(key)) {
                disappeared.push(tracked);
                clsActiveErrors.delete(key);
            }
        }
        // Only auto-learn if: the file was recently edited (within 60s) AND error lived ≥ 2s
        const editedThisFile = clsLastEditedUri === uriStr && (Date.now() - clsLastEditTime) < 60000;
        if (!editedThisFile || disappeared.length === 0)
            continue;
        for (const diag of disappeared) {
            // Only save if the error was alive for at least 2 seconds (not a transient parse flicker)
            if (Date.now() - diag.appearedAt < 2000)
                continue;
            const codeStr = diag.code;
            const topic = `fix:${diag.languageId}${codeStr ? `-${codeStr}` : ''}`;
            const fileName = uriStr.split('/').pop() ?? uriStr;
            const whatWorked = `Fixed "${diag.message.slice(0, 100)}" in ${fileName} after edit`;
            try {
                const clsAuthorName = vscode.workspace.getConfiguration('cachly').get('authorName', '');
                await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/learn`, apiKey, {
                    topic,
                    outcome: 'success',
                    what_worked: whatWorked,
                    context: codeStr ? `${diag.source ?? diag.languageId} error ${codeStr}: ${diag.message.slice(0, 200)}` : diag.message.slice(0, 200),
                    severity: 'minor',
                    tags: ['cls', 'compiler', diag.languageId, diag.source ?? ''].filter(Boolean),
                    source: 'vscode-cls',
                    ...(clsAuthorName ? { author: clsAuthorName } : {}),
                });
                trackVSCodeEvent('vscode_cls_lesson_saved', { apiKey, instanceId, once: true });
            }
            catch {
                // Network or auth failure — queue locally for later sync
                enqueueOfflineLesson({
                    topic, outcome: 'success', what_worked: whatWorked,
                    context: codeStr ? `${diag.source ?? diag.languageId} error ${codeStr}: ${diag.message.slice(0, 200)}` : diag.message.slice(0, 200),
                    severity: 'minor', tags: ['cls', 'compiler', diag.languageId],
                    source: 'vscode-cls', savedAt: Date.now(),
                });
            }
        }
    }
}
// ── Ambient Learning ──────────────────────────────────────────────────────────
function handleAmbientEdit(e) {
    for (const change of e.contentChanges) {
        const added = change.text.trim();
        if (added.length < 15 || /^[\s{}()[\];,]+$/.test(added))
            continue;
        const uri = e.document.uri.toString();
        const entry = ambientMap.get(uri) ?? { sampleEdit: '', count: 0, prompted: false };
        if (entry.prompted)
            continue;
        if (entry.sampleEdit && diceSimilarity(added, entry.sampleEdit) > 0.6) {
            entry.count++;
            if (entry.count >= 3) {
                entry.prompted = true;
                ambientMap.set(uri, entry);
                promptAmbientLesson(e.document, entry.sampleEdit);
                return;
            }
        }
        else if (added.length > entry.sampleEdit.length) {
            entry.sampleEdit = added;
            entry.count = 1;
        }
        ambientMap.set(uri, entry);
    }
}
async function promptAmbientLesson(doc, sample) {
    const fileName = doc.fileName.split('/').pop() ?? doc.fileName;
    const suggestedTopic = inferTopic(doc.fileName, sample);
    const action = await vscode.window.showInformationMessage(`🧠 You've typed a similar pattern 3× in ${fileName}. Save as a Brain lesson?`, 'Save Lesson', 'Not now');
    if (action === 'Save Lesson') {
        saveLessonCommand(suggestedTopic, sample);
    }
}
function inferTopic(filePath, _sample) {
    const lower = filePath.toLowerCase();
    if (lower.includes('deploy') || lower.includes('docker') || lower.includes('k8s'))
        return 'deploy:';
    if (lower.includes('auth') || lower.includes('login'))
        return 'auth:';
    if (lower.includes('api') || lower.includes('route') || lower.includes('handler'))
        return 'api:';
    if (lower.includes('test') || lower.includes('spec'))
        return 'test:';
    if (lower.includes('db') || lower.includes('schema') || lower.includes('migrat'))
        return 'db:';
    return 'code:';
}
function diceSimilarity(a, b) {
    if (a === b)
        return 1.0;
    if (a.length < 2 || b.length < 2)
        return 0.0;
    const aBigrams = new Set();
    for (let i = 0; i < a.length - 1; i++)
        aBigrams.add(a.slice(i, i + 2));
    let match = 0;
    for (let i = 0; i < b.length - 1; i++) {
        if (aBigrams.has(b.slice(i, i + 2)))
            match++;
    }
    return (2 * match) / (a.length - 1 + b.length - 1);
}
// ── Git-root detection ────────────────────────────────────────────────────────
async function findGitRoot(filePath) {
    let dir = path.dirname(filePath);
    const root = path.parse(dir).root;
    while (dir !== root) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, '.git')));
            return dir;
        }
        catch { /* not found, go up */ }
        dir = path.dirname(dir);
    }
    return undefined;
}
async function getEffectiveInstanceId() {
    const config = vscode.workspace.getConfiguration('cachly');
    const globalId = config.get('instanceId', '');
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri)
        return globalId;
    // Multi-root workspace: VS Code scopes settings per folder automatically
    const wsFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (wsFolder) {
        const folderConfig = vscode.workspace.getConfiguration('cachly', wsFolder.uri);
        const folderId = folderConfig.get('instanceId', '');
        if (folderId && folderId !== globalId)
            return folderId;
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
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(gitRoot, '.vscode', 'settings.json')));
            const parsed = (0, config_1.parseJsonc)(Buffer.from(raw).toString('utf8'));
            const id = parsed['cachly.instanceId'];
            if (typeof id === 'string' && id) {
                const m = extensionContext.globalState.get('gitRootInstanceMap', {});
                if (m[gitRoot] !== id) {
                    m[gitRoot] = id;
                    void extensionContext.globalState.update('gitRootInstanceMap', m);
                    log(`instanceId resolved from git-root settings.json: ${id} (was cached: ${m[gitRoot] ?? 'none'})`);
                }
                return id;
            }
        }
        catch (e) {
            log('could not read/parse git-root .vscode/settings.json', e.message);
        }
        // Fallback: use the cached mapping only when the file is unreadable/missing.
        // But NEVER let a cached id override a valid global setting that differs —
        // that's how a stale/foreign id used to stick (→ 404 / OFFLINE).
        const mapping = extensionContext.globalState.get('gitRootInstanceMap', {});
        const cached = mapping[gitRoot];
        if (cached) {
            if (globalId && (0, config_1.isValidInstanceId)(globalId) && cached !== globalId) {
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
async function silentAutoSetup(context) {
    const config = vscode.workspace.getConfiguration('cachly');
    const BASE_URL = apiBaseUrl(config);
    // Re-check inside the timeout — another activation path may have filled them already.
    // Use isValidApiKey so a malformed/partial key from a race doesn't count as "done".
    const existingKey = config.get('apiKey', '');
    if ((0, config_1.isValidApiKey)(existingKey) && config.get('instanceId', ''))
        return true;
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
            const trialResp = await apiPostAnon(`${BASE_URL}/auth/instant-trial`, {});
            if (trialResp?.api_key) {
                apiKey = trialResp.api_key;
                instanceId = trialResp.instance_id ?? '';
                isTrial = true;
                await config.update('trialExpiresAt', trialResp.expires_at, vscode.ConfigurationTarget.Global);
            }
        }
        catch { /* offline — caller will show onboarding wizard */ }
    }
    if (!apiKey)
        return false; // Both methods failed
    // ── 3. Write API key ─────────────────────────────────────────────────────
    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
    // ── 4. Auto-provision Brain instance (if not returned by auth step) ──────
    if (!instanceId) {
        try {
            const autoData = await apiPost(`${BASE_URL}/api/v1/instances/auto`, apiKey, {});
            instanceId = autoData?.instance?.id ?? autoData?.instance_id ?? '';
        }
        catch { /* non-fatal — instance will be provisioned on next call */ }
    }
    if (instanceId) {
        await config.update('instanceId', instanceId, vscode.ConfigurationTarget.Global);
    }
    // ── 5. Write workspace files (.mcp.json, copilot-instructions.md, settings) ──
    if (instanceId) {
        try {
            await writeWorkspaceFiles(BASE_URL, apiKey, instanceId);
        }
        catch { /* non-fatal */ }
    }
    // ── 6. Track + notify ─────────────────────────────────────────────────────
    if (githubLogin) {
        trackVSCodeEvent('vscode_github_linked', { apiKey, instanceId, once: true });
        void vscode.window.showInformationMessage(`🧠 Brain connected via GitHub @${githubLogin} — permanent memory active! Restart your AI tool to begin.`, 'Show Brain', 'Dismiss').then(a => { if (a === 'Show Brain')
            showBrainHealthPanel(); });
    }
    else if (isTrial) {
        trackVSCodeEvent('vscode_trial_started', { apiKey, instanceId, once: true });
        void vscode.window.showInformationMessage('🧠 14-day free Brain trial started! Restart your AI tool (Copilot, Claude, Cursor…) to activate memory.', 'Link Account', 'Later').then(async (choice) => {
            if (choice === 'Link Account')
                await linkAccountCommand();
        });
    }
    // Mark onboarding done so the fallback wizard doesn't appear redundantly
    void context.globalState.update('onboardingShown', true);
    // Restart refresh loop, flush offline lessons, trigger recall + framework detection
    startRefreshLoop();
    void flushOfflineQueue();
    triggerSessionRecall();
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
async function tryGitHubSilentAuth(baseUrl) {
    try {
        const session = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
        if (!session?.accessToken)
            return null;
        const resp = (await apiPostAnon(`${baseUrl}/auth/github-vscode`, {
            github_token: session.accessToken,
        }));
        if (!resp?.api_key)
            return null;
        return {
            apiKey: resp.api_key,
            instanceId: resp.instance_id,
            githubLogin: resp.github_login ?? session.account?.label ?? 'user',
        };
    }
    catch {
        // No GitHub session available, network glitch, etc. — caller falls back.
        return null;
    }
}
async function setupAICommand() {
    const config = vscode.workspace.getConfiguration('cachly');
    const BASE_URL = apiBaseUrl(config);
    trackVSCodeEvent('vscode_setup_started', { once: true });
    // If already wired up, confirm before re-configuring
    const existingKey = config.get('apiKey', '');
    const existingInstance = await getEffectiveInstanceId();
    if (existingKey && existingInstance) {
        const action = await vscode.window.showInformationMessage('🧠 Cachly Brain is already connected to this workspace. Reconnect with a different account?', 'Reconnect', 'Cancel');
        if (action !== 'Reconnect')
            return;
    }
    let token = '';
    // ── Step 0a: GitHub silent auth (TRULY zero-click) ────────────────────────
    // If the user is already signed into GitHub in VS Code (true for ~95% of devs),
    // we obtain an OAuth token silently — no browser popup, no permission dialog —
    // and exchange it for a *real* (non-trial) cachly key + Brain instance.
    // This gives them a permanent account from minute 1, no "Link Account" needed.
    let apiKey = config.get('apiKey', '');
    if (!apiKey) {
        const ghKey = await tryGitHubSilentAuth(BASE_URL);
        if (ghKey) {
            apiKey = ghKey.apiKey;
            await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
            if (ghKey.instanceId) {
                await config.update('instanceId', ghKey.instanceId, vscode.ConfigurationTarget.Global);
            }
            trackVSCodeEvent('vscode_github_linked', { apiKey, instanceId: ghKey.instanceId ?? '', once: true });
            void vscode.window.showInformationMessage(`🧠 Cachly Brain connected via GitHub @${ghKey.githubLogin}. Your AI now has permanent memory — no expiry, no upgrade needed.`);
            token = apiKey;
            await finishSetup(token, BASE_URL);
            return;
        }
    }
    if (!apiKey) {
        let trialResp = null;
        try {
            trialResp = await apiPostAnon(`${BASE_URL}/auth/instant-trial`, {});
        }
        catch { /* fallback to device flow */ }
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
            void vscode.window.showInformationMessage('🧠 Cachly Brain: 14-day free trial started! Link your account to keep data permanently.', 'Link Account', 'Later').then(async (choice) => {
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
        let deviceResp = null;
        try {
            deviceResp = await apiPostAnon(`${BASE_URL}/auth/device`, {});
        }
        catch {
            // Fallback: let user paste key manually if device flow endpoint is unreachable.
        }
        if (deviceResp?.device_code) {
            // 1b. Open browser to approval page with the code pre-filled.
            const approvalUrl = `${deviceResp.verification_uri}?code=${deviceResp.user_code}`;
            void vscode.env.openExternal(vscode.Uri.parse(approvalUrl));
            // 1c. Poll in background while showing progress notification.
            const obtained = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `🧠 Cachly Brain Setup — enter code  ${deviceResp.user_code}  at cachly.dev/device`,
                cancellable: true,
            }, async (_progress, cancelToken) => {
                const { device_code } = deviceResp;
                for (let i = 0; i < 120; i++) {
                    if (cancelToken.isCancellationRequested)
                        return null;
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        const poll = await apiPostAnon(`${BASE_URL}/auth/device/token`, { device_code });
                        if (poll?.access_token)
                            return poll.access_token;
                        if (poll?.error === 'expired_token' || poll?.error === 'access_denied')
                            return null;
                        // 'authorization_pending' → keep polling
                    }
                    catch { /* network glitch – keep polling */ }
                }
                return null; // timed out after 10 min
            });
            if (!obtained) {
                vscode.window.showWarningMessage('Cachly: setup cancelled or timed out.');
                return;
            }
            apiKey = obtained;
            await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        }
        else {
            // Device flow unavailable — retry instant-trial once more (covers transient API restart),
            // then open dashboard as last resort. No paste-box: users should never need to copy keys.
            await new Promise((r) => setTimeout(r, 2000));
            let retryResp = null;
            try {
                retryResp = await apiPostAnon(`${BASE_URL}/auth/instant-trial`, {});
            }
            catch { /* ignore */ }
            if (retryResp?.api_key) {
                apiKey = retryResp.api_key;
                await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
                if (retryResp.expires_at)
                    await config.update('trialExpiresAt', retryResp.expires_at, vscode.ConfigurationTarget.Global);
                if (retryResp.instance_id)
                    await config.update('instanceId', retryResp.instance_id, vscode.ConfigurationTarget.Global);
                token = apiKey;
                await finishSetup(token, BASE_URL);
                return;
            }
            // Both instant-trial and device flow unavailable → open dashboard.
            void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/dashboard'));
            void vscode.window.showWarningMessage('🧠 Cachly Brain: Auto-setup temporarily unavailable. Copy your API key from the dashboard and paste it in Settings → cachly.apiKey.', 'Open Dashboard').then((a) => { if (a === 'Open Dashboard')
                void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/dashboard')); });
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
    let deviceResp = null;
    try {
        deviceResp = await apiPostAnon(`${BASE_URL}/auth/device`, {});
    }
    catch { /* show manual fallback */ }
    if (!deviceResp?.device_code) {
        void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/dashboard'));
        return;
    }
    const approvalUrl = `${deviceResp.verification_uri}?code=${deviceResp.user_code}`;
    void vscode.env.openExternal(vscode.Uri.parse(approvalUrl));
    const obtained = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `🧠 Cachly: enter code  ${deviceResp.user_code}  at cachly.dev/device to link your account`,
        cancellable: true,
    }, async (_progress, cancelToken) => {
        const { device_code } = deviceResp;
        for (let i = 0; i < 120; i++) {
            if (cancelToken.isCancellationRequested)
                return null;
            await new Promise((r) => setTimeout(r, 5000));
            try {
                const poll = await apiPostAnon(`${BASE_URL}/auth/device/token`, { device_code });
                if (poll?.access_token)
                    return poll.access_token;
                if (poll?.error === 'expired_token' || poll?.error === 'access_denied')
                    return null;
            }
            catch { /* keep polling */ }
        }
        return null;
    });
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
    void vscode.window.showInformationMessage('🧠 cachly: signed out. Run "Cachly: Connect Brain" to reconnect.', 'Connect now').then(a => { if (a === 'Connect now')
        void vscode.commands.executeCommand('cachly.setup'); });
}
async function showAuthErrorAndOfferReset(reason) {
    const choice = await vscode.window.showWarningMessage(`🧠 cachly: ${reason} Sign out and reconnect to fix it.`, 'Sign out & reconnect', 'Sign out', 'Cancel');
    if (choice === 'Sign out & reconnect') {
        await resetAuthCommand();
        void vscode.commands.executeCommand('cachly.setup');
    }
    else if (choice === 'Sign out') {
        await resetAuthCommand();
    }
}
async function finishSetup(token, baseUrl) {
    const config = vscode.workspace.getConfiguration('cachly');
    // Exchange short-lived Keycloak JWT → long-lived cky_live_ API key
    if (token.startsWith('eyJ')) {
        try {
            const keyRes = await apiPost(`${baseUrl}/api/v1/api-keys`, token, {
                name: 'cachly-vscode', scope: 'read_write',
            });
            if (keyRes?.key)
                token = keyRes.key;
        }
        catch (e) {
            if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
                await showAuthErrorAndOfferReset('Sign-in expired while exchanging your token.');
                return;
            }
            /* transient — fall back to JWT directly */
        }
    }
    await config.update('apiKey', token, vscode.ConfigurationTarget.Global);
    let instanceId = config.get('instanceId', '');
    let alreadyRunning = false;
    try {
        const autoData = await apiPost(`${baseUrl}/api/v1/instances/auto`, token, {});
        if (autoData?.instance?.id) {
            // Existing instance — use its id directly
            instanceId = autoData.instance.id;
            alreadyRunning = autoData.instance.status === 'running';
        }
        else if (autoData?.instance_id) {
            // Newly provisioned — id returned from creation
            instanceId = autoData.instance_id;
        }
    }
    catch (e) {
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
                    void vscode.window.showInformationMessage('🧠 cachly: Setup cancelled. Your Brain is still starting — MCP will connect automatically once it\'s ready.');
                    return;
                }
                await new Promise(r => setTimeout(r, 3000));
                const elapsed = Math.round((i + 1) * 3);
                const remaining = Math.max(0, maxAttempts * 3 - elapsed);
                progress.report({ message: `${elapsed}s elapsed — free tier takes up to 3 min on cold start (${remaining}s remaining)` });
                try {
                    if (instanceId) {
                        // Fast path: poll the single-instance endpoint directly
                        const inst = await apiGet(`${baseUrl}/api/v1/instances/${instanceId}`, token);
                        if (inst?.status === 'running') {
                            instanceStillProvisioning = false;
                            return;
                        }
                    }
                    else {
                        // Fallback: scan the list for any active instance
                        const data = await apiGet(`${baseUrl}/api/v1/instances`, token);
                        const instances = data?.data ?? [];
                        const running = instances.find(inst => inst.status === 'running');
                        if (running) {
                            instanceId = running.id;
                            instanceStillProvisioning = false;
                            return;
                        }
                        // Capture provisioning instance ID even if not yet running —
                        // we still write the configs so the MCP server can connect once ready.
                        if (!instanceId) {
                            const provisioning = instances.find(inst => inst.status === 'provisioning' || inst.status === 'starting' || inst.status === 'pending_payment');
                            if (provisioning) {
                                instanceId = provisioning.id;
                            }
                        }
                    }
                }
                catch (e) {
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
        void vscode.window.showWarningMessage('🧠 cachly: Could not reach your Brain. Check your connection and run "Cachly: Connect Brain" again.', 'Retry').then(a => { if (a === 'Retry')
            void vscode.commands.executeCommand('cachly.setup'); });
        return;
    }
    if (instanceStillProvisioning) {
        // Write configs now so the MCP server is ready to connect as soon as the Brain starts.
        // Show a non-blocking toast — user can continue coding.
        void vscode.window.showInformationMessage('🧠 cachly: Your Brain is still starting up (free tier cold-start ~2 min). MCP will connect automatically — keep coding!');
    }
    // Write workspace configs (.mcp.json, copilot-instructions.md, .vscode/settings.json)
    try {
        await writeWorkspaceFiles(baseUrl, token, instanceId);
    }
    catch { /* non-fatal */ }
    await config.update('instanceId', instanceId, vscode.ConfigurationTarget.Workspace);
    trackVSCodeEvent('vscode_setup_completed', { instanceId, once: true });
    if (!instanceStillProvisioning) {
        const action = await vscode.window.showInformationMessage(`🧠 Brain connected! Your AI now has persistent memory. Restart your AI tool to activate.`, 'Show Brain', 'Dismiss');
        if (action === 'Show Brain')
            showBrainHealthPanel();
    }
    updateStatusBar();
}
function buildCopilotInstructions(instanceId) {
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
async function writeFileContent(filePath, content) {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(content, 'utf8'));
}
/**
 * Write .mcp.json, .github/copilot-instructions.md, and .vscode/settings.json
 * for the current workspace / git-root. Idempotent — safe to call multiple times.
 * Called from silentAutoSetup (background), finishSetup (manual wizard), and
 * checkMcpSetupAndNudge (catch-all safety net).
 */
async function writeWorkspaceFiles(baseUrl, apiKey, instanceId) {
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const gitRoot = activeFile ? await findGitRoot(activeFile) : undefined;
    const targetRoot = gitRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!targetRoot)
        return;
    // .mcp.json — merge cachly entry; preserve all other MCP servers the user has configured
    const mcpPath = path.join(targetRoot, '.mcp.json');
    let mcpJson = {};
    try {
        const rawMcp = await vscode.workspace.fs.readFile(vscode.Uri.file(mcpPath));
        mcpJson = (0, config_1.parseJsonc)(Buffer.from(rawMcp).toString('utf8'));
    }
    catch { /* new file or invalid JSON — start fresh */ }
    if (!mcpJson.mcpServers)
        mcpJson.mcpServers = {};
    mcpJson.mcpServers['cachly'] = {
        command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'],
        env: { CACHLY_API_URL: baseUrl, CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId },
    };
    await writeFileContent(mcpPath, JSON.stringify(mcpJson, null, 2));
    // Instruction files — write the SAME marked block to CLAUDE.md (Claude Code),
    // AGENTS.md (Codex/other agents) and .github/copilot-instructions.md (Copilot)
    // so every AI tool a user has gets the full lifecycle protocol. Marker-based +
    // idempotent: we replace only our section and never wipe the user's content.
    const BRAIN_START = '<!-- cachly-brain-start -->';
    const BRAIN_END = '<!-- cachly-brain-end -->';
    const brainBlock = `${BRAIN_START}\n${buildCopilotInstructions(instanceId)}${BRAIN_END}`;
    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(targetRoot, '.github')));
    }
    catch { /* exists */ }
    const instructionTargets = [
        path.join(targetRoot, 'CLAUDE.md'),
        path.join(targetRoot, 'AGENTS.md'),
        path.join(targetRoot, '.github', 'copilot-instructions.md'),
    ];
    for (const instructionsPath of instructionTargets) {
        let existingInstructions = '';
        try {
            const rawInstr = await vscode.workspace.fs.readFile(vscode.Uri.file(instructionsPath));
            existingInstructions = Buffer.from(rawInstr).toString('utf8');
        }
        catch { /* new file */ }
        let newInstructions;
        if (existingInstructions.includes(BRAIN_START) && existingInstructions.includes(BRAIN_END)) {
            // Replace only our section between the markers; everything else stays
            const before = existingInstructions.substring(0, existingInstructions.indexOf(BRAIN_START));
            const after = existingInstructions.substring(existingInstructions.indexOf(BRAIN_END) + BRAIN_END.length);
            newInstructions = before + brainBlock + after;
        }
        else if (existingInstructions.trim().length > 0) {
            // File has existing user content — append our section
            newInstructions = existingInstructions.trimEnd() + '\n\n' + brainBlock + '\n';
        }
        else {
            newInstructions = brainBlock + '\n';
        }
        await writeFileContent(instructionsPath, newInstructions);
    }
    // .vscode/settings.json — bind instance to this git root
    const vsDir = path.join(targetRoot, '.vscode');
    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(vsDir));
    }
    catch { /* exists */ }
    const settingsPath = path.join(vsDir, 'settings.json');
    let existing = {};
    let settingsReadOk = true;
    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath));
        // JSONC-tolerant: plain JSON.parse throws on comments/trailing commas, which
        // would reset `existing` to {} and WIPE the user's entire settings.json.
        existing = (0, config_1.parseJsonc)(Buffer.from(raw).toString('utf8'));
    }
    catch (e) {
        // Distinguish "file doesn't exist" (fine) from "file exists but unparseable"
        // (must NOT overwrite — that would destroy the user's settings).
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(settingsPath));
            settingsReadOk = false; // exists but couldn't parse → leave it alone
            log('settings.json exists but could not be parsed — not overwriting', e.message);
        }
        catch { /* truly new file */ }
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
    const clsKey = vscode.workspace.getConfiguration('cachly').get('apiKey', '');
    await installClsHook(targetRoot, instanceId, clsKey || undefined);
    // CI scaffold — auto-detect GitHub vs GitLab from the origin remote and write
    // the matching config (GitHub Action workflow or GitLab include). Idempotent.
    await writeCiConfig(targetRoot, instanceId);
    const m = extensionContext.globalState.get('gitRootInstanceMap', {});
    m[targetRoot] = instanceId;
    void extensionContext.globalState.update('gitRootInstanceMap', m);
}
/**
 * Install the CLS git post-commit hook. Kept in sync with the MCP autopilot
 * (sdk/mcp/src/index.ts). Idempotent: skips if our marker is already present,
 * appends if another hook exists, creates+chmods otherwise. Never throws.
 */
async function installClsHook(targetRoot, instanceId, apiKey) {
    try {
        const gitDir = path.join(targetRoot, '.git');
        if (!fs.existsSync(gitDir))
            return; // not a git repo (or a worktree file — skip)
        const hookDir = path.join(gitDir, 'hooks');
        const hookPath = path.join(hookDir, 'post-commit');
        await fs.promises.mkdir(hookDir, { recursive: true });
        const hookScript = (0, config_1.buildClsPostCommitHook)(instanceId, apiKey);
        let existingHook = '';
        try {
            existingHook = await fs.promises.readFile(hookPath, 'utf8');
        }
        catch { /* no existing hook */ }
        if (!existingHook) {
            await fs.promises.writeFile(hookPath, hookScript + '\n', 'utf8');
            try {
                await fs.promises.chmod(hookPath, 0o755);
            }
            catch { /* Windows: chmod is a no-op */ }
            log('Installed CLS hook at .git/hooks/post-commit');
            return;
        }
        if (existingHook.includes(`cachly CLS — Continuous Learning Stream ${config_1.CLS_HOOK_VERSION}`)) {
            log('CLS hook already current in .git/hooks/post-commit');
            return;
        }
        // Matches any prior cachly block (marker → exit 0), optionally its shebang —
        // so old/broken v1 hooks are upgraded in place rather than skipped forever.
        const oldBlock = /(?:#!\/bin\/sh\n)?# cachly CLS[\s\S]*?\nexit 0\n?/;
        if (oldBlock.test(existingHook)) {
            const replaced = existingHook.replace(oldBlock, hookScript);
            await fs.promises.writeFile(hookPath, replaced.endsWith('\n') ? replaced : replaced + '\n', 'utf8');
            try {
                await fs.promises.chmod(hookPath, 0o755);
            }
            catch { /* no-op on Windows */ }
            log('Upgraded CLS hook in .git/hooks/post-commit');
            return;
        }
        // Foreign hook with no cachly block → append ours.
        await fs.promises.writeFile(hookPath, existingHook.trimEnd() + '\n\n' + hookScript + '\n', 'utf8');
        log('Appended CLS hook to existing .git/hooks/post-commit');
    }
    catch (e) {
        log('CLS hook install skipped (non-critical)', e.message);
    }
}
/**
 * Detect whether the repo's origin remote points at GitHub or GitLab by reading
 * .git/config. Returns undefined when there's no recognizable remote (so we
 * write nothing rather than guess). Never throws.
 */
async function detectGitRemoteHost(targetRoot) {
    try {
        const cfg = await fs.promises.readFile(path.join(targetRoot, '.git', 'config'), 'utf8');
        const urls = [...cfg.matchAll(/url\s*=\s*(.+)/g)].map(m => m[1].toLowerCase());
        if (urls.some(u => u.includes('gitlab.com') || u.includes('gitlab')))
            return 'gitlab';
        if (urls.some(u => u.includes('github.com') || u.includes('github')))
            return 'github';
    }
    catch { /* no .git/config — not a git repo or unreadable */ }
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
async function writeCiConfig(targetRoot, instanceId) {
    try {
        const host = await detectGitRemoteHost(targetRoot);
        if (!host)
            return;
        if (host === 'github') {
            const wfDir = path.join(targetRoot, '.github', 'workflows');
            const wfPath = path.join(wfDir, 'cachly.yml');
            if (fs.existsSync(wfPath))
                return; // don't clobber an existing workflow
            await fs.promises.mkdir(wfDir, { recursive: true });
            await fs.promises.writeFile(wfPath, buildGithubWorkflow(instanceId), 'utf8');
            log('Wrote .github/workflows/cachly.yml');
            return;
        }
        // GitLab — merge an include into .gitlab-ci.yml (create if absent).
        const ciPath = path.join(targetRoot, '.gitlab-ci.yml');
        let existing = '';
        try {
            existing = await fs.promises.readFile(ciPath, 'utf8');
        }
        catch { /* new file */ }
        if (existing.includes(CI_BRAIN_MARKER))
            return; // already wired
        const block = buildGitlabInclude(instanceId);
        const merged = existing.trim().length > 0 ? existing.trimEnd() + '\n\n' + block : block;
        await fs.promises.writeFile(ciPath, merged, 'utf8');
        log('Wired Cachly Brain into .gitlab-ci.yml');
    }
    catch (e) {
        log('CI config write skipped (non-critical)', e.message);
    }
}
function buildGithubWorkflow(instanceId) {
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
function buildGitlabInclude(instanceId) {
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
async function detectAndSuggestFrameworks(context) {
    const config = vscode.workspace.getConfiguration('cachly');
    if (!config.get('apiKey') || !config.get('instanceId'))
        return;
    // Only run once per workspace
    const wsKey = `frameworkDetected:${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''}`;
    if (context.workspaceState.get(wsKey, false))
        return;
    const frameworks = [];
    const suggestions = [];
    // package.json
    try {
        const pkgFiles = await vscode.workspace.findFiles('package.json', '**/node_modules/**', 1);
        if (pkgFiles.length > 0) {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(pkgFiles[0])).toString();
            const pkg = JSON.parse(raw);
            const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
            if (deps['next']) {
                frameworks.push('Next.js');
                suggestions.push('deploy:nextjs', 'api:routes');
            }
            if (deps['react']) {
                frameworks.push('React');
                suggestions.push('code:react');
            }
            if (deps['vue']) {
                frameworks.push('Vue.js');
                suggestions.push('code:vue');
            }
            if (deps['@nestjs/core']) {
                frameworks.push('NestJS');
                suggestions.push('api:nestjs');
            }
            if (deps['express']) {
                frameworks.push('Express');
                suggestions.push('api:express');
            }
            if (deps['fastify']) {
                frameworks.push('Fastify');
                suggestions.push('api:fastify');
            }
            if (deps['langchain']) {
                frameworks.push('LangChain JS');
                suggestions.push('ai:langchain');
            }
            if (deps['openai']) {
                frameworks.push('OpenAI JS');
                suggestions.push('ai:openai');
            }
        }
    }
    catch { /* no package.json */ }
    // go.mod
    try {
        const goFiles = await vscode.workspace.findFiles('go.mod', undefined, 1);
        if (goFiles.length > 0) {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(goFiles[0])).toString();
            if (raw.includes('gin-gonic')) {
                frameworks.push('Gin');
                suggestions.push('api:gin');
            }
            if (raw.includes('gofiber')) {
                frameworks.push('Fiber');
                suggestions.push('api:fiber');
            }
            if (raw.includes('google.golang.org/grpc')) {
                frameworks.push('gRPC');
                suggestions.push('api:grpc');
            }
            if (raw.includes('langchain')) {
                frameworks.push('LangChain Go');
                suggestions.push('ai:langchain');
            }
        }
    }
    catch { /* no go.mod */ }
    // requirements.txt / pyproject.toml
    try {
        const pyFiles = await vscode.workspace.findFiles('{requirements*.txt,pyproject.toml}', undefined, 3);
        for (const f of pyFiles) {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(f)).toString().toLowerCase();
            if (raw.includes('langchain')) {
                frameworks.push('LangChain Python');
                suggestions.push('ai:langchain');
            }
            if (raw.includes('fastapi')) {
                frameworks.push('FastAPI');
                suggestions.push('api:fastapi');
            }
            if (raw.includes('django')) {
                frameworks.push('Django');
                suggestions.push('api:django');
            }
            if (raw.includes('flask')) {
                frameworks.push('Flask');
                suggestions.push('api:flask');
            }
            if (raw.includes('openai')) {
                frameworks.push('OpenAI Python');
                suggestions.push('ai:openai');
            }
        }
    }
    catch { /* no requirements */ }
    if (frameworks.length === 0)
        return;
    await context.workspaceState.update(wsKey, true);
    const unique = [...new Set(frameworks)];
    const action = await vscode.window.showInformationMessage(`🧠 Cachly detected: ${unique.join(', ')}. Load relevant Brain lessons for this stack?`, 'Load Lessons', 'Dismiss');
    if (action === 'Load Lessons') {
        showLessonsPanel();
    }
}
// ── CodeLens Provider ─────────────────────────────────────────────────────────
class CachlyCodeLensProvider {
    async provideCodeLenses(document) {
        const config = vscode.workspace.getConfiguration('cachly');
        if (!config.get('apiKey') || !config.get('instanceId'))
            return [];
        if (!config.get('codeLens', true))
            return [];
        if (!lastHealth || lastHealth.topLessons.length === 0)
            return [];
        const fileName = document.fileName.toLowerCase();
        const relevant = lastHealth.topLessons.filter((l) => {
            const parts = l.topic.toLowerCase().split(':');
            return parts.some((p) => p.length >= 3 && fileName.includes(p));
        });
        if (relevant.length === 0)
            return [];
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
function httpPostForm(url, params) {
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
            res.on('end', () => { try {
                resolve(JSON.parse(data));
            }
            catch {
                resolve(null);
            } });
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
    constructor(status, body) {
        super(`HTTP ${status}`);
        this.status = status;
        this.body = body;
    }
}
function apiGet(url, apiKey) {
    return new Promise((resolve, reject) => {
        const mod = new URL(url).protocol === 'https:' ? https : http;
        const req = mod.get(url, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
            timeout: 5000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                }
                catch { /* empty/non-json body */ }
                const status = res.statusCode ?? 0;
                if (status >= 200 && status < 300) {
                    resolve(parsed);
                    return;
                }
                reject(new HttpError(status, parsed));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}
function apiPost(url, apiKey, body) {
    return new Promise((resolve, reject) => {
        const mod = new URL(url).protocol === 'https:' ? https : http;
        const payload = JSON.stringify(body);
        const req = mod.request(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 5000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                }
                catch { /* empty/non-json body */ }
                const status = res.statusCode ?? 0;
                if (status >= 200 && status < 300) {
                    resolve(parsed);
                    return;
                }
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
const _trackedThisSession = new Set();
function trackVSCodeEvent(event, opts) {
    const { apiKey = '', instanceId = '', once = false } = opts ?? {};
    if (once) {
        if (_trackedThisSession.has(event))
            return;
        _trackedThisSession.add(event);
    }
    const config = vscode.workspace.getConfiguration('cachly');
    const baseUrl = apiBaseUrl(config);
    const effectiveKey = apiKey || config.get('apiKey', '');
    void apiPostAnon(`${baseUrl}/api/v1/telemetry/mcp`, {
        event,
        version: extensionVersion,
        editor: 'vscode',
        source: 'vscode',
        api_key: effectiveKey,
        instance_id: instanceId,
    }).catch(() => { });
}
/** POST without authentication — used for device flow (no API key yet). */
function apiPostAnon(url, body) {
    return new Promise((resolve, reject) => {
        const mod = new URL(url).protocol === 'https:' ? https : http;
        const payload = JSON.stringify(body);
        const req = mod.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 8000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => { try {
                resolve(JSON.parse(data));
            }
            catch {
                resolve(null);
            } });
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
        vscode.window.showInformationMessage('No lessons yet. AI assistants store lessons via learn_from_attempts after fixing bugs.');
        return;
    }
    showInBrainWebview('📖 Cachly Brain — Lessons', buildLessonsHtml(health));
}
function showInBrainWebview(title, html) {
    if (brainPanel) {
        brainPanel.title = title;
        brainPanel.webview.html = wrapHtml(html);
        brainPanel.reveal(vscode.ViewColumn.Beside, true);
    }
    else {
        brainPanel = vscode.window.createWebviewPanel('cachlyBrain', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, retainContextWhenHidden: true });
        brainPanel.webview.html = wrapHtml(html);
        brainPanel.onDidDispose(() => { brainPanel = undefined; });
    }
}
// ── HTML builders ─────────────────────────────────────────────────────────────
function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function buildHealthHtml(health) {
    const statusIcon = health.status === 'healthy' ? '✅ Healthy'
        : health.status === 'empty' ? '🌱 Ready (no lessons yet)'
            : health.status === 'setup_needed' ? '🔐 Re-auth needed'
                : health.status === 'degraded' ? '⚠️ Degraded' : '❌ Unreachable';
    const tokensSaved = fmtTokens(health.estimatedTokensSaved);
    const usedMB = (health.memoryUsedBytes / (1024 * 1024)).toFixed(2);
    const limitMB = (health.memoryLimitBytes / (1024 * 1024)).toFixed(0);
    const pct = health.memoryUsedPct.toFixed(1);
    // Recall progress bar (hero metric)
    const recallLimitLabel = health.recallLimit > 0 ? `${health.recallLimit.toLocaleString()}` : '∞';
    const recallPct = health.recallLimit > 0
        ? Math.min(health.totalRecalls / health.recallLimit * 100, 100)
        : 0;
    const recallFilled = health.recallLimit > 0 ? Math.round(recallPct / 100 * 20) : 0;
    const recallBar = '█'.repeat(recallFilled) + '░'.repeat(20 - recallFilled);
    const recallBarColor = recallPct >= 90 ? 'color:#f87171' : recallPct >= 70 ? 'color:#fb923c' : 'color:#a78bfa';
    // Storage bar (secondary)
    const storageFilled = Math.round(health.memoryUsedPct / 100 * 20);
    const storageBar = '█'.repeat(storageFilled) + '░'.repeat(20 - storageFilled);
    const offlineBanner = health.status === 'unreachable'
        ? `<p style="opacity:.55;font-size:.95em"><s>🧠</s> offline — cannot reach the Cachly API. Check your API key, instance ID, and network.</p>`
        : '';
    const pendingBanner = health.pendingLessons > 0
        ? `<div style="margin:10px 0;padding:10px 14px;background:rgba(251,191,36,.12);border-left:3px solid #fbbf24;border-radius:4px">
        ⏳ <strong>${health.pendingLessons} lesson${health.pendingLessons === 1 ? '' : 's'} saved offline</strong> — not yet counted above.
        They will sync automatically once the Brain is reachable.
       </div>`
        : '';
    // Upgrade nudge when ≥80% of recall limit used
    const upgradeBanner = (health.recallLimit > 0 && recallPct >= 80)
        ? `<div style="margin:12px 0;padding:10px 14px;background:rgba(251,146,60,.12);border-left:3px solid #fb923c;border-radius:4px">
        🚀 <strong>${recallPct.toFixed(0)}% of recall limit used.</strong>
        Upgrade to unlock unlimited recalls and keep your AI running at full speed.
        <a href="https://cachly.dev/billing" style="color:#fb923c">Upgrade →</a>
       </div>`
        : '';
    const topicRows = health.topics.map(t => `<li><code>${esc(t)}</code></li>`).join('');
    const lessonRows = health.topLessons.map(l => {
        const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
        const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟠' : '🟡';
        const worked = esc(l.what_worked.slice(0, 70)) + (l.what_worked.length > 70 ? '…' : '');
        return `<tr><td><code>${esc(l.topic)}</code></td><td>${icon}</td><td>${l.recall_count}</td><td>${sev} ${esc(l.severity ?? '-')}</td><td>${worked}</td></tr>`;
    }).join('');
    const recallLimitRow = health.recallLimit > 0
        ? `<tr><td>Recall Limit</td><td>${health.recallLimit.toLocaleString()} / month <em style="opacity:.6">(upgrade for unlimited)</em></td></tr>`
        : `<tr><td>Recall Limit</td><td>Unlimited ✨</td></tr>`;
    const iqBoostRow = health.iqBoostPct > 0
        ? `<tr><td>📈 IQ Boost</td><td><strong>${health.iqBoostPct.toFixed(0)}%</strong> <em style="opacity:.6">(ratio of tasks handled via Brain vs cold-start)</em></td></tr>`
        : '';
    const configuredAuthor = (vscode.workspace.getConfiguration('cachly').get('authorName') ?? '').trim();
    const teamSection = health.teamAuthors.length >= 1
        ? `<h2>👥 Team Brain Contributors (${health.teamAuthors.length})</h2>
       <p>${health.teamAuthors.map(a => `<code>${esc(a)}</code>`).join(' · ')}</p>
       ${!configuredAuthor ? `<p style="opacity:.7;font-size:.9em">💡 <strong>Set your name</strong> so your lessons show up here: <em>VS Code Settings → <code>cachly.authorName</code></em></p>` : ''}
       <p style="opacity:.7;font-size:.9em">To invite teammates: have them install the <strong>Cachly Brain</strong> extension, set <code>cachly.instanceId</code> to <code>${esc(health.teamAuthors[0] ?? '')}</code> and the same API key.</p>`
        : !configuredAuthor
            ? `<h2>👥 Team Brain</h2><p style="opacity:.7;font-size:.9em">No team lessons yet. <strong>Set your name</strong> to start attributing lessons: <em>VS Code Settings → <code>cachly.authorName</code></em></p>`
            : '';
    const crystalSection = health.crystal
        ? `<h2>💎 Memory Crystal</h2><blockquote>${esc(health.crystal.summary)}</blockquote><p style="opacity:.6;font-size:.9em">Generated ${esc(health.crystal.created_at)} · ${health.crystal.patterns_hit} patterns</p>`
        : '';
    const insightsSection = health.insights
        ? (() => {
            const ins = health.insights;
            const mins = ins.minutes_saved.toFixed(0);
            const dollars = ins.dollars_saved.toFixed(2);
            const reuse = ins.reuse_pct.toFixed(1);
            const ttfr = ins.ttfr_p50_sec > 0 ? `${ins.ttfr_p50_sec.toFixed(0)}s` : '—';
            const curr = ins.currency === 'EUR' ? '€' : ins.currency;
            return `<h2>💰 ROI Summary (this tenant)</h2>
          <table>
            <tr><td>Developer time saved</td><td><strong>${mins} min</strong></td></tr>
            <tr><td>Estimated cost saved</td><td><strong>${curr}${dollars}</strong> <em style="opacity:.6">at ${curr}${ins.hourly_rate}/h</em></td></tr>
            <tr><td>Knowledge reuse</td><td><strong>${reuse}%</strong> <em style="opacity:.6">of recalls cross-author</em></td></tr>
            <tr><td>Time-to-first-recall (p50)</td><td>${ttfr}</td></tr>
          </table>`;
        })()
        : '';
    return `
    ${offlineBanner}
    ${pendingBanner}
    <h1>🧠 Cachly Brain Health</h1>

    ${upgradeBanner}

    <h2>⚡ Recall Activity</h2>
    <p style="font-size:1.1em">
      <span style="${recallBarColor}" class="bar">${recallBar}</span>
      &nbsp;<strong>${health.totalRecalls.toLocaleString()}</strong> / ${recallLimitLabel} recalls
      ${health.recallLimit > 0 ? `<span style="opacity:.6">(${recallPct.toFixed(1)}%)</span>` : ''}
    </p>
    <p style="opacity:.7;font-size:.9em;margin-top:-8px">Each recall = your AI reused a saved lesson instead of re-researching → ${tokensSaved} saved so far</p>

    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Status</td><td>${statusIcon}</td></tr>
      <tr><td>Tier</td><td>${esc(health.tier)}</td></tr>
      <tr><td>Lessons Learned</td><td><strong>${health.lessons}</strong>${health.pendingLessons > 0 ? ` <em style="opacity:.6">+ ${health.pendingLessons} pending sync</em>` : ''}</td></tr>
      <tr><td>Context Entries</td><td>${health.contexts > 0 ? health.contexts : '<span style="opacity:.5">0 — use <code>remember_context</code> to store WIP context</span>'}</td></tr>
      <tr><td>Total Recalls</td><td><strong>${health.totalRecalls.toLocaleString()}</strong></td></tr>
      ${recallLimitRow}
      ${iqBoostRow}
      <tr><td>Tokens Saved</td><td>${tokensSaved}</td></tr>
      ${health.memoryLimitBytes > 0 ? `<tr><td>Storage</td><td><span class="bar">${storageBar}</span> ${usedMB} MB / ${limitMB} MB (${pct}%)</td></tr>` : ''}
      ${health.lastSession ? `<tr><td>Last Session</td><td>${esc(health.lastSession)}</td></tr>` : ''}
    </table>

    <h2>📚 Topics (${health.topics.length})</h2>
    <ul>${topicRows}</ul>

    <h2>🏆 Top Lessons</h2>
    <table>
      <tr><th>Topic</th><th>Outcome</th><th>Recalls</th><th>Severity</th><th>What Worked</th></tr>
      ${lessonRows}
    </table>

    ${insightsSection}
    ${teamSection}
    ${crystalSection}

    <hr/>
    <blockquote>
      💡 <strong>How lessons work:</strong> AI assistants call <code>learn_from_attempts</code> after fixing bugs.
      Each <code>recall_best_solution</code> saves ~1,200 tokens. Your brain currently has <strong>${health.lessons} saved solutions</strong>.
      <br/><br/>
      <strong>Ambient Learning:</strong> Cachly watches for repeated typing patterns and <em>asks</em> whether to save them as a Brain lesson — never saves automatically.
    </blockquote>
  `;
}
function buildLessonsHtml(health) {
    const tokensSaved = fmtTokens(health.estimatedTokensSaved);
    const rows = health.topLessons.map(l => {
        const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
        const date = l.ts ? new Date(l.ts).toLocaleDateString() : 'unknown';
        return `
      <div class="lesson">
        <h2>${icon} <code>${esc(l.topic)}</code></h2>
        <ul>
          <li><strong>Severity:</strong> ${esc(l.severity ?? 'minor')}</li>
          <li><strong>Recalled:</strong> ${l.recall_count} time${l.recall_count !== 1 ? 's' : ''}</li>
          <li><strong>Learned:</strong> ${date}</li>
          <li><strong>What worked:</strong> ${esc(l.what_worked)}</li>
        </ul>
      </div>`;
    }).join('');
    return `
    <h1>📖 Cachly Brain — All Lessons</h1>
    <p>${health.lessons} lessons · ${health.totalRecalls.toLocaleString()} recalls · ${tokensSaved} saved</p>
    ${rows}
    <hr/>
    <blockquote>
      💡 Lessons are created when an AI assistant calls <code>learn_from_attempts()</code> via the Cachly MCP server,
      or when you save one manually via <em>Cachly: Save Lesson</em>.
      Each recall saves ~1,200 tokens by reusing known solutions.
    </blockquote>
  `;
}
function wrapHtml(body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px 32px; max-width: 900px; }
    h1 { font-size: 1.5em; margin-bottom: 12px; }
    h2 { font-size: 1.1em; margin-top: 24px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    td, th { padding: 6px 12px; border: 1px solid var(--vscode-panel-border); text-align: left; }
    th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
    tr:nth-child(even) td { background: var(--vscode-list-hoverBackground); }
    code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    ul { padding-left: 20px; }
    li { margin: 3px 0; }
    .bar { font-family: monospace; letter-spacing: 1px; }
    .lesson { margin-bottom: 20px; }
    hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 20px 0; }
    blockquote { border-left: 3px solid var(--vscode-activityBarBadge-background); padding: 8px 16px; color: var(--vscode-descriptionForeground); margin: 0; background: var(--vscode-textBlockQuote-background); }
  </style>
</head>
<body>${body}</body>
</html>`;
}
// ── MCP setup-detection nudge ─────────────────────────────────────────────────
// If the Brain is connected (apiKey set) but no MCP config found in workspace,
// the user's AI editor isn't actually using the Brain. Show a one-time nudge.
async function checkMcpSetupAndNudge(context) {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    if (!(0, config_1.isValidApiKey)(apiKey))
        return; // Brain not connected (or key malformed) — let auto-onboarding handle it
    const nudgeShown = context.globalState.get('mcpNudgeShown', false);
    if (nudgeShown)
        return;
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
            }
            catch { /* file doesn't exist */ }
        }
    }
    // No MCP config found — auto-write it for zero-friction setup
    await context.globalState.update('mcpNudgeShown', true);
    const instanceId2 = config.get('instanceId', '') || await getEffectiveInstanceId();
    const baseUrl2 = apiBaseUrl(config);
    if (instanceId2) {
        try {
            await writeWorkspaceFiles(baseUrl2, apiKey, instanceId2);
            void vscode.window.showInformationMessage('🧠 cachly: MCP wired to your AI editor! Restart Copilot, Claude Code, or Cursor to activate Brain memory.', 'Show Brain').then(a => { if (a === 'Show Brain')
                showBrainHealthPanel(); });
            return;
        }
        catch { /* non-fatal — fall through to nudge */ }
    }
    void vscode.window.showInformationMessage('🧠 cachly Brain is connected, but your AI editor isn\'t using it yet. Connect Claude Code, Cursor, or Windsurf in 30 seconds.', 'Connect AI Editor', 'Later').then(a => { if (a === 'Connect AI Editor')
        void vscode.env.openExternal(vscode.Uri.parse('https://cachly.dev/setup-ai')); });
}
// ── Quick Recall for current file ─────────────────────────────────────────────
// Command: cachly.recallForFile
// Fetches lessons relevant to the currently open file and shows them in a panel.
async function recallForFileCommand() {
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    const instanceId = await getEffectiveInstanceId();
    const baseUrl = apiBaseUrl(config);
    if (!apiKey || !instanceId) {
        const action = await vscode.window.showWarningMessage('🧠 cachly: Brain not connected. Set up in 30 seconds.', 'Connect Brain');
        if (action === 'Connect Brain')
            void setupAICommand();
        return;
    }
    // Guard against a malformed key that passes the truthy check but would 401 at the API.
    if (!(0, config_1.isValidApiKey)(apiKey))
        return;
    const editor = vscode.window.activeTextEditor;
    const fileName = editor ? path.basename(editor.document.fileName) : '';
    const query = fileName || 'current file';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `🧠 Recalling lessons for ${query}…`, cancellable: false }, async () => {
        try {
            const res = await apiPost(`${baseUrl}/api/v1/instances/${instanceId}/recall`, apiKey, {
                source: 'vscode-file-recall',
                query,
                limit: 10,
            });
            // The /recall endpoint returns `top_lessons` (not `lessons`); keep `lessons`
            // as a fallback in case the API shape changes.
            const lessons = res?.top_lessons ?? res?.lessons ?? [];
            if (lessons.length === 0) {
                void vscode.window.showInformationMessage(`🧠 No lessons found for "${query}" yet. Use cachly.saveLesson to add some!`);
                return;
            }
            // Show results in a webview panel
            const panel = vscode.window.createWebviewPanel('cachlyRecall', `🧠 Brain Recall: ${query}`, vscode.ViewColumn.Beside, { enableScripts: false });
            panel.webview.html = buildRecallHtml(query, lessons);
        }
        catch (e) {
            void vscode.window.showErrorMessage(`🧠 cachly: recall failed — ${e.message}`);
        }
    });
}
function buildRecallHtml(query, lessons) {
    const rows = lessons.map(l => `
    <div class="lesson">
      <div class="topic">${escapeHtml(l.topic)} <span class="outcome ${l.outcome}">${l.outcome}</span></div>
      <div class="body">${escapeHtml(l.what_worked)}</div>
    </div>`).join('');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 16px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  h2 { font-size: 15px; margin-bottom: 12px; }
  .lesson { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
  .topic { font-family: monospace; font-size: 12px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
  .body { font-size: 13px; line-height: 1.5; }
  .outcome { font-size: 10px; padding: 1px 6px; border-radius: 9px; margin-left: 6px; }
  .outcome.success { background: #1a3a1a; color: #4ec94e; }
  .outcome.failure { background: #3a1a1a; color: #e06c6c; }
  .outcome.partial { background: #3a2a0a; color: #e0c06c; }
</style>
</head>
<body>
<h2>🧠 Brain recall: <code>${escapeHtml(query)}</code></h2>
<p style="color: var(--vscode-descriptionForeground); margin-bottom: 16px;">${lessons.length} lesson${lessons.length === 1 ? '' : 's'} found</p>
${rows}
</body>
</html>`;
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ── Session-summary notification ──────────────────────────────────────────────
// Shows "Your Brain learned X new lessons this session" when VS Code closes,
// but only if the session was long enough and new lessons were actually saved.
async function showSessionSummary() {
    const sessionMinutes = (Date.now() - sessionActivatedAt) / 60000;
    if (sessionMinutes < 5)
        return; // don't show for very short sessions
    const config = vscode.workspace.getConfiguration('cachly');
    const apiKey = config.get('apiKey', '');
    if (!apiKey)
        return;
    try {
        const health = await fetchBrainHealth();
        if (!health)
            return;
        const newLessons = Math.max(0, health.lessons - sessionLessonsAtActivation);
        if (newLessons === 0)
            return;
        void vscode.window.showInformationMessage(`🧠 cachly: Your Brain learned ${newLessons} new lesson${newLessons === 1 ? '' : 's'} this session. Total: ${health.lessons} lessons.`, 'View Brain').then((action) => {
            if (action === 'View Brain')
                void vscode.commands.executeCommand('cachly.showBrainHealth');
        });
    }
    catch { /* non-critical */ }
}
function deactivate() {
    if (refreshTimer)
        clearInterval(refreshTimer);
    if (recallTimer)
        clearInterval(recallTimer);
    if (syncTimer)
        clearInterval(syncTimer);
    if (ambientDebounce)
        clearTimeout(ambientDebounce);
    brainPanel?.dispose();
}
//# sourceMappingURL=extension.js.map