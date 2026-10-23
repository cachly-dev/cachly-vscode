import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ergaenzeGitExclude, REGELZIELE, schreibeRegelwissen } from './regelwissen';

// Anlass (23.10.2026): Copilot und Cursor rufen smart_recall nie selbst auf. Der Block
// landet in den Regeldateien, die beide in jeden Chat laden.

const BLOCK = '<!-- Written by cachly 2026-10-23T12:00:00Z. Regenerated automatically; edits are overwritten. -->\n'
  + '# Project experience (cachly)\n\n<cachly-memory>\nStored notes …\n\n### deploy:x\nweg\n</cachly-memory>\n';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-regel-'));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const lies = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const da = (rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));

describe('schreibeRegelwissen', () => {
  it('schreibt den Block mit Vorspann in die Copilot- und die Cursor-Datei', () => {
    const erg = schreibeRegelwissen(root, BLOCK);
    for (const z of REGELZIELE) {
      expect(erg[z.pfad]).toBe('geschrieben');
      expect(lies(z.pfad).startsWith(z.kopf)).toBe(true);
      expect(lies(z.pfad)).toContain('### deploy:x');
    }
    expect(lies('.github/instructions/cachly-wissen.instructions.md')).toContain('applyTo: "**"');
    expect(lies('.cursor/rules/cachly-wissen.mdc')).toContain('alwaysApply: true');
  });

  it('laesst eine fremde Datei am selben Pfad unberuehrt', () => {
    const p = REGELZIELE[0].pfad;
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), 'eigene Regeln des Teams', 'utf8');
    expect(schreibeRegelwissen(root, BLOCK)[p]).toBe('fremd');
    expect(lies(p)).toBe('eigene Regeln des Teams');
  });

  it('nur ein neuer Zeitstempel zaehlt nicht als Aenderung', () => {
    schreibeRegelwissen(root, BLOCK);
    const spaeter = BLOCK.replace('2026-10-23T12:00:00Z', '2026-10-23T12:05:00Z');
    const erg = schreibeRegelwissen(root, spaeter);
    expect(Object.values(erg).every((a) => a === 'unveraendert')).toBe(true);
  });

  it('ein leerer Block entfernt nur unsere Dateien', () => {
    schreibeRegelwissen(root, BLOCK);
    const fremd = REGELZIELE[1].pfad;
    fs.writeFileSync(path.join(root, fremd), 'fremd', 'utf8');
    const erg = schreibeRegelwissen(root, '');
    expect(erg[REGELZIELE[0].pfad]).toBe('entfernt');
    expect(da(REGELZIELE[0].pfad)).toBe(false);
    expect(erg[fremd]).toBe('fremd');
    expect(lies(fremd)).toBe('fremd');
  });
});

describe('ergaenzeGitExclude', () => {
  it('traegt die Pfade einmal ein und laesst Vorhandenes stehen', () => {
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '# eigene\n*.log', 'utf8');
    expect(ergaenzeGitExclude(root)).toHaveLength(REGELZIELE.length);
    expect(ergaenzeGitExclude(root)).toEqual([]);
    const inhalt = lies('.git/info/exclude');
    expect(inhalt.startsWith('# eigene\n*.log\n')).toBe(true);
    for (const z of REGELZIELE) expect(inhalt.split('\n')).toContain(`/${z.pfad}`);
  });

  it('ohne .git-Ordner passiert nichts', () => {
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    expect(ergaenzeGitExclude(root)).toEqual([]);
    expect(da('.git')).toBe(false);
  });
});
