import { describe, it, expect } from 'vitest';
import {
  buildAmbientHook,
  buildAmbientSettingsHooks,
  mergeAmbientSettings,
  AMBIENT_HOOK_VERSION,
  AMBIENT_SCRIPT_NAMES,
  PRE_TOOL_USE_MATCHER,
  type AmbientHookPaths,
} from './ambient';

const paths: AmbientHookPaths = {
  SessionStart: '/w/.claude/hooks/cachly-ambient-session-start.sh',
  UserPromptSubmit: '/w/.claude/hooks/cachly-ambient-prompt-submit.sh',
  PreToolUse: '/w/.claude/hooks/cachly-ambient-pre-tool.sh',
  Stop: '/w/.claude/hooks/cachly-ambient-stop.sh',
};

describe('buildAmbientHook', () => {
  it('emits a versioned, graceful script per event', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const) {
      const s = buildAmbientHook(event, 'inst-1');
      expect(s.startsWith('#!/bin/sh')).toBe(true);
      expect(s).toContain(AMBIENT_HOOK_VERSION);
      expect(s).toContain(`CACHLY_HOOK_EVENT="${event}"`);
      expect(s).toContain('|| true');
      expect(s.trimEnd().endsWith('exit 0')).toBe(true);
    }
  });

  it('embeds the JWT only when provided', () => {
    expect(buildAmbientHook('SessionStart', 'i')).not.toContain('CACHLY_JWT');
    expect(buildAmbientHook('SessionStart', 'i', 'cky_x')).toContain('CACHLY_JWT="cky_x"');
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
    expect(settings.hooks!.UserPromptSubmit[0].hooks[0].command).toBe(paths.UserPromptSubmit);
  });
});
