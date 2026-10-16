// Die Erweiterung als Ganzes, gegen eine Attrappe: ein kleiner HTTP-Server auf
// 127.0.0.1 statt api.cachly.dev, ein Ersatz fuer das Modul `vscode`
// (__fixtures__/fakeVscode.ts), Temp-Ordner statt echtem Projekt und
// Heimordner. Nichts hier erreicht die Produktion.
//
// Was bewiesen wird:
//   1. Workspace Trust: im eingeschraenkten Modus keine Datei, kein Konto,
//      keine Anfrage — nur Statusleiste, eine Meldung, Platzhalter. Nach dem
//      Vertrauen laeuft der bisherige Weg.
//   2. Schluessel: ueber ALLE Schreibwege der Erweiterung steht der Schluessel
//      in keiner Projektdatei, auch nicht unter .git/.
//   3. Altbestand: ein Projekt aus 0.12.6 wird bereinigt, einmal gemeldet,
//      Fremdes bleibt.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { alleDateien, dateienMit, FREMDER_GIT_HOOK, INSTANZ, legeAltprojektAn, SCHLUESSEL } from './lib/__fixtures__/altprojekt';
import { ALTBESTAND_MELDUNG, VERTRAUEN_BEFEHL, VERTRAUEN_KNOPF } from './lib/vertrauen';

vi.mock('vscode', () => import('./__fixtures__/fakeVscode'));
// Der Heimordner ist im Test immer ein Temp-Ordner, nie der echte.
vi.mock('os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('os')>();
  const pfad = await import('path');
  const homedir = () =>
    (globalThis as { __CACHLY_TEST_HOME?: string }).__CACHLY_TEST_HOME ?? pfad.join(orig.tmpdir(), 'cachly-test-kein-heim');
  return { ...orig, homedir, default: { ...orig, homedir } };
});

const ERWEITERUNG = fileURLToPath(new URL('..', import.meta.url));
const PAKET = JSON.parse(fs.readFileSync(path.join(ERWEITERUNG, 'package.json'), 'utf8')) as {
  contributes: { commands: Array<{ command: string }> };
};
const TRIAL_KEY = 'cky_trial_Zk3x9QpL7mNb2VcRt5YwHd8F';
const LIVE_KEY = 'cky_live_Qw8rTy2uIo5pAs7dFg4hJk1l';
const ANDERER_KEY = 'cky_live_AndererKontoMitAnderemSchluessel';
const TRIAL_INSTANZ = '99999999-aaaa-bbbb-cccc-000000000001';

// ── Attrappe ────────────────────────────────────────────────────────────────

interface Anfrage { methode: string; url: string; authorization?: string }
let server: http.Server;
let attrappeUrl = '';
const anfragen: Anfrage[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    anfragen.push({ methode: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/auth/instant-trial') {
        res.end(JSON.stringify({
          api_key: TRIAL_KEY, instance_id: TRIAL_INSTANZ, trial: true,
          trial_ends_at: new Date(Date.now() + 14 * 864e5).toISOString(),
        }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  attrappeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

// ── Umgebung je Test ────────────────────────────────────────────────────────

let heim: string;
const aufraeumen: string[] = [];
const tmp = (name: string) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), `cachly-${name}-`)); aufraeumen.push(p); return p; };

/** Ein Projekt mit Git-Ordner und GitHub-Remote (dann schreibt die Erweiterung auch den CI-Workflow). */
function neuesProjekt(): string {
  const root = tmp('projekt');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
  return root;
}

beforeEach(() => {
  anfragen.length = 0;
  heim = tmp('heim');
  (globalThis as { __CACHLY_TEST_HOME?: string }).__CACHLY_TEST_HOME = heim;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { __CACHLY_TEST_HOME?: string }).__CACHLY_TEST_HOME;
  for (const p of aufraeumen.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function lade() {
  vi.resetModules();
  // Die Attrappe ueber den Namen `vscode` holen: vitest merkt sich das Ergebnis der Mock-Fabrik,
  // und die Erweiterung bekommt dieselbe. Ihr Zustand wird zwischen den Tests zurueckgesetzt.
  const fake = (await import('vscode')) as unknown as typeof import('./__fixtures__/fakeVscode');
  fake.zuruecksetzen();
  const ext = await import('./extension');
  fake.zustand.config['cachly.apiUrl'] = attrappeUrl;
  return { fake, ext };
}

function kontext() {
  const speicher = new Map<string, unknown>();
  const zustandsspeicher = {
    get: (k: string, standard?: unknown) => (speicher.has(k) ? speicher.get(k) : standard),
    update: async (k: string, v: unknown) => { speicher.set(k, v); },
    keys: () => [...speicher.keys()],
  };
  return {
    subscriptions: [] as Array<{ dispose(): void }>,
    extensionPath: ERWEITERUNG,
    extension: { packageJSON: PAKET },
    globalState: zustandsspeicher,
    workspaceState: zustandsspeicher,
  } as never;
}

/** Wartet (echte Zeit, setImmediate), bis die Bedingung gilt. Die Zeitgeber der Erweiterung laufen im Test mit falscher Uhr. */
async function warteBis(bedingung: () => boolean, was: string, ms = 8000): Promise<void> {
  const ende = Date.now() + ms;
  while (!bedingung()) {
    if (Date.now() > ende) throw new Error(`Zeit abgelaufen: ${was}`);
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((r) => setImmediate(r));
  }
}

const homeDatei = (...t: string[]) => path.join(heim, ...t);
const credentials = () => JSON.parse(fs.readFileSync(homeDatei('.cachly', 'credentials.json'), 'utf8')) as { apiKey: string; instanceId?: string };

// ── 1. Workspace Trust ──────────────────────────────────────────────────────

describe('package.json deklariert Workspace Trust', () => {
  it('untrustedWorkspaces: limited, mit Beschreibung (VS Code verlangt sie fuer "limited")', () => {
    const p = JSON.parse(fs.readFileSync(path.join(ERWEITERUNG, 'package.json'), 'utf8'));
    expect(p.capabilities.untrustedWorkspaces.supported).toBe('limited');
    expect(p.capabilities.untrustedWorkspaces.description).toMatch(/Restricted Mode/);
    // die Adresse der API darf eine Arbeitsbereichs-Einstellung im eingeschraenkten Modus nicht umlenken
    expect(p.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain('cachly.apiUrl');
  });
});

describe('Restricted Mode (Ordner nicht vertraut)', () => {
  it('schreibt keine Datei, legt kein Konto an, schickt keine Anfrage — und weist auf das Vertrauen hin', async () => {
    const root = neuesProjekt();
    const { fake, ext } = await lade();
    fake.zustand.isTrusted = false;
    fake.zustand.ordner = [root];
    fake.zustand.antwort = () => undefined; // Meldung weggeklickt

    ext.activate(kontext());
    await vi.advanceTimersByTimeAsync(120_000); // zwei Minuten, wie in der Probe
    await new Promise((r) => setImmediate(r));

    // nichts geschrieben, kein Konto, kein Netz
    expect(alleDateien(root)).toEqual(['.git/config']);
    expect(fs.readdirSync(heim)).toEqual([]);
    expect(anfragen).toEqual([]);
    expect(fake.zustand.config['cachly.apiKey']).toBeUndefined();
    expect(fake.zustand.config['cachly.instanceId']).toBeUndefined();

    // ein Hinweis in der Statusleiste, der den Vertrauensdialog oeffnet
    const eintraege = fake.zustand.statusEintraege.filter((e) => e.sichtbar);
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0].text).toMatch(/trust this folder/);
    expect(eintraege[0].command).toBe(VERTRAUEN_BEFEHL);

    // eine einmalige Meldung mit Knopf
    expect(fake.zustand.meldungen).toHaveLength(1);
    expect(fake.zustand.meldungen[0].text).toMatch(/Restricted Mode/);
    expect(fake.zustand.meldungen[0].knoepfe).toEqual([VERTRAUEN_KNOPF]);
  });

  it('der Knopf oeffnet den Vertrauensdialog (workbench.trust.manage)', async () => {
    const { fake, ext } = await lade();
    fake.zustand.isTrusted = false;
    fake.zustand.ordner = [neuesProjekt()];
    fake.zustand.antwort = (_t, knoepfe) => knoepfe[0];
    ext.activate(kontext());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fake.zustand.ausgefuehrt.map((a) => a.id)).toContain('workbench.trust.manage');
  });

  it('jeder Befehl der Erweiterung ist ein Platzhalter, der das Vertrauen erklaert (nicht "Befehl nicht gefunden")', async () => {
    const root = neuesProjekt();
    const { fake, ext } = await lade();
    fake.zustand.isTrusted = false;
    fake.zustand.ordner = [root];
    ext.activate(kontext());
    for (const c of PAKET.contributes.commands) expect(fake.zustand.befehle.has(c.command), c.command).toBe(true);
    expect(fake.zustand.befehle.has('cachly.linkAccount')).toBe(true);
    // GROW-024: nach Ablauf des Test-Brains ist "Link Account" der Weg zum Konto —
    // ohne Eintrag in package.json fand ihn die Befehlspalette nicht.
    expect(PAKET.contributes.commands.map((c) => c.command)).toContain('cachly.linkAccount');
    expect(fake.zustand.chatTeilnehmer).toEqual(['cachly.brain']);

    const vorher = fake.zustand.meldungen.length;
    await fake.commands.executeCommand('cachly.setup');
    expect(fake.zustand.meldungen.length).toBe(vorher + 1);
    expect(alleDateien(root)).toEqual(['.git/config']);
    expect(anfragen).toEqual([]);
  });

  it('nach dem Vertrauen laeuft der bisherige Weg: Konto, Heim-Ablage, Projektdateien — ohne Schluessel im Projekt', async () => {
    const root = neuesProjekt();
    const { fake, ext } = await lade();
    fake.zustand.isTrusted = false;
    fake.zustand.ordner = [root];
    ext.activate(kontext());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(anfragen).toEqual([]);

    fake.vertrauenGewaehren();
    // Platzhalter und Hinweis sind weg, der volle Weg ist da
    expect(fake.zustand.statusEintraege[0].entsorgt).toBe(true);
    expect(fake.zustand.befehle.has('cachly.setup')).toBe(true);

    await warteBis(() => fs.existsSync(homeDatei('.cachly', 'credentials.json')), 'Konto angelegt und Schluessel im Heimordner');
    await warteBis(() => fs.existsSync(path.join(root, '.mcp.json')) && fs.existsSync(path.join(root, '.claude', 'settings.json')), 'Projektdateien geschrieben');

    expect(anfragen.some((a) => a.methode === 'POST' && a.url === '/auth/instant-trial')).toBe(true);
    expect(fake.zustand.config['cachly.apiKey']).toBe(TRIAL_KEY);
    expect(credentials()).toEqual({ apiKey: TRIAL_KEY, instanceId: TRIAL_INSTANZ });
    expect(dateienMit(root, TRIAL_KEY)).toEqual([]);
    ext.deactivate();
  });
});

// ── 2. Kein Schluessel in Projektdateien ────────────────────────────────────

describe('Schreibwege der Erweiterung (writeWorkspaceFiles)', () => {
  async function schreibe(opts: { vscodeVersion?: string } = {}) {
    const root = neuesProjekt();
    const { fake, ext } = await lade();
    fake.zustand.ordner = [root];
    fake.zustand.config['cachly.apiKey'] = LIVE_KEY;
    fake.zustand.config['cachly.instanceId'] = INSTANZ;
    if (opts.vscodeVersion) fake.setzeVersion(opts.vscodeVersion);
    ext.activate(kontext());
    const copilot = await ext.writeWorkspaceFiles(attrappeUrl, LIVE_KEY, INSTANZ);
    return { root, fake, ext, copilot };
  }

  it('keine Projektdatei enthaelt den Schluessel (alle Schreibwege, auch unter .git/)', async () => {
    const { root, ext } = await schreibe();
    expect(dateienMit(root, LIVE_KEY)).toEqual([]);
    expect(dateienMit(root, 'cky_')).toEqual([]);
    // Das Buendel nennt die Variable (es liest sie), enthaelt aber keinen Wert; jede andere Datei nennt sie nicht.
    expect(dateienMit(root, 'CACHLY_JWT').filter((f) => !f.endsWith('cachly-ambient-einblendung.mjs'))).toEqual([]);
    // und die Schreibwege sind wirklich gelaufen
    expect(alleDateien(root)).toEqual(expect.arrayContaining([
      '.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md', '.windsurfrules', '.clinerules',
      '.cursor/rules/cachly.mdc', '.vscode/settings.json', '.git/hooks/post-commit', '.github/workflows/cachly.yml',
      '.claude/settings.json', '.claude/hooks/cachly-ambient-einblendung.mjs',
      '.claude/hooks/cachly-ambient-session-start.mjs', '.claude/hooks/cachly-ambient-prompt-submit.mjs',
      '.claude/hooks/cachly-ambient-pre-tool.mjs', '.claude/hooks/cachly-ambient-stop.mjs',
    ]));
    ext.deactivate();
  });

  it('.mcp.json traegt nur Adresse und Kennung; der Schluessel liegt im Heimordner', async () => {
    const { root, ext } = await schreibe();
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.cachly.env).toEqual({ CACHLY_API_URL: attrappeUrl, CACHLY_BRAIN_INSTANCE_ID: INSTANZ });
    expect(credentials()).toEqual({ apiKey: LIVE_KEY, instanceId: INSTANZ });
    ext.deactivate();
  });

  it('Hooks: v5-Skripte mit Buendel, Git-Hook v3 — beide ohne Schluessel', async () => {
    const { root, ext } = await schreibe();
    const skript = fs.readFileSync(path.join(root, '.claude', 'hooks', 'cachly-ambient-prompt-submit.mjs'), 'utf8');
    expect(skript).toContain('UserPromptSubmit v5');
    expect(skript).toContain("await import('./cachly-ambient-einblendung.mjs');");
    expect(skript).not.toContain('npx');
    const git = fs.readFileSync(path.join(root, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(git).toContain('Continuous Learning Stream v3');
    expect(git).not.toContain('CACHLY_JWT');
    ext.deactivate();
  });

  it('der geschriebene Hook findet den Schluessel zur Laufzeit im Heimordner (echter Prozess, Attrappe)', async () => {
    const { root, ext } = await schreibe();
    const skript = path.join(root, '.claude', 'hooks', 'cachly-ambient-prompt-submit.mjs');
    expect(fs.readFileSync(skript, 'utf8')).not.toContain(LIVE_KEY);

    const env: Record<string, string> = {};
    for (const k of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[k]) env[k] = process.env[k] as string;
    }
    Object.assign(env, { HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: root, CACHLY_API_URL: attrappeUrl });
    anfragen.length = 0;
    await new Promise<void>((fertig) => {
      const kind = spawn(process.execPath, [skript], { env, cwd: root });
      kind.on('close', () => fertig());
      kind.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'wie behebe ich den fehlgeschlagenen Deploy', session_id: 's1', cwd: root }));
    });

    // Kein Schluessel in der Datei, keiner in der Umgebung — und trotzdem kommt er an der Gegenstelle an.
    const mitSchluessel = anfragen.filter((a) => a.authorization === `Bearer ${LIVE_KEY}`);
    expect(mitSchluessel.length, JSON.stringify(anfragen)).toBeGreaterThan(0);
    expect(anfragen.filter((a) => a.authorization && a.authorization !== `Bearer ${LIVE_KEY}`)).toEqual([]);
    // die Instanz kam aus dem Skript (process.env.CACHLY_BRAIN_INSTANCE_ID), nicht aus der Umgebung
    expect(anfragen.some((a) => a.url.includes(INSTANZ))).toBe(true);
    ext.deactivate();
  });

  it('Copilot-Weg (.vscode/mcp.json, VS Code vor 1.118): Verweis auf die Heim-Datei, kein Schluessel im Projekt', async () => {
    const { root, ext, copilot } = await schreibe({ vscodeVersion: '1.100.0' });
    expect(copilot?.weg).toBe('vscode-mcp-json');
    const vs = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8'));
    expect(vs.servers.cachly.envFile).toBe('${userHome}/.cachly/vscode-mcp.env');
    expect(JSON.stringify(vs)).not.toContain(LIVE_KEY);
    expect(fs.readFileSync(homeDatei('.cachly', 'vscode-mcp.env'), 'utf8')).toContain(LIVE_KEY); // im Heimordner, nicht im Projekt
    expect(dateienMit(root, LIVE_KEY)).toEqual([]);
    ext.deactivate();
  });

  it('liegt im Heimordner schon ein ANDERER Schluessel: nicht ueberschrieben, keiner im Projekt, Rueckfrage — und auf "Ja" ersetzt', async () => {
    const root = neuesProjekt();
    fs.mkdirSync(homeDatei('.cachly'), { recursive: true });
    fs.writeFileSync(homeDatei('.cachly', 'credentials.json'), JSON.stringify({ apiKey: ANDERER_KEY, instanceId: 'fremde-instanz' }));
    const { fake, ext } = await lade();
    fake.zustand.ordner = [root];
    fake.zustand.config['cachly.apiKey'] = LIVE_KEY;
    fake.zustand.config['cachly.instanceId'] = INSTANZ;
    fake.zustand.antwort = () => undefined; // erst "Schliessen"
    ext.activate(kontext());
    await ext.writeWorkspaceFiles(attrappeUrl, LIVE_KEY, INSTANZ);

    expect(credentials().apiKey).toBe(ANDERER_KEY);
    expect(dateienMit(root, LIVE_KEY)).toEqual([]);
    expect(dateienMit(root, ANDERER_KEY)).toEqual([]);
    const frage = fake.zustand.meldungen.find((m) => /different cachly key/.test(m.text));
    expect(frage?.knoepfe).toEqual(["Use this extension's key", 'Keep the other key']);
    ext.deactivate();

    // Neue Sitzung, der Mensch antwortet mit "Use this extension's key".
    const zwei = await lade();
    zwei.fake.zustand.ordner = [root];
    zwei.fake.zustand.config['cachly.apiKey'] = LIVE_KEY;
    zwei.fake.zustand.config['cachly.instanceId'] = INSTANZ;
    zwei.fake.zustand.antwort = (_t, k) => k.find((x) => /Use this extension/.test(x));
    zwei.ext.activate(kontext());
    await zwei.ext.writeWorkspaceFiles(attrappeUrl, LIVE_KEY, INSTANZ);
    await warteBis(() => credentials().apiKey === LIVE_KEY, 'Schluessel im Heimordner ersetzt');
    expect(dateienMit(root, LIVE_KEY)).toEqual([]);
    zwei.ext.deactivate();
  });

  it('nicht vertrauter Ordner: writeWorkspaceFiles schreibt auch bei direktem Aufruf nichts', async () => {
    const root = neuesProjekt();
    const { fake, ext } = await lade();
    fake.zustand.ordner = [root];
    ext.activate(kontext());
    fake.zustand.isTrusted = false;
    await ext.writeWorkspaceFiles(attrappeUrl, LIVE_KEY, INSTANZ);
    expect(alleDateien(root)).toEqual(['.git/config']);
    expect(fs.readdirSync(heim)).toEqual([]);
    ext.deactivate();
  });
});

// ── 3. Altbestand ───────────────────────────────────────────────────────────

describe('Altbestand beim Start (Projekt aus 0.12.6)', () => {
  async function start(root: string, key: string) {
    const { fake, ext } = await lade();
    fake.zustand.ordner = [root];
    fake.zustand.config['cachly.apiKey'] = key;
    fake.zustand.config['cachly.instanceId'] = INSTANZ;
    ext.activate(kontext());
    return { fake, ext };
  }

  it('nimmt den Schluessel aus allen Projektdateien, legt ihn im Heimordner ab und meldet es einmal', async () => {
    const root = legeAltprojektAn({ mitFremdem: true });
    aufraeumen.push(root);
    expect(dateienMit(root, SCHLUESSEL).length).toBe(6); // Vorbedingung: der alte Stand traegt ihn

    const { fake, ext } = await start(root, SCHLUESSEL);
    await warteBis(() => fake.zustand.meldungen.some((m) => m.text.startsWith(ALTBESTAND_MELDUNG)), 'Meldung zum Altbestand');

    expect(dateienMit(root, SCHLUESSEL)).toEqual([]);
    expect(credentials().apiKey).toBe(SCHLUESSEL);
    const meldungen = fake.zustand.meldungen.filter((m) => m.text.includes('stored in project files'));
    expect(meldungen).toHaveLength(1);
    expect(meldungen[0].text).toBe(
      'Your cachly key was stored in project files. It has been moved to your home folder. If you committed those files, rotate the key at cachly.dev.',
    );
    // Fremdes bleibt
    expect(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.fremd.env.TOKEN).toBe('bleibt');
    expect(fs.readFileSync(path.join(root, '.git', 'hooks', 'post-commit'), 'utf8')).toContain(FREMDER_GIT_HOOK.split('\n')[1]);
    ext.deactivate();
  });

  it('meldet nichts, wenn nichts gefunden wurde (sauberes Projekt)', async () => {
    const root = neuesProjekt();
    const { fake, ext } = await start(root, LIVE_KEY);
    await vi.advanceTimersByTimeAsync(3_000);
    await new Promise((r) => setImmediate(r));
    expect(fake.zustand.meldungen.filter((m) => m.text.includes('stored in project files'))).toEqual([]);
    expect(alleDateien(root)).toEqual(['.git/config']);
    ext.deactivate();
  });

  it('fasst einen fremden Schluessel nicht an und meldet nichts', async () => {
    const root = legeAltprojektAn({ schluessel: ANDERER_KEY });
    aufraeumen.push(root);
    const vorher = alleDateien(root).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
    const { fake, ext } = await start(root, LIVE_KEY);
    await vi.advanceTimersByTimeAsync(3_000);
    await new Promise((r) => setImmediate(r));
    expect(fake.zustand.meldungen.filter((m) => m.text.includes('stored in project files'))).toEqual([]);
    expect(alleDateien(root).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')])).toEqual(vorher);
    ext.deactivate();
  });
});
