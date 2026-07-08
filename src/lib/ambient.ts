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

/** Bumped whenever a hook script changes so installers can upgrade old hooks. */
export const AMBIENT_HOOK_VERSION = 'v2';

export const AMBIENT_CLI_SUBCOMMAND = 'ambient-recall';

export type AmbientHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop';

const DEFAULT_CLI = `npx @cachly-dev/mcp-server@latest ${AMBIENT_CLI_SUBCOMMAND}`;

/** Script filename per event — shared marker `cachly-ambient-` drives upgrades. */
export const AMBIENT_SCRIPT_NAMES: Record<AmbientHookEvent, string> = {
  SessionStart: 'cachly-ambient-session-start.sh',
  UserPromptSubmit: 'cachly-ambient-prompt-submit.sh',
  PreToolUse: 'cachly-ambient-pre-tool.sh',
  Stop: 'cachly-ambient-stop.sh',
};
export const AMBIENT_SCRIPT_MARKER = '.claude/hooks/cachly-ambient-';

export function buildAmbientHook(event: AmbientHookEvent, instanceId: string, apiKey?: string): string {
  return [
    `#!/bin/sh`,
    `# cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`,
    `# Pushes relevant memory into context automatically. Never blocks the agent:`,
    `# any failure exits 0 with no output (graceful degrade).`,
    `export CACHLY_BRAIN_INSTANCE_ID="${instanceId}"`,
    ...(apiKey ? [`export CACHLY_JWT="${apiKey}"`] : []),
    `export CACHLY_HOOK_EVENT="${event}"`,
    // The hook payload (which contains the user's prompt) is piped verbatim on
    // stdin — never spliced into shell source, so it cannot break the script.
    `cat | ${DEFAULT_CLI} 2>/dev/null || true`,
    `exit 0`,
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
  const entry = (event: AmbientHookEvent, matcher?: string): HookMatcherGroup => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: paths[event], timeout: EVENT_TIMEOUTS[event] }],
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
      return cmd.includes(AMBIENT_SCRIPT_MARKER) || currentPaths.has(cmd);
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
