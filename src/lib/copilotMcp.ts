// Copilot an cachly anbinden — `.vscode/mcp.json`, vscode-frei und testbar.
//
// ── Warum (11.10.2026) ───────────────────────────────────────────────────────
//
// Die Erweiterung schrieb bisher nur `.mcp.json` (Format `mcpServers`), und
// zwar an die Git-Wurzel. Copilot in VS Code sieht diese Datei nur, wenn
// BEIDES stimmt:
//   1. VS Code ab 1.118 (29.04.2026). Erst seitdem liest VS Code `.mcp.json`
//      ("Workspace .mcp.json files and server deduplication", Release Notes
//      1.118). Davor laedt Copilot MCP-Server nur aus `.vscode/mcp.json`
//      (Format `servers`), und die schrieb niemand.
//   2. Die Datei liegt an der Wurzel des geoeffneten Ordners. VS Code sucht
//      `.mcp.json` nur dort (workspaceDotMcpDiscovery.ts). Wer `repo/app`
//      oeffnet, bekommt `.mcp.json` nach `repo/` — Copilot sieht nichts.
//
// Seit 1.140 (30.09.2026) nennt VS Code `.vscode/mcp.json` veraltet und bietet
// an, sie nach `.mcp.json` umzuziehen. Deshalb schreiben wir sie nur, wo sie
// gebraucht wird:
//   - VS Code vor 1.118, oder
//   - `.mcp.json` liegt nicht an der Wurzel des geoeffneten Ordners, oder
//   - in `.vscode/mcp.json` steht schon ein cachly-Eintrag. Der wird aktuell
//     gehalten; sonst arbeitet Copilot womoeglich mit einer alten Instanz.
//
// ── Der Schluessel ───────────────────────────────────────────────────────────
//
// Nie im Klartext in der Projektdatei. Der Eintrag verweist mit `envFile` auf
// `${userHome}/.cachly/vscode-mcp.env`; dort steht CACHLY_JWT. VS Code loest
// Variablen in der ganzen Server-Konfiguration auf (mcpRegistry.ts,
// _replaceVariablesInLaunch). Fehlt die Datei, startet VS Code den Server
// NICHT ("Failed to read envFile", extHostMcpNode.ts). Deshalb schreiben wir
// sie immer zuerst.
//
// ── Der Start ────────────────────────────────────────────────────────────────
//
// `npx -y @cachly-dev/mcp-server@latest`, wie in `.mcp.json` und im
// MCP-Setup. Gemessen unter Windows (11.10.2026): npx 22,5 s beim ersten
// Mal, 5,1 s danach; `node` direkt auf das Paket 2,0 bis 3,2 s. Einen
// festen Pfad gibt es nicht: die Erweiterung bringt den Server nicht mit, und
// der npx-Zwischenspeicher wechselt seinen Ordner mit jeder Version.
// VS Code startet den Server einmal je Fenster, nicht je Nachricht.

import { promises as fsp } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { DEFAULT_API_URL, normalizeBaseUrl, parseJsonc } from './config';
import { programmName } from './programm';

export const SERVER_NAME = 'cachly';

/** Ab dieser Version liest VS Code `.mcp.json` an der Ordnerwurzel. */
export const WURZEL_MCP_JSON_AB = '1.118.0';

/** Ab dieser Version startet VS Code neue MCP-Server selbst beim naechsten Chat (Release Notes 1.105). */
export const AUTOSTART_AB = '1.105.0';

/** So steht die Schluesseldatei in `.vscode/mcp.json`. VS Code ersetzt `${userHome}`. */
export const SCHLUESSEL_DATEI_VERWEIS = '${userHome}/.cachly/vscode-mcp.env';

/** Umgebungsvariablen, die allein dieser Eintrag verwaltet. Alle anderen bleiben stehen. */
const VERWALTETE_ENV = ['CACHLY_JWT', 'CACHLY_API_KEY', 'CACHLY_API_URL', 'CACHLY_BRAIN_INSTANCE_ID'];

export interface VsCodeStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  envFile: string;
}

export type Zusammenfuehrung =
  | { zustand: 'neu' | 'ergaenzt' | 'aktualisiert' | 'unveraendert'; text: string }
  | { zustand: 'kaputt'; grund: string };

export type CopilotAnbindung =
  /** Cursor, Windsurf, VSCodium …: dort gibt es kein Copilot, das `.vscode/mcp.json` liest. */
  | { weg: 'kein-copilot' }
  | { weg: 'kein-ordner' }
  | { weg: 'kein-schluessel' }
  /** VS Code ab 1.118 liest die `.mcp.json`, die die Erweiterung schon geschrieben hat. */
  | { weg: 'mcp-json'; startetSelbst: boolean }
  | { weg: 'vscode-mcp-json'; zustand: 'neu' | 'ergaenzt' | 'aktualisiert' | 'unveraendert'; datei: string; startetSelbst: boolean }
  /** `.vscode/mcp.json` gibt es, sie laesst sich aber nicht ohne Verlust umschreiben. Unangetastet. */
  | { weg: 'kaputt'; datei: string; grund: string };

/** Vergleicht "1.118.0" mit "1.118.0-insider" & Co. Nur die drei Zahlen zaehlen. */
export function versionMindestens(version: string, mindest: string): boolean {
  const teile = (v: string) => v.split(/[.-]/).slice(0, 3).map((t) => parseInt(t, 10) || 0);
  const a = teile(version);
  const b = teile(mindest);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function liestWurzelMcpJson(vscodeVersion: string): boolean {
  return versionMindestens(vscodeVersion, WURZEL_MCP_JSON_AB);
}

/** `vscode.env.appName`: "Visual Studio Code" oder "Visual Studio Code - Insiders" (programm.ts). */
export function hatCopilot(appName: string): boolean {
  return programmName(appName) === 'vscode';
}

export function cachlyServerEintrag(instanceId: string, apiUrl?: string): VsCodeStdioServer {
  const env: Record<string, string> = { CACHLY_BRAIN_INSTANCE_ID: instanceId };
  const url = normalizeBaseUrl(apiUrl);
  if (url !== DEFAULT_API_URL) env.CACHLY_API_URL = url;
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@cachly-dev/mcp-server@latest'],
    env,
    envFile: SCHLUESSEL_DATEI_VERWEIS,
  };
}

function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function gleich(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => gleich(x, b[i]));
  }
  if (istObjekt(a) && istObjekt(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && gleich(a[k], b[k]));
  }
  return a === b;
}

/**
 * Der alte Eintrag behaelt alles, was der Mensch selbst eingetragen hat
 * (`dev`, `sandboxEnabled`, eigene Umgebungsvariablen). Die cachly-Felder und
 * die verwalteten Variablen kommen neu — ein alter Klartext-Schluessel in
 * `env` faellt dabei heraus, sonst ueberdeckte er die Schluesseldatei.
 */
function mischeEintrag(alt: Record<string, unknown>, neu: VsCodeStdioServer): Record<string, unknown> {
  const altEnv = istObjekt(alt.env) ? alt.env : {};
  const behalten = Object.fromEntries(Object.entries(altEnv).filter(([k]) => !VERWALTETE_ENV.includes(k)));
  return { ...alt, ...neu, env: { ...behalten, ...neu.env } };
}

/**
 * Fuegt den cachly-Server in den Text einer `.vscode/mcp.json` ein.
 * Andere Server, `inputs` und alle uebrigen Felder bleiben, wie sie sind.
 * Eine Datei, die sich nicht verlustfrei lesen laesst, wird nicht angefasst.
 */
export function fuegeCachlyEin(vorhanden: string | undefined, eintrag: VsCodeStdioServer): Zusammenfuehrung {
  if (vorhanden === undefined || vorhanden.trim() === '') {
    return { zustand: 'neu', text: JSON.stringify({ servers: { [SERVER_NAME]: eintrag } }, null, 2) + '\n' };
  }
  let daten: unknown;
  try {
    daten = JSON.parse(vorhanden);
  } catch {
    // VS Code liest die Datei als JSONC. Kommentare wuerde unser Umschreiben
    // loeschen — also lassen wir sie stehen und sagen es.
    try {
      parseJsonc(vorhanden);
      return { zustand: 'kaputt', grund: 'it contains comments, which rewriting would delete' };
    } catch {
      return { zustand: 'kaputt', grund: 'it is not valid JSON' };
    }
  }
  if (!istObjekt(daten)) return { zustand: 'kaputt', grund: 'its top level is not an object' };
  const servers = daten.servers;
  if (servers !== undefined && !istObjekt(servers)) return { zustand: 'kaputt', grund: '"servers" is not an object' };

  const alt = servers?.[SERVER_NAME];
  const neuerEintrag = istObjekt(alt) ? mischeEintrag(alt, eintrag) : eintrag;
  if (alt !== undefined && gleich(alt, neuerEintrag)) return { zustand: 'unveraendert', text: vorhanden };

  const ergebnis = { ...daten, servers: { ...(servers ?? {}), [SERVER_NAME]: neuerEintrag } };
  return { zustand: alt === undefined ? 'ergaenzt' : 'aktualisiert', text: JSON.stringify(ergebnis, null, 2) + '\n' };
}

/** Steht in diesem Text schon ein cachly-Server? Kaputte Dateien: nein. */
export function hatCachlyEintrag(text: string | undefined): boolean {
  if (!text) return false;
  try {
    const servers = parseJsonc(text).servers;
    return istObjekt(servers) && istObjekt(servers[SERVER_NAME]);
  } catch {
    return false;
  }
}

/** Nur Zeichen, die ein Schluessel oder JWT enthaelt. Alles andere koennte die Zeile brechen. */
export function istSchreibbarerSchluessel(key: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(key);
}

export function schluesselDateiInhalt(apiKey: string): string {
  return (
    '# cachly: API key for the cachly MCP server that VS Code starts from .vscode/mcp.json (envFile).\n' +
    '# Written by the cachly extension. Keep this file private; it stays out of your project.\n' +
    `CACHLY_JWT=${apiKey}\n`
  );
}

export function schluesselDateiPfad(home: string): string {
  return path.join(home, '.cachly', 'vscode-mcp.env');
}

function gleicherOrdner(a: string, b: string): boolean {
  const n = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

export interface DateiZugriff {
  /** Inhalt, oder undefined, wenn es die Datei nicht gibt. */
  lesen(pfad: string): Promise<string | undefined>;
  /** Legt Ordner an. `geheim`: nur fuer den Besitzer lesbar (unter Windows ohne Wirkung). */
  schreiben(pfad: string, inhalt: string, geheim?: boolean): Promise<void>;
}

export const nodeDateiZugriff: DateiZugriff = {
  async lesen(pfad) {
    try {
      return await fsp.readFile(pfad, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  },
  async schreiben(pfad, inhalt, geheim) {
    await fsp.mkdir(path.dirname(pfad), { recursive: true });
    // Erst eine Nebendatei, dann umbenennen: ein Absturz hinterlaesst nie eine halbe Datei.
    const tmp = `${pfad}.${process.pid}-${Date.now()}.tmp`;
    await fsp.writeFile(tmp, inhalt, { encoding: 'utf8', mode: geheim ? 0o600 : 0o644 });
    await fsp.rename(tmp, pfad);
    if (geheim) {
      try { await fsp.chmod(pfad, 0o600); } catch { /* Windows */ }
    }
  },
};

export interface AnbindungsEingabe {
  /** Wurzel des geoeffneten VS-Code-Ordners, in dem gearbeitet wird. */
  arbeitsordner: string | undefined;
  /** Der Ordner, in den die Erweiterung gerade `.mcp.json` geschrieben hat. */
  mcpJsonOrdner: string;
  /** `vscode.version` */
  vscodeVersion: string;
  /** `vscode.env.appName` */
  appName: string;
  apiKey: string;
  instanceId: string;
  apiUrl?: string;
  /** Standard `os.homedir()` — dasselbe Verzeichnis, das VS Code fuer `${userHome}` einsetzt. Tests geben einen Temp-Ordner. */
  home?: string;
}

/**
 * Sorgt dafuer, dass Copilot in VS Code den cachly-Server sieht.
 * Schreibt `.vscode/mcp.json` nur, wenn `.mcp.json` dafuer nicht reicht.
 */
export async function bindeCopilotAn(e: AnbindungsEingabe, dateien: DateiZugriff = nodeDateiZugriff): Promise<CopilotAnbindung> {
  if (!hatCopilot(e.appName)) return { weg: 'kein-copilot' };
  if (!e.arbeitsordner) return { weg: 'kein-ordner' };
  const key = e.apiKey.trim();
  if (!key || !istSchreibbarerSchluessel(key)) return { weg: 'kein-schluessel' };

  const startetSelbst = versionMindestens(e.vscodeVersion, AUTOSTART_AB);
  const datei = path.join(e.arbeitsordner, '.vscode', 'mcp.json');
  const vorhanden = await dateien.lesen(datei);

  const wurzelReicht = liestWurzelMcpJson(e.vscodeVersion) && gleicherOrdner(e.arbeitsordner, e.mcpJsonOrdner);
  if (wurzelReicht && !hatCachlyEintrag(vorhanden)) return { weg: 'mcp-json', startetSelbst };

  const ergebnis = fuegeCachlyEin(vorhanden, cachlyServerEintrag(e.instanceId, e.apiUrl));
  if (ergebnis.zustand === 'kaputt') return { weg: 'kaputt', datei, grund: ergebnis.grund };

  // Die Schluesseldatei zuerst: ohne sie startet VS Code den Server nicht.
  const schluesselPfad = schluesselDateiPfad(e.home ?? homedir());
  const schluesselInhalt = schluesselDateiInhalt(key);
  if ((await dateien.lesen(schluesselPfad)) !== schluesselInhalt) {
    await dateien.schreiben(schluesselPfad, schluesselInhalt, true);
  }
  if (ergebnis.zustand !== 'unveraendert') await dateien.schreiben(datei, ergebnis.text);
  return { weg: 'vscode-mcp-json', zustand: ergebnis.zustand, datei, startetSelbst };
}

/**
 * Ein Satz fuer die Meldung nach der Einrichtung. Sagt nur, was stimmt:
 * VS Code beobachtet beide Dateien und laedt sie ohne Neustart neu
 * (workspaceDotMcpDiscovery.ts; `.vscode/mcp.json` ist eine
 * Arbeitsbereichs-Einstellungsdatei wie tasks.json). Ab 1.105 startet der
 * Server beim naechsten Chat von selbst, davor per "Start" in der Datei.
 * Claude Code liest `.mcp.json` nur beim Start einer Sitzung.
 */
export function verbindungsSatz(a: CopilotAnbindung | undefined): string {
  switch (a?.weg) {
    case 'mcp-json':
    case 'vscode-mcp-json':
      return a.startetSelbst
        ? 'Copilot and Claude Code can use it: Copilot from your next chat message (no restart), Claude Code from its next session.'
        : 'Copilot and Claude Code can use it: in Copilot, click "Start" above "cachly" in .vscode/mcp.json (no restart); Claude Code from its next session.';
    case 'kaputt':
      return `Copilot is not connected yet: ${a.datei} was left unchanged because ${a.grund}. Fix it, then run "Cachly: Connect Brain" again.`;
    case 'kein-ordner':
      return 'Open a project folder to connect Copilot and Claude Code.';
    default:
      return 'Restart your AI tool to activate memory.';
  }
}
