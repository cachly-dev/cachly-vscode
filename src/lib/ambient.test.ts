import { describe, it, expect } from 'vitest';
import {
  buildAmbientHook,
  buildAmbientSettingsHooks,
  mergeAmbientSettings,
  AMBIENT_HOOK_VERSION,
  AMBIENT_SCRIPT_NAMES,
  HOOK_BUENDEL,
  PRE_TOOL_USE_MATCHER,
  type AmbientHookPaths,
} from './ambient';

const paths: AmbientHookPaths = {
  SessionStart: '/w/.claude/hooks/cachly-ambient-session-start.mjs',
  UserPromptSubmit: '/w/.claude/hooks/cachly-ambient-prompt-submit.mjs',
  PreToolUse: '/w/.claude/hooks/cachly-ambient-pre-tool.mjs',
  Stop: '/w/.claude/hooks/cachly-ambient-stop.mjs',
};

describe('buildAmbientHook', () => {
  it('emits a versioned script per event that loads the bundle next to it (v5, the shape `setup` writes)', () => {
    expect(AMBIENT_HOOK_VERSION).toBe('v5');
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const) {
      const s = buildAmbientHook(event, 'inst-1');
      expect(s.startsWith('#!/usr/bin/env node')).toBe(true);
      expect(s).toContain(`// cachly Ambient Recall — ${event} ${AMBIENT_HOOK_VERSION}`);
      expect(s).toContain("process.env.CACHLY_BRAIN_INSTANCE_ID = 'inst-1';");
      expect(s).toContain(`process.env.CACHLY_HOOK_EVENT = '${event}';`);
      expect(s).toContain(`process.argv.splice(2, process.argv.length, '${event}');`);
      expect(s).toContain(`await import('./${HOOK_BUENDEL}');`);
      // no npx, no child process: 7.7 s warm / 17.1 s cold per prompt was the v4 cost
      expect(s).not.toContain('npx');
      expect(s).not.toContain('spawn');
    }
  });

  it('never embeds a key (the script is a project file that `git add .` checks in)', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const) {
      expect(buildAmbientHook(event, 'i')).not.toContain('CACHLY_JWT');
      // an old caller still passing a third argument must not get a key written
      const s = (buildAmbientHook as (e: typeof event, i: string, k?: string) => string)(event, 'i', 'cky_live_secret');
      expect(s).not.toContain('cky_live_secret');
    }
  });

  it('escapes the instance id for a single-quoted JS string', () => {
    expect(buildAmbientHook('Stop', "a'b\\c")).toContain("process.env.CACHLY_BRAIN_INSTANCE_ID = 'a\\'b\\\\c';");
  });

  it('script names carry the shared upgrade marker', () => {
    for (const name of Object.values(AMBIENT_SCRIPT_NAMES)) {
      expect(name.startsWith('cachly-ambient-')).toBe(true);
    }
  });
});

describe('buildAmbientSettingsHooks', () => {
  it('wires all four events; PreToolUse scoped to file-mutating tools', () => {
    const frag = buildAmbientSettingsHooks(paths);
    expect(Object.keys(frag).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(frag.PreToolUse[0].matcher).toBe(PRE_TOOL_USE_MATCHER);
    expect(frag.UserPromptSubmit[0].hooks[0].timeout).toBe(10);
    expect(frag.Stop[0].hooks[0].timeout).toBe(60);
  });
});

describe('mergeAmbientSettings', () => {
  it('is idempotent and preserves foreign hooks + unrelated keys', () => {
    const existing = {
      model: 'opus',
      hooks: { SessionStart: [{ hooks: [{ type: 'command' as const, command: '/other.sh' }] }] },
    };
    const first = mergeAmbientSettings(existing, paths);
    expect(first.changed).toBe(true);
    expect(first.settings.model).toBe('opus');
    expect(first.settings.hooks!.SessionStart).toHaveLength(2);

    const second = mergeAmbientSettings(first.settings, paths);
    expect(second.changed).toBe(false);
    expect(second.settings.hooks!.SessionStart).toHaveLength(2);
  });

  it('upgrades stale cachly-ambient entries instead of accumulating them', () => {
    const stale = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command' as const, command: '/old/.claude/hooks/cachly-ambient-prompt-submit.sh' }] },
        ],
      },
    };
    const { settings } = mergeAmbientSettings(stale, paths);
    expect(settings.hooks!.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks!.UserPromptSubmit[0].hooks[0].command).toBe(`node "${paths.UserPromptSubmit}"`);
  });
});
