import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installiereAmbientHooks, installiereClsHook } from './projektHooks';
import { AMBIENT_HOOK_VERSION, AMBIENT_SCRIPT_NAMES, HOOK_BUENDEL } from './ambient';
import { CLS_HOOK_VERSION } from './config';
import { alleDateien, alterGitHook, dateienMit, FREMDER_GIT_HOOK, INSTANZ, SCHLUESSEL } from './__fixtures__/altprojekt';

const BUENDEL = fileURLToPath(new URL(`../../hooks/${HOOK_BUENDEL}`, import.meta.url));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-hooks-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const lies = (...teile: string[]) => fs.readFileSync(path.join(root, ...teile), 'utf8');

describe('installiereAmbientHooks (v5)', () => {
  it('schreibt vier Skripte, das Buendel daneben und die Eintraege in settings.json — ohne Schluessel', async () => {
    await installiereAmbientHooks(root, INSTANZ, BUENDEL);
    const dir = path.join(root, '.claude', 'hooks');
    expect(fs.readdirSync(dir).sort()).toEqual([...Object.values(AMBIENT_SCRIPT_NAMES), HOOK_BUENDEL].sort());
    for (const name of Object.values(AMBIENT_SCRIPT_NAMES)) {
      const s = lies('.claude', 'hooks', name);
      expect(s).toContain(`${AMBIENT_HOOK_VERSION}`);
      expect(s).toContain(`process.env.CACHLY_BRAIN_INSTANCE_ID = '${INSTANZ}';`);
      expect(s).toContain(`await import('./${HOOK_BUENDEL}');`);
    }
    // das Buendel ist dieselbe Datei, die ins VSIX kommt
    expect(fs.readFileSync(path.join(dir, HOOK_BUENDEL)).equals(fs.readFileSync(BUENDEL))).toBe(true);
    const settings = JSON.parse(lies('.claude', 'settings.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(dateienMit(root, 'CACHLY_JWT =')).toEqual([]);
    expect(dateienMit(root, 'cky_')).toEqual([]);
  });

  it('ist idempotent: der zweite Lauf aendert nichts', async () => {
    await installiereAmbientHooks(root, INSTANZ, BUENDEL);
    const stand = (): Record<string, number> =>
      Object.fromEntries(alleDateien(root).map((f) => [f, fs.statSync(path.join(root, f)).mtimeMs]));
    const vorher = stand();
    await new Promise((r) => setTimeout(r, 20));
    await installiereAmbientHooks(root, INSTANZ, BUENDEL);
    expect(stand()).toEqual(vorher);
  });

  it('laesst fremde Hooks und fremde Einstellungen stehen', async () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/mein.sh' }] }] } }),
    );
    await installiereAmbientHooks(root, INSTANZ, BUENDEL);
    const s = JSON.parse(lies('.claude', 'settings.json'));
    expect(s.model).toBe('opus');
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('/x/mein.sh');
  });

  it('schreibt NICHTS, wenn das Buendel fehlt (ohne Buendel taten die Skripte nichts)', async () => {
    await installiereAmbientHooks(root, INSTANZ, path.join(root, 'gibt-es-nicht.mjs'));
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('fasst eine settings.json, die sich nicht lesen laesst, nicht an', async () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ kaputt');
    await installiereAmbientHooks(root, INSTANZ, BUENDEL);
    expect(lies('.claude', 'settings.json')).toBe('{ kaputt');
  });
});

describe('installiereClsHook (v3)', () => {
  it('legt den Hook ohne Schluessel an', async () => {
    await installiereClsHook(root, INSTANZ);
    const h = lies('.git', 'hooks', 'post-commit');
    expect(h).toContain(`Continuous Learning Stream ${CLS_HOOK_VERSION}`);
    expect(h).toContain(`export CACHLY_BRAIN_INSTANCE_ID="${INSTANZ}"`);
    expect(h).not.toContain('CACHLY_JWT');
  });

  it('ersetzt einen alten Block MIT Schluessel an Ort und Stelle und laesst den fremden Hook davor stehen', async () => {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'post-commit'), FREMDER_GIT_HOOK + '\n' + alterGitHook(INSTANZ, SCHLUESSEL));
    await installiereClsHook(root, INSTANZ);
    const h = lies('.git', 'hooks', 'post-commit');
    expect(h).toContain('mein eigener post-commit');
    expect(h).not.toContain(SCHLUESSEL);
    expect(h).toContain(`Continuous Learning Stream ${CLS_HOOK_VERSION}`);
    expect(h.match(/# cachly CLS/g)).toHaveLength(1);
  });

  it('haengt an einen fremden Hook an, statt ihn zu ersetzen', async () => {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'post-commit'), FREMDER_GIT_HOOK);
    await installiereClsHook(root, INSTANZ);
    const h = lies('.git', 'hooks', 'post-commit');
    expect(h.startsWith(FREMDER_GIT_HOOK.trimEnd())).toBe(true);
    expect(h).toContain('# cachly CLS');
  });

  it('tut nichts ohne .git', async () => {
    const ohneGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-ohnegit-'));
    try {
      await installiereClsHook(ohneGit, INSTANZ);
      expect(fs.readdirSync(ohneGit)).toEqual([]);
    } finally {
      fs.rmSync(ohneGit, { recursive: true, force: true });
    }
  });
});
