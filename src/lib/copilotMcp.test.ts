import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  bindeCopilotAn,
  cachlyServerEintrag,
  fuegeCachlyEin,
  hatCachlyEintrag,
  hatCopilot,
  liestWurzelMcpJson,
  nodeDateiZugriff,
  schluesselDateiPfad,
  verbindungsSatz,
  versionMindestens,
  SCHLUESSEL_DATEI_VERWEIS,
  type AnbindungsEingabe,
  type DateiZugriff,
} from './copilotMcp';

const INSTANZ = '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0';
const ALTE_INSTANZ = '11111111-2222-4333-8444-555555555555';
const KEY = 'cky_trial_abc123XYZ';

describe('versionMindestens / liestWurzelMcpJson', () => {
  it('VS Code reads the root .mcp.json from 1.118 on, not before', () => {
    expect(liestWurzelMcpJson('1.118.0')).toBe(true);
    expect(liestWurzelMcpJson('1.140.1')).toBe(true);
    expect(liestWurzelMcpJson('1.117.9')).toBe(false);
    expect(liestWurzelMcpJson('1.85.0')).toBe(false);
  });

  it('ignores the -insider suffix and compares numbers, not text', () => {
    expect(versionMindestens('1.118.0-insider', '1.118.0')).toBe(true);
    expect(versionMindestens('1.99.0', '1.105.0')).toBe(false);
    expect(versionMindestens('2.0.0', '1.118.0')).toBe(true);
  });
});

describe('hatCopilot', () => {
  it('is true for VS Code and Insiders, false for forks without Copilot', () => {
    expect(hatCopilot('Visual Studio Code')).toBe(true);
    expect(hatCopilot('Visual Studio Code - Insiders')).toBe(true);
    expect(hatCopilot('Cursor')).toBe(false);
    expect(hatCopilot('Windsurf')).toBe(false);
    expect(hatCopilot('VSCodium')).toBe(false);
  });
});

describe('cachlyServerEintrag', () => {
  it('is a VS Code stdio entry whose key comes from the env file in the home folder', () => {
    const e = cachlyServerEintrag(INSTANZ);
    expect(e).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@cachly-dev/mcp-server@latest'],
      env: { CACHLY_BRAIN_INSTANCE_ID: INSTANZ },
      envFile: '${userHome}/.cachly/vscode-mcp.env',
    });
  });

  it('adds CACHLY_API_URL only for a self-hosted backend', () => {
    expect(cachlyServerEintrag(INSTANZ, 'https://api.cachly.dev/').env.CACHLY_API_URL).toBeUndefined();
    expect(cachlyServerEintrag(INSTANZ, 'https://brain.example.org').env.CACHLY_API_URL).toBe('https://brain.example.org');
  });
});

describe('fuegeCachlyEin', () => {
  const eintrag = cachlyServerEintrag(INSTANZ);

  it('creates a new file with a "servers" object (not "mcpServers") and no key', () => {
    const r = fuegeCachlyEin(undefined, eintrag);
    expect(r.zustand).toBe('neu');
    if (r.zustand === 'kaputt') throw new Error('unexpected');
    const daten = JSON.parse(r.text);
    expect(daten).toEqual({ servers: { cachly: eintrag } });
    expect(r.text).not.toContain('CACHLY_JWT');
    expect(r.text).not.toContain('cky_');
  });

  it('adds cachly next to another server and keeps that server and the inputs untouched', () => {
    const anderer = {
      type: 'stdio', command: 'npx', args: ['-y', 'server-perplexity-ask'],
      env: { PERPLEXITY_API_KEY: '${input:perplexity-key}' },
    };
    const inputs = [{ type: 'promptString', id: 'perplexity-key', description: 'Perplexity API Key', password: true }];
    const vorher = JSON.stringify({ inputs, servers: { perplexity: anderer } }, null, 4);
    const r = fuegeCachlyEin(vorher, eintrag);
    expect(r.zustand).toBe('ergaenzt');
    if (r.zustand === 'kaputt') throw new Error('unexpected');
    const daten = JSON.parse(r.text);
    expect(daten.inputs).toEqual(inputs);
    expect(daten.servers.perplexity).toEqual(anderer);
    expect(daten.servers.cachly).toEqual(eintrag);
  });

  it('updates an existing cachly entry: new instance, plaintext key removed, own fields kept', () => {
    const vorher = JSON.stringify({
      servers: {
        cachly: {
          type: 'stdio', command: 'npx', args: ['-y', '@cachly-dev/mcp-server'],
          env: { CACHLY_JWT: 'cky_live_old', CACHLY_BRAIN_INSTANCE_ID: ALTE_INSTANZ, CACHLY_DEBUG: '1' },
          dev: { watch: 'dist/**/*.js' },
        },
        andere: { type: 'http', url: 'https://example.org/mcp' },
      },
    });
    const r = fuegeCachlyEin(vorher, eintrag);
    expect(r.zustand).toBe('aktualisiert');
    if (r.zustand === 'kaputt') throw new Error('unexpected');
    const cachly = JSON.parse(r.text).servers.cachly;
    expect(cachly.env).toEqual({ CACHLY_DEBUG: '1', CACHLY_BRAIN_INSTANCE_ID: INSTANZ });
    expect(cachly.dev).toEqual({ watch: 'dist/**/*.js' });
    expect(cachly.args).toEqual(['-y', '@cachly-dev/mcp-server@latest']);
    expect(cachly.envFile).toBe(SCHLUESSEL_DATEI_VERWEIS);
    expect(JSON.parse(r.text).servers.andere).toEqual({ type: 'http', url: 'https://example.org/mcp' });
    expect(r.text).not.toContain('cky_live_old');
  });

  it('reports "unchanged" on a second run and returns the text as it was', () => {
    const erst = fuegeCachlyEin(undefined, eintrag);
    if (erst.zustand === 'kaputt') throw new Error('unexpected');
    const zweit = fuegeCachlyEin(erst.text, eintrag);
    expect(zweit).toEqual({ zustand: 'unveraendert', text: erst.text });
  });

  it('never rewrites a broken file — it reports why instead', () => {
    expect(fuegeCachlyEin('{ "servers": { "x": ', eintrag)).toEqual({ zustand: 'kaputt', grund: 'it is not valid JSON' });
    expect(fuegeCachlyEin('[]', eintrag)).toEqual({ zustand: 'kaputt', grund: 'its top level is not an object' });
    expect(fuegeCachlyEin('{"servers": []}', eintrag)).toEqual({ zustand: 'kaputt', grund: '"servers" is not an object' });
  });

  it('leaves a JSONC file with comments alone, because rewriting would delete the comments', () => {
    const mitKommentar = '{\n  // my servers\n  "servers": {}\n}\n';
    const r = fuegeCachlyEin(mitKommentar, eintrag);
    expect(r.zustand).toBe('kaputt');
  });
});

describe('hatCachlyEintrag', () => {
  it('finds a cachly server, also in JSONC; broken or missing files have none', () => {
    expect(hatCachlyEintrag('{"servers":{"cachly":{"command":"npx"}}}')).toBe(true);
    expect(hatCachlyEintrag('{ // c\n "servers": {"cachly": {}} }')).toBe(true);
    expect(hatCachlyEintrag('{"servers":{"other":{}}}')).toBe(false);
    expect(hatCachlyEintrag('{ broken')).toBe(false);
    expect(hatCachlyEintrag(undefined)).toBe(false);
  });
});

describe('bindeCopilotAn (real files in a temp folder)', () => {
  let wurzel: string;
  let projekt: string;
  let home: string;
  let schreibvorgaenge: string[];
  let zugriff: DateiZugriff;

  const eingabe = (teil: Partial<AnbindungsEingabe> = {}): AnbindungsEingabe => ({
    arbeitsordner: projekt,
    mcpJsonOrdner: projekt,
    vscodeVersion: '1.117.0',
    appName: 'Visual Studio Code',
    apiKey: KEY,
    instanceId: INSTANZ,
    apiUrl: 'https://api.cachly.dev',
    home,
    ...teil,
  });
  const mcpDatei = () => path.join(projekt, '.vscode', 'mcp.json');

  beforeEach(() => {
    wurzel = mkdtempSync(path.join(tmpdir(), 'cachly-copilot-'));
    projekt = path.join(wurzel, 'projekt');
    home = path.join(wurzel, 'home');
    mkdirSync(projekt, { recursive: true });
    schreibvorgaenge = [];
    zugriff = {
      lesen: nodeDateiZugriff.lesen,
      schreiben: async (p, inhalt, geheim) => {
        schreibvorgaenge.push(p);
        await nodeDateiZugriff.schreiben(p, inhalt, geheim);
      },
    };
  });
  afterEach(() => rmSync(wurzel, { recursive: true, force: true }));

  it('VS Code before 1.118: writes .vscode/mcp.json, and the key only into the home folder', async () => {
    const a = await bindeCopilotAn(eingabe(), zugriff);
    expect(a).toEqual({ weg: 'vscode-mcp-json', zustand: 'neu', datei: mcpDatei(), startetSelbst: true });

    const projektText = readFileSync(mcpDatei(), 'utf8');
    expect(JSON.parse(projektText).servers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INSTANZ);
    expect(projektText).not.toContain(KEY);
    // Gitignore case does not apply: nothing secret lands in the project.
    expect(existsSync(path.join(projekt, '.gitignore'))).toBe(false);

    const schluessel = readFileSync(schluesselDateiPfad(home), 'utf8');
    expect(schluessel).toContain(`CACHLY_JWT=${KEY}\n`);
  });

  it('VS Code 1.118+ with .mcp.json at the folder root: writes nothing (that file already reaches Copilot)', async () => {
    const a = await bindeCopilotAn(eingabe({ vscodeVersion: '1.140.0' }), zugriff);
    expect(a).toEqual({ weg: 'mcp-json', startetSelbst: true });
    expect(schreibvorgaenge).toEqual([]);
    expect(existsSync(mcpDatei())).toBe(false);
  });

  it('VS Code 1.118+ but .mcp.json went to a git root above the open folder: writes .vscode/mcp.json', async () => {
    const a = await bindeCopilotAn(eingabe({ vscodeVersion: '1.140.0', mcpJsonOrdner: wurzel }), zugriff);
    expect(a.weg).toBe('vscode-mcp-json');
    expect(existsSync(mcpDatei())).toBe(true);
  });

  it('VS Code 1.118+ keeps an existing cachly entry in .vscode/mcp.json current', async () => {
    mkdirSync(path.join(projekt, '.vscode'));
    writeFileSync(mcpDatei(), JSON.stringify({ servers: { cachly: { type: 'stdio', command: 'npx', env: { CACHLY_BRAIN_INSTANCE_ID: ALTE_INSTANZ } } } }));
    const a = await bindeCopilotAn(eingabe({ vscodeVersion: '1.140.0' }), zugriff);
    expect(a).toMatchObject({ weg: 'vscode-mcp-json', zustand: 'aktualisiert' });
    expect(JSON.parse(readFileSync(mcpDatei(), 'utf8')).servers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INSTANZ);
  });

  it('adds cachly to an existing file with another server and keeps that server', async () => {
    mkdirSync(path.join(projekt, '.vscode'));
    const anderer = { type: 'stdio', command: 'uvx', args: ['mcp-server-git'] };
    writeFileSync(mcpDatei(), JSON.stringify({ servers: { git: anderer } }));
    const a = await bindeCopilotAn(eingabe(), zugriff);
    expect(a).toMatchObject({ weg: 'vscode-mcp-json', zustand: 'ergaenzt' });
    const daten = JSON.parse(readFileSync(mcpDatei(), 'utf8'));
    expect(daten.servers.git).toEqual(anderer);
    expect(daten.servers.cachly.type).toBe('stdio');
  });

  it('leaves a broken .vscode/mcp.json byte for byte as it was and writes no key file', async () => {
    mkdirSync(path.join(projekt, '.vscode'));
    const kaputt = '{ "servers": { "git": { "command": "uvx", } ';
    writeFileSync(mcpDatei(), kaputt);
    const a = await bindeCopilotAn(eingabe(), zugriff);
    expect(a).toEqual({ weg: 'kaputt', datei: mcpDatei(), grund: 'it is not valid JSON' });
    expect(readFileSync(mcpDatei(), 'utf8')).toBe(kaputt);
    expect(schreibvorgaenge).toEqual([]);
  });

  it('second run: neither the project file nor the key file is written again', async () => {
    await bindeCopilotAn(eingabe(), zugriff);
    schreibvorgaenge = [];
    const a = await bindeCopilotAn(eingabe(), zugriff);
    expect(a).toMatchObject({ weg: 'vscode-mcp-json', zustand: 'unveraendert' });
    expect(schreibvorgaenge).toEqual([]);
  });

  it('a new key reaches the key file, the project file stays the same', async () => {
    await bindeCopilotAn(eingabe(), zugriff);
    const vorher = readFileSync(mcpDatei(), 'utf8');
    await bindeCopilotAn(eingabe({ apiKey: 'cky_live_neu999' }), zugriff);
    expect(readFileSync(mcpDatei(), 'utf8')).toBe(vorher);
    expect(readFileSync(schluesselDateiPfad(home), 'utf8')).toContain('CACHLY_JWT=cky_live_neu999\n');
  });

  it('writes nothing in Cursor, without an open folder, or with a key that would break the env file', async () => {
    expect(await bindeCopilotAn(eingabe({ appName: 'Cursor' }), zugriff)).toEqual({ weg: 'kein-copilot' });
    expect(await bindeCopilotAn(eingabe({ arbeitsordner: undefined }), zugriff)).toEqual({ weg: 'kein-ordner' });
    expect(await bindeCopilotAn(eingabe({ apiKey: 'cky_live_x\nCACHLY_BRAIN_INSTANCE_ID=evil' }), zugriff)).toEqual({ weg: 'kein-schluessel' });
    expect(schreibvorgaenge).toEqual([]);
  });

  it('before 1.105 the server does not start by itself — the message says so', async () => {
    const a = await bindeCopilotAn(eingabe({ vscodeVersion: '1.104.0' }), zugriff);
    expect(a).toMatchObject({ weg: 'vscode-mcp-json', startetSelbst: false });
    expect(verbindungsSatz(a)).toContain('"Start"');
  });
});

describe('verbindungsSatz', () => {
  it('promises no restart for Copilot only when VS Code starts the server by itself', () => {
    const s = verbindungsSatz({ weg: 'mcp-json', startetSelbst: true });
    expect(s).toContain('no restart');
    expect(s).toContain('Claude Code from its next session');
  });

  it('names the broken file and the reason instead of claiming success', () => {
    const s = verbindungsSatz({ weg: 'kaputt', datei: '/p/.vscode/mcp.json', grund: 'it is not valid JSON' });
    expect(s).toContain('not connected');
    expect(s).toContain('/p/.vscode/mcp.json');
    expect(s).toContain('it is not valid JSON');
  });

  it('falls back to the plain restart hint outside VS Code or when nothing is known', () => {
    expect(verbindungsSatz({ weg: 'kein-copilot' })).toBe('Restart your AI tool to activate memory.');
    expect(verbindungsSatz(undefined)).toBe('Restart your AI tool to activate memory.');
  });
});
