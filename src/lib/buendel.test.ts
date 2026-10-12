import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { HOOK_BUENDEL } from './ambient';
import { VERTRAUEN_BESCHREIBUNG } from './vertrauen';

const erweiterung = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const mcpBuendel = erweiterung(`../mcp/hooks/${HOOK_BUENDEL}`);

describe('Hook-Buendel in der Erweiterung', () => {
  it('liegt unter hooks/ und ist ein Node-Skript', () => {
    const text = fs.readFileSync(erweiterung(`hooks/${HOOK_BUENDEL}`), 'utf8');
    expect(text.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(text.length).toBeGreaterThan(10_000);
  });

  it('ist Byte fuer Byte das Buendel aus sdk/mcp/hooks/ (npm run hooks:sync, wenn nicht)', () => {
    // Im oeffentlichen Spiegel (cachly-vscode) liegt sdk/mcp nicht daneben: dort gilt die eingecheckte Kopie.
    if (!fs.existsSync(mcpBuendel)) return;
    expect(fs.readFileSync(erweiterung(`hooks/${HOOK_BUENDEL}`)).equals(fs.readFileSync(mcpBuendel))).toBe(true);
  });

  it('kommt ins VSIX: .vscodeignore laesst hooks/ durch', () => {
    const regeln = fs.readFileSync(erweiterung('.vscodeignore'), 'utf8').split(/\r?\n/).map((z) => z.trim()).filter((z) => z && !z.startsWith('#'));
    const betrifftBuendel = regeln.filter((r) => !r.startsWith('!') && (r.startsWith('hooks') || r === '**/*.mjs' || r === '*.mjs'));
    expect(betrifftBuendel).toEqual([]);
  });
});

describe('package.json', () => {
  const paket = JSON.parse(fs.readFileSync(erweiterung('package.json'), 'utf8'));

  it('Workspace Trust: "limited" mit derselben Beschreibung wie im Code', () => {
    expect(paket.capabilities.untrustedWorkspaces.supported).toBe('limited');
    expect(paket.capabilities.untrustedWorkspaces.description).toBe(VERTRAUEN_BESCHREIBUNG);
  });

  it('die Version steht im CHANGELOG', () => {
    const log = fs.readFileSync(erweiterung('CHANGELOG.md'), 'utf8');
    expect(log).toContain(`## [${paket.version}]`);
  });
});
