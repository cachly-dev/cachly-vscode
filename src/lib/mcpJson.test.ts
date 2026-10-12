import { describe, it, expect } from 'vitest';
import { cachlyMcpEintrag, entferneSchluesselAusMcpJson, fuegeInMcpJsonEin } from './mcpJson';

const KEY = 'cky_live_abcdef1234567890';
const INST = '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0';

describe('fuegeInMcpJsonEin', () => {
  it('schreibt nur Adresse und Kennung, nie einen Schluessel', () => {
    const e = cachlyMcpEintrag('https://api.cachly.dev', INST);
    expect(e.env).toEqual({ CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_BRAIN_INSTANCE_ID: INST });
    const text = fuegeInMcpJsonEin(undefined, 'https://api.cachly.dev', INST);
    expect(text).not.toContain('CACHLY_JWT');
    expect(JSON.parse(text).mcpServers.cachly.env).toEqual(e.env);
  });

  it('laesst fremde Server stehen und ersetzt einen alten cachly-Eintrag samt Schluessel', () => {
    const vorher = JSON.stringify({
      mcpServers: {
        other: { command: 'x', env: { TOKEN: 'keep' } },
        cachly: { command: 'npx', args: ['-y', 'x'], env: { CACHLY_JWT: KEY, CACHLY_BRAIN_INSTANCE_ID: 'old' } },
      },
    });
    const text = fuegeInMcpJsonEin(vorher, 'https://api.cachly.dev', INST);
    expect(text).not.toContain(KEY);
    const j = JSON.parse(text);
    expect(j.mcpServers.other).toEqual({ command: 'x', env: { TOKEN: 'keep' } });
    expect(j.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INST);
  });

  it('beginnt neu, wenn die Datei kein JSON ist (wie bisher)', () => {
    expect(JSON.parse(fuegeInMcpJsonEin('{ kaputt', 'https://a', INST)).mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INST);
  });
});

describe('entferneSchluesselAusMcpJson', () => {
  const unsere = (k: string) => k === KEY;
  const alt = (extra: Record<string, unknown> = {}) =>
    JSON.stringify(
      {
        mcpServers: {
          other: { command: 'o', env: { CACHLY_JWT: 'gehoert-einem-anderen-server' } },
          cachly: { command: 'npx', args: ['-y', 'p'], env: { CACHLY_API_URL: 'https://a', CACHLY_JWT: KEY, CACHLY_BRAIN_INSTANCE_ID: INST, EIGENE: 'bleibt' } },
        },
        ...extra,
      },
      null,
      2,
    );

  it('nimmt nur den Schluessel des cachly-Eintrags heraus', () => {
    const r = entferneSchluesselAusMcpJson(alt(), unsere);
    expect(r.zustand).toBe('bereinigt');
    if (r.zustand !== 'bereinigt') return;
    expect(r.schluessel).toBe(KEY);
    expect(r.text).not.toContain(KEY);
    const j = JSON.parse(r.text);
    expect(j.mcpServers.cachly.env).toEqual({ CACHLY_API_URL: 'https://a', CACHLY_BRAIN_INSTANCE_ID: INST, EIGENE: 'bleibt' });
    // der Eintrag eines anderen Servers wird nicht angefasst, auch wenn er die gleiche Variable traegt
    expect(j.mcpServers.other.env.CACHLY_JWT).toBe('gehoert-einem-anderen-server');
  });

  it('bereinigt auch .vscode/mcp.json (servers statt mcpServers)', () => {
    const text = JSON.stringify({ servers: { cachly: { type: 'stdio', env: { CACHLY_JWT: KEY }, envFile: '${userHome}/.cachly/vscode-mcp.env' } }, inputs: [] });
    const r = entferneSchluesselAusMcpJson(text, unsere);
    expect(r.zustand).toBe('bereinigt');
    if (r.zustand !== 'bereinigt') return;
    const j = JSON.parse(r.text);
    expect(j.servers.cachly.envFile).toBe('${userHome}/.cachly/vscode-mcp.env');
    expect(j.inputs).toEqual([]);
    expect(r.text).not.toContain(KEY);
  });

  it('fasst eine Datei mit einem fremden Schluessel nicht an', () => {
    const r = entferneSchluesselAusMcpJson(alt(), (k) => k === 'cky_live_anderer');
    expect(r).toEqual({ zustand: 'fremd', schluessel: KEY });
  });

  it('meldet "sauber", wenn kein Schluessel drinsteht, auch bei Platzhaltern', () => {
    expect(entferneSchluesselAusMcpJson(undefined, unsere).zustand).toBe('sauber');
    expect(entferneSchluesselAusMcpJson('', unsere).zustand).toBe('sauber');
    expect(entferneSchluesselAusMcpJson(fuegeInMcpJsonEin(undefined, 'https://a', INST), unsere).zustand).toBe('sauber');
    const platzhalter = JSON.stringify({ mcpServers: { cachly: { env: { CACHLY_JWT: '${CACHLY_JWT}' } } } });
    expect(entferneSchluesselAusMcpJson(platzhalter, () => true).zustand).toBe('sauber');
  });

  it('schreibt eine Datei mit Kommentaren NICHT um, sagt aber, dass sie offen ist', () => {
    const mitKommentar = `{\n  // mein Server\n  "mcpServers": { "cachly": { "env": { "CACHLY_JWT": "${KEY}" } } }\n}`;
    expect(entferneSchluesselAusMcpJson(mitKommentar, unsere)).toEqual({ zustand: 'offen', schluessel: KEY });
  });

  it('erkennt eine Datei mit Byte-Order-Marke', () => {
    expect(entferneSchluesselAusMcpJson(String.fromCharCode(0xfeff) + alt(), unsere).zustand).toBe('bereinigt');
  });

  it('behaelt das Zeilenende am Dateiende bei (kleinster Unterschied im Git-Stand)', () => {
    const mit = entferneSchluesselAusMcpJson(alt() + '\n', unsere);
    const ohne = entferneSchluesselAusMcpJson(alt(), unsere);
    if (mit.zustand !== 'bereinigt' || ohne.zustand !== 'bereinigt') throw new Error('erwartet: bereinigt');
    expect(mit.text.endsWith('\n')).toBe(true);
    expect(ohne.text.endsWith('\n')).toBe(false);
  });
});
