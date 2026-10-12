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
 * v4 (GROW-015): the script no longer embeds the caller's key.
 * v5 (11.10.2026): no npx. Each script loads the hook bundle that sits next to
 * it (HOOK_BUENDEL) in the same process — the shape sdk/mcp writes.
 *
 * The extension followed on 12.10.2026. Until 0.12.6 it wrote v3 scripts WITH
 * the API key as a string literal into .claude/hooks/ — files that
 * `git add .` checks in. v5 carries only the instance id; the bundle finds the
 * key at run time in ~/.cachly/credentials.json.
 */
export const AMBIENT_HOOK_VERSION = 'v5';

/**
 * The npx-free hook bundle: one file, no node_modules. It is generated in
 * sdk/mcp (npm run plugin-hooks:write) and copied to sdk/vscode/hooks/
 * (npm run hooks:sync). The extension copies it next to the four scripts.
 */
export const HOOK_BUENDEL = 'cachly-ambient-einblendung.mjs';

export type AmbientHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop';

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

/**
 * One project hook script (v5), the same text sdk/mcp writes
 * (ambient-hooks.ts buildHook): bakes in the instance id, then loads the
 * bundle next to it in the same process. There is deliberately NO key
 * parameter: a key in a project file is the bug this shape removes. The
 * hook payload (which contains the user's prompt) is read from stdin by the
 * bundle — never spliced into source.
 */
export function buildAmbientHook(event: AmbientHookEvent, instanceId: string): string {
  return [
    `#!/usr/bin/env node`,
    `// cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`,
    `// Pushes relevant memory into context automatically. Cross-platform Node hook`,
    `// (no shell script — runs identically on Windows/macOS/Linux). Never blocks`,
    `// the agent: every failure path exits 0 with no output (graceful degrade).`,
    `// Runs the hook bundle next to this file (${HOOK_BUENDEL}) in this process.`,
    `process.env.CACHLY_BRAIN_INSTANCE_ID = '${jsString(instanceId)}';`,
    `process.env.CACHLY_HOOK_EVENT = '${jsString(event)}';`,
    `process.argv.splice(2, process.argv.length, '${jsString(event)}');`,
    `try {`,
    `  await import('./${HOOK_BUENDEL}');`,
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
