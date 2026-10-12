import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { bereinigeAltbestand, schluesselImGitHook, schluesselImHookSkript } from './altbestand';
import { AMBIENT_HOOK_VERSION, AMBIENT_SCRIPT_NAMES, HOOK_BUENDEL } from './ambient';
import { credentialsDateiPfad, schluesselFingerabdruck } from './schluessel';
import {
  alleDateien, alterGitHook, altesHookSkript, dateienMit, FREMDER_GIT_HOOK, INSTANZ, legeAltprojektAn, SCHLUESSEL,
} from './__fixtures__/altprojekt';

const BUENDEL = fileURLToPath(new URL(`../../hooks/${HOOK_BUENDEL}`, import.meta.url));
const ANDERER = 'cky_live_anderer0000000000';

let home: string;
const projekte: string[] = [];
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-heim-')); });
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const p of projekte.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
const projekt = (o?: Parameters<typeof legeAltprojektAn>[0]) => { const p = legeAltprojektAn(o); projekte.push(p); return p; };
const lies = (root: string, ...t: string[]) => fs.readFileSync(path.join(root, ...t), 'utf8');
const heim = () => JSON.parse(fs.readFileSync(credentialsDateiPfad(home), 'utf8'));
const lauf = (root: string, extra: Partial<Parameters<typeof bereinigeAltbestand>[0]> = {}) =>
  bereinigeAltbestand({ ordner: [root], eigenerSchluessel: SCHLUESSEL, instanceId: INSTANZ, home, buendelQuelle: BUENDEL, ...extra });

describe('Fixture: der alte Stand traegt den Schluessel wirklich (Gegenprobe der Gegenprobe)', () => {
  it('in .mcp.json, vier Hook-Skripten und im Git-Hook', () => {
    const root = projekt();
    expect(dateienMit(root, SCHLUESSEL)).toEqual([
      '.claude/hooks/cachly-ambient-pre-tool.mjs',
      '.claude/hooks/cachly-ambient-prompt-submit.mjs',
      '.claude/hooks/cachly-ambient-session-start.mjs',
      '.claude/hooks/cachly-ambient-stop.mjs',
      '.git/hooks/post-commit',
      '.mcp.json',
    ]);
  });
});

describe('bereinigeAltbestand', () => {
  it('nimmt den Schluessel aus JEDER Projektdatei und legt ihn im Heimordner ab', async () => {
    const root = projekt({ mitFremdem: true });
    const r = await lauf(root);

    expect(dateienMit(root, SCHLUESSEL)).toEqual([]);
    expect(heim()).toEqual({ apiKey: SCHLUESSEL, instanceId: INSTANZ });
    expect(r.heim?.zustand).toBe('geschrieben');
    expect(r.heimSchluessel).toBe(SCHLUESSEL);
    expect(r.bereinigt.map((p) => path.relative(root, p).replace(/\\/g, '/')).sort()).toEqual([
      '.claude/hooks/cachly-ambient-pre-tool.mjs',
      '.claude/hooks/cachly-ambient-prompt-submit.mjs',
      '.claude/hooks/cachly-ambient-session-start.mjs',
      '.claude/hooks/cachly-ambient-stop.mjs',
      '.git/hooks/post-commit',
      '.mcp.json',
    ]);
    expect(r.fremd).toEqual([]);
    expect(r.offen).toEqual([]);
  });

  it('laesst Fremdes unangetastet: andere MCP-Server, fremde Hooks, fremde Einstellungen, fremder Git-Hook', async () => {
    const root = projekt({ mitFremdem: true });
    await lauf(root);

    const mcp = JSON.parse(lies(root, '.mcp.json'));
    expect(mcp.mcpServers.fremd).toEqual({ command: 'node', args: ['server.js'], env: { TOKEN: 'bleibt' } });
    expect(mcp.mcpServers.cachly.env).toEqual({ CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_BRAIN_INSTANCE_ID: INSTANZ });

    const settings = JSON.parse(lies(root, '.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/usr/local/bin/mein-hook.sh');
    expect(settings.hooks.SessionStart).toHaveLength(2); // fremder + genau EIN cachly-Eintrag

    const git = lies(root, '.git', 'hooks', 'post-commit');
    expect(git).toContain('mein eigener post-commit');
    expect(git.match(/# cachly CLS/g)).toHaveLength(1);
    expect(git).not.toContain('CACHLY_JWT');
  });

  it('schreibt die Hook-Skripte als v5 mit Buendel, behaelt aber die Instanz aus der alten Datei', async () => {
    const eigeneInstanz = '11111111-2222-3333-4444-555555555555';
    const root = projekt({ instanceId: eigeneInstanz });
    await lauf(root, { instanceId: INSTANZ });
    for (const name of Object.values(AMBIENT_SCRIPT_NAMES)) {
      const s = lies(root, '.claude', 'hooks', name);
      expect(s).toContain(`${AMBIENT_HOOK_VERSION}`);
      expect(s).toContain(`process.env.CACHLY_BRAIN_INSTANCE_ID = '${eigeneInstanz}';`);
      expect(s).not.toContain('CACHLY_JWT');
    }
    expect(fs.existsSync(path.join(root, '.claude', 'hooks', HOOK_BUENDEL))).toBe(true);
  });

  it('der zweite Lauf findet nichts mehr und aendert nichts', async () => {
    const root = projekt();
    await lauf(root);
    const stand = alleDateien(root).map((f) => [f, lies(root, f)]);
    const heimVorher = fs.readFileSync(credentialsDateiPfad(home), 'utf8');
    const r2 = await lauf(root);
    expect(r2).toEqual({ bereinigt: [], fremd: [], offen: [] });
    expect(alleDateien(root).map((f) => [f, lies(root, f)])).toEqual(stand);
    expect(fs.readFileSync(credentialsDateiPfad(home), 'utf8')).toBe(heimVorher);
  });

  it('meldet NICHTS und legt nichts an, wenn kein Schluessel im Projekt steht', async () => {
    const root = projekt();
    await lauf(root);
    const sauber = projekt();
    for (const f of ['.mcp.json']) fs.writeFileSync(path.join(sauber, f), JSON.stringify({ mcpServers: { cachly: { env: { CACHLY_BRAIN_INSTANCE_ID: INSTANZ } } } }));
    fs.rmSync(path.join(sauber, '.claude'), { recursive: true });
    fs.rmSync(path.join(sauber, '.git', 'hooks', 'post-commit'));
    fs.rmSync(path.join(home, '.cachly'), { recursive: true, force: true });
    const vorher = alleDateien(sauber).map((f) => [f, lies(sauber, f)]);
    const r = await lauf(sauber);
    expect(r).toEqual({ bereinigt: [], fremd: [], offen: [] });
    expect(alleDateien(sauber).map((f) => [f, lies(sauber, f)])).toEqual(vorher);
    expect(fs.existsSync(credentialsDateiPfad(home))).toBe(false);
  });

  it('fasst einen FREMDEN Schluessel nicht an (Projekt aus einem fremden Repository)', async () => {
    const root = projekt({ schluessel: ANDERER });
    const vorher = alleDateien(root).map((f) => [f, lies(root, f)]);
    const r = await lauf(root);
    expect(alleDateien(root).map((f) => [f, lies(root, f)])).toEqual(vorher);
    expect(r.bereinigt).toEqual([]);
    expect(r.fremd.length).toBe(6);
    expect(fs.existsSync(credentialsDateiPfad(home))).toBe(false);
  });

  it('erkennt den Schluessel im Heimordner als "unseren", auch wenn die Erweiterung einen anderen hat', async () => {
    const root = projekt({ schluessel: ANDERER });
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    fs.writeFileSync(credentialsDateiPfad(home), JSON.stringify({ apiKey: ANDERER, instanceId: 'x' }));
    const r = await lauf(root);
    expect(dateienMit(root, ANDERER)).toEqual([]);
    expect(r.bereinigt.length).toBe(6);
    expect(heim()).toEqual({ apiKey: ANDERER, instanceId: 'x' }); // Heimordner bleibt, wie er war
  });

  it('bei einem anderen Schluessel im Heimordner: Projekt bleibt UNVERAENDERT, Ergebnis sagt "konflikt"', async () => {
    const root = projekt();
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    const fremd = JSON.stringify({ apiKey: ANDERER });
    fs.writeFileSync(credentialsDateiPfad(home), fremd);
    const vorher = alleDateien(root).map((f) => [f, lies(root, f)]);
    const r = await lauf(root);
    expect(r.heim?.zustand).toBe('konflikt');
    expect(r.bereinigt).toEqual([]);
    expect(alleDateien(root).map((f) => [f, lies(root, f)])).toEqual(vorher);
    expect(fs.readFileSync(credentialsDateiPfad(home), 'utf8')).toBe(fremd);
  });

  it('ersetzt den anderen Schluessel im Heimordner, wenn wir ihn selbst abgelegt hatten', async () => {
    const root = projekt();
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    fs.writeFileSync(credentialsDateiPfad(home), JSON.stringify({ apiKey: ANDERER }));
    const r = await lauf(root, { darfErsetzen: (alt) => schluesselFingerabdruck(alt) === schluesselFingerabdruck(ANDERER) });
    expect(r.heim?.zustand).toBe('geschrieben');
    expect(heim().apiKey).toBe(SCHLUESSEL);
    expect(dateienMit(root, SCHLUESSEL)).toEqual([]);
  });

  it('eine Datei mit Kommentaren wird NICHT umgeschrieben, aber gemeldet', async () => {
    const root = projekt();
    const mitKommentar = `{\n  // mein Server\n  "mcpServers": { "cachly": { "env": { "CACHLY_JWT": "${SCHLUESSEL}" } } }\n}`;
    fs.writeFileSync(path.join(root, '.mcp.json'), mitKommentar);
    const r = await lauf(root);
    expect(lies(root, '.mcp.json')).toBe(mitKommentar);
    expect(r.offen.map((p) => path.basename(p))).toEqual(['.mcp.json']);
    // die uebrigen Dateien sind trotzdem sauber
    expect(dateienMit(root, SCHLUESSEL)).toEqual(['.mcp.json']);
  });

  it('faellt der Buendel aus, verliert jedes Skript trotzdem die Zeile mit dem Schluessel', async () => {
    const root = projekt();
    await lauf(root, { buendelQuelle: path.join(root, 'fehlt.mjs') });
    expect(dateienMit(root, SCHLUESSEL)).toEqual([]);
    for (const name of Object.values(AMBIENT_SCRIPT_NAMES)) {
      expect(lies(root, '.claude', 'hooks', name)).toContain('process.env.CACHLY_BRAIN_INSTANCE_ID');
    }
  });

  it('nimmt Arbeitsordner und Git-Wurzel nur einmal (doppelte Ordner sind egal)', async () => {
    const root = projekt();
    const r = await lauf(root, { ordner: [root, root + path.sep, root] });
    expect(r.bereinigt.length).toBe(6);
  });

  it('wirft nie, auch bei einem Ordner, den es nicht gibt', async () => {
    const r = await lauf(path.join(home, 'gibt-es-nicht'));
    expect(r).toEqual({ bereinigt: [], fremd: [], offen: [] });
  });
});

describe('Erkennung in Hook-Dateien', () => {
  it('liest Schluessel und Instanz aus dem alten Skript, mit Escapes', () => {
    expect(schluesselImHookSkript(altesHookSkript('Stop', INSTANZ, SCHLUESSEL))).toEqual({ schluessel: SCHLUESSEL, instanceId: INSTANZ });
    expect(schluesselImHookSkript("process.env.CACHLY_JWT = 'a\\'b';")).toEqual({ schluessel: "a'b", instanceId: undefined });
  });
  it('das aktuelle Skript traegt keinen', () => {
    expect(schluesselImHookSkript("process.env.CACHLY_BRAIN_INSTANCE_ID = 'i';\nawait import('./x.mjs');").schluessel).toBeUndefined();
  });
  it('liest nur im cachly-Block des Git-Hooks, nicht in einem fremden', () => {
    const fremd = '#!/bin/sh\nexport CACHLY_JWT="gehoert-dem-fremden-hook"\n';
    expect(schluesselImGitHook(fremd).schluessel).toBeUndefined();
    expect(schluesselImGitHook(FREMDER_GIT_HOOK + '\n' + alterGitHook(INSTANZ, SCHLUESSEL))).toEqual({ schluessel: SCHLUESSEL, instanceId: INSTANZ });
  });
});
