import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import {
  AMBIENT_SCRIPT_NAMES,
  buildAmbientHook,
  buildAmbientSettingsHooks,
  type AmbientHookEvent,
  type AmbientHookPaths,
} from './ambient';

// buildAmbientHook und buildAmbientSettingsHooks sind Handabschriften von
// sdk/mcp/src/ambient-hooks.ts. Bis 04.11.2026 verglich sie kein Test; das
// JetBrains-Plugin war mit einer solchen Abschrift bis 0.9.7 bei v3 stehen
// geblieben (npx je Prompt). sdk/mcp schreibt die Vorlagen nach hooks/
// (npm run plugin-hooks:write) und prueft sie dort gegen seine Quelle
// (plugin-hooks.test.ts). Hier muessen die Abschriften die Vorlagen ergeben.
// Die Vorlagen sind eingecheckt; der Test laeuft auch im oeffentlichen Spiegel.

const erweiterung = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const lies = (name: string) => fs.readFileSync(erweiterung(`hooks/${name}`), 'utf8');
const EREIGNISSE: AmbientHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

describe('Hook-Abschriften der Erweiterung gegen die Vorlagen aus sdk/mcp', () => {
  it('buildAmbientHook ergibt die ausgefuellte Skript-Vorlage (auch mit \' und \\ in der Instanz)', () => {
    const vorlage = lies('cachly-ambient-vorlage.mjs');
    const js = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    for (const instanz of ['11111111-2222-3333-4444-555555555555', "a'b\\c"]) {
      for (const e of EREIGNISSE) {
        const soll = vorlage.split('__CACHLY_EREIGNIS__').join(js(e)).split('__CACHLY_INSTANZ__').join(js(instanz));
        expect(`${buildAmbientHook(e, instanz)}\n`, e).toBe(soll);
      }
    }
  });

  it('buildAmbientSettingsHooks ergibt die settings-Vorlage (Zeitgrenzen, Matcher, Befehl)', () => {
    const pfade = Object.fromEntries(
      EREIGNISSE.map((e) => [e, `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${AMBIENT_SCRIPT_NAMES[e]}`]),
    ) as AmbientHookPaths;
    expect(buildAmbientSettingsHooks(pfade)).toEqual(JSON.parse(lies('cachly-ambient-settings.vorlage.json')));
  });
});
