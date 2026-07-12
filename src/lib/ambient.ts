// Ambient Recall hook builders — pure, vscode-free, fully unit-testable.
//
// Kept in sync with sdk/mcp/src/ambient-hooks.ts in cachly-dev/cachly (same
// script bytes, same settings-merge semantics) so VS-Code-only users who also
// run Claude Code in their terminal get the identical push-based memory:
//   SessionStart      → session briefing injected automatically
//   UserPromptSubmit  → per-prompt gated recall (the most-forgotten call)
//   PreToolUse        → file-open briefing before Edit/Write-class tools
//   Stop              → auto-learn from clear fix-signal turn endings
//
// The scripts are graceful by construction: any failure exits 0 with no output,
// so a broken hook can never block the user's agent.

/**
 * Bumped whenever a hook script changes so installers can upgrade old hooks.
 * v3: hooks became Node scripts (.mjs) invoked as `node "<path>"` — the
 * cross-platform shape from the Claude Code hooks guide. The v1/v2 POSIX shell
 * scripts silently never ran on native Windows (no /bin/sh).
 */
export const AMBIENT_HOOK_VERSION = 'v3';

export const AMBIENT_CLI_SUBCOMMAND = 'ambient-recall';

export type AmbientHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop';

const DEFAULT_CLI = `npx @cachly-dev/mcp-server@latest ${AMBIENT_CLI_SUBCOMMAND}`;

/** Script filename per event — shared marker `cachly-ambient-` drives upgrades. */
export const AMBIENT_SCRIPT_NAMES: Record<AmbientHookEvent, string> = {
  SessionStart: 'cachly-ambient-session-start.mjs',
  UserPromptSubmit: 'cachly-ambient-prompt-submit.mjs',
  PreToolUse: 'cachly-ambient-pre-tool.mjs',
  Stop: 'cachly-ambient-stop.mjs',
};
export const AMBIENT_SCRIPT_MARKER = '.claude/hooks/cachly-ambient-';

/** Escape a value for embedding inside a single-quoted JS string literal. */
function jsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildAmbientHook(event: AmbientHookEvent, instanceId: string, apiKey?: string): string {
  return [
    `#!/usr/bin/env node`,
    `// cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`,
    `// Pushes relevant memory into context automatically. Cross-platform Node hook`,
    `// (no shell script — runs identically on Windows/macOS/Linux). Never blocks`,
    `// the agent: every failure path exits 0 with no output (graceful degrade).`,
    `import { spawn } from 'node:child_process';`,
    `process.env.CACHLY_BRAIN_INSTANCE_ID = '${jsString(instanceId)}';`,
    ...(apiKey ? [`process.env.CACHLY_JWT = '${jsString(apiKey)}';`] : []),
    `process.env.CACHLY_HOOK_EVENT = '${jsString(event)}';`,
    `try {`,
    // The hook payload (which contains the user's prompt) is piped verbatim on
    // stdin — never spliced into source, so it cannot break the script.
    `  const child = spawn('${jsString(DEFAULT_CLI)}', { shell: true, stdio: ['inherit', 'inherit', 'ignore'] });`,
    `  child.on('error', () => process.exit(0));`,
    `  child.on('close', () => process.exit(0));`,
    `} catch {`,
    `  process.exit(0);`,
    `}`,
  ].join('\n');
}

// Per-event latency budgets (seconds) — outer safety net; the CLI self-limits
// its recall to 3s.
const EVENT_TIMEOUTS: Record<AmbientHookEvent, number> = {
  SessionStart: 30,
  UserPromptSubmit: 10,
  PreToolUse: 10,
  Stop: 60,
};

/** Matcher for the PreToolUse briefing: only file-mutating tools. */
export const PRE_TOOL_USE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export interface ClaudeSettingsLike {
  hooks?: Record<string, HookMatcherGroup[]>;
  [k: string]: unknown;
}

export type AmbientHookPaths = Record<AmbientHookEvent, string>;

/** Build the `.claude/settings.json` hooks fragment for all four events. */
export function buildAmbientSettingsHooks(paths: AmbientHookPaths): Record<string, HookMatcherGroup[]> {
  // v3: the command is `node "<script>"` — one string that /bin/sh (macOS/
  // Linux, Windows+Git-Bash) and PowerShell (native Windows) run identically.
  const entry = (event: AmbientHookEvent, matcher?: string): HookMatcherGroup => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: `node "${paths[event]}"`, timeout: EVENT_TIMEOUTS[event] }],
  });
  return {
    SessionStart: [entry('SessionStart')],
    UserPromptSubmit: [entry('UserPromptSubmit')],
    PreToolUse: [entry('PreToolUse', PRE_TOOL_USE_MATCHER)],
    Stop: [entry('Stop')],
  };
}

function isAmbientGroup(g: HookMatcherGroup, currentPaths: Set<string>): boolean {
  const hooks = g.hooks ?? [];
  return (
    hooks.length > 0 &&
    hooks.every((h) => {
      const cmd = h.command ?? '';
      // Matches v1/v2 entries (bare script path), v3 entries (`node "<path>"`),
      // and marker-less test/custom paths passed as the current fragment.
      return (
        cmd.includes(AMBIENT_SCRIPT_MARKER) ||
        currentPaths.has(cmd) ||
        [...currentPaths].some((p) => cmd.includes(`"${p}"`))
      );
    })
  );
}

/**
 * Merge our hook entries into existing settings without disturbing anything
 * else. Idempotent AND upgrade-safe: prior cachly-ambient groups (any version/
 * paths) are replaced, never accumulated; foreign groups are preserved. Pure.
 */
export function mergeAmbientSettings(
  existing: ClaudeSettingsLike,
  paths: AmbientHookPaths,
): { settings: ClaudeSettingsLike; changed: boolean } {
  const next: ClaudeSettingsLike = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const hooks = next.hooks!;
  const fragment = buildAmbientSettingsHooks(paths);
  const currentPaths = new Set(Object.values(paths));

  for (const [event, ourGroups] of Object.entries(fragment)) {
    const foreign = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
      (g) => !isAmbientGroup(g, currentPaths),
    );
    hooks[event] = [...foreign, ...ourGroups];
  }
  const changed = JSON.stringify(next) !== JSON.stringify(existing);
  return { settings: next, changed };
}
