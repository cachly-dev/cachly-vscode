// `.mcp.json` fuer Claude Code — rein, vscode-frei, testbar.
//
// ── Warum es diese Datei gibt (12.10.2026) ───────────────────────────────────
//
// Die Erweiterung schrieb bis 0.12.6 den Schluessel im Klartext nach
// `.mcp.json` (mcpServers.cachly.env.CACHLY_JWT). Die Datei liegt im Projekt,
// und `git add .` nimmt sie mit. Gefunden in einer echten VS-Code-Probe: 14 neue
// Dateien, keine davon in .gitignore, der Schluessel in fuenf davon.
//
// Der MCP-Server braucht ihn dort nicht. Er sucht den Schluessel selbst, bei
// jedem Start: Umgebung, dann ~/.cachly/credentials.json (sdk/mcp/src/
// credentials.ts, resolveApiKey; aufgerufen beim Laden von index.ts). Die
// Erweiterung legt ihn dort ab (schluessel.ts). In die Projektdatei gehoeren
// nur die Adresse der API und die Kennung des Brains.

import { parseJsonc } from './config';

export const SERVER_NAME = 'cachly';

/** Umgebungsvariablen, in denen ein Schluessel stehen kann. */
export const SCHLUESSEL_VARIABLEN = ['CACHLY_JWT', 'CACHLY_API_KEY'] as const;

export interface McpJsonEintrag {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Der Eintrag fuer `.mcp.json`: Adresse und Kennung, nie ein Schluessel. */
export function cachlyMcpEintrag(apiUrl: string, instanceId: string): McpJsonEintrag {
  return {
    command: 'npx',
    args: ['-y', '@cachly-dev/mcp-server@latest'],
    env: { CACHLY_API_URL: apiUrl, CACHLY_BRAIN_INSTANCE_ID: instanceId },
  };
}

function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Setzt den cachly-Eintrag in den Text einer `.mcp.json` und laesst alle
 * anderen Server und Felder stehen. Fehlt die Datei oder laesst sie sich
 * nicht lesen, beginnt eine neue (wie bisher).
 */
export function fuegeInMcpJsonEin(vorhanden: string | undefined, apiUrl: string, instanceId: string): string {
  let daten: { mcpServers?: Record<string, unknown> } = {};
  if (vorhanden !== undefined) {
    try {
      daten = parseJsonc(vorhanden) as typeof daten;
    } catch { /* neue Datei oder kein JSON: neu beginnen */ }
  }
  if (!istObjekt(daten)) daten = {};
  if (!istObjekt(daten.mcpServers)) daten.mcpServers = {};
  daten.mcpServers[SERVER_NAME] = cachlyMcpEintrag(apiUrl, instanceId);
  return JSON.stringify(daten, null, 2);
}

/** Ein Platzhalter wie `${CACHLY_JWT}` oder `${env:CACHLY_JWT}` ist kein Schluessel. */
function istEchterSchluessel(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !/^\$\{[^}]*\}$/.test(v.trim());
}

export type McpJsonBereinigung =
  /** Kein Schluessel im cachly-Eintrag (oder keine Datei). */
  | { zustand: 'sauber' }
  /** Ein Schluessel steht drin, gehoert aber nicht uns: die Datei bleibt, wie sie ist. */
  | { zustand: 'fremd'; schluessel: string }
  /** Ein Schluessel steht drin, die Datei laesst sich nicht verlustfrei umschreiben (Kommentare, kein JSON). */
  | { zustand: 'offen'; schluessel?: string }
  | { zustand: 'bereinigt'; schluessel: string; text: string };

/**
 * Nimmt den Schluessel aus dem cachly-Eintrag einer MCP-Konfiguration. Gilt
 * fuer `.mcp.json` (`mcpServers`) und `.vscode/mcp.json` (`servers`).
 *
 * Nur der cachly-Eintrag wird angefasst, und nur sein Schluessel: andere
 * Server, `inputs`, `envFile` und jede andere Umgebungsvariable bleiben.
 * `gehoertUns` entscheidet, ob der gefundene Schluessel einer ist, den wir
 * kennen (der der Erweiterung oder der im Heimordner). Eine Datei aus einem
 * fremden Repository mit dem Schluessel eines anderen Menschen rufen wir
 * nicht an: sie waere danach ein Unterschied im Git-Stand, den niemand
 * bestellt hat.
 */
export function entferneSchluesselAusMcpJson(
  text: string | undefined,
  gehoertUns: (schluessel: string) => boolean,
): McpJsonBereinigung {
  if (!text || text.trim() === '') return { zustand: 'sauber' };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Editoren unter Windows setzen gern eine Byte-Order-Marke davor
  let daten: unknown;
  try {
    daten = JSON.parse(text);
  } catch {
    // Kommentare oder kaputtes JSON. Ob ein Schluessel drinsteht, sagt parseJsonc;
    // umschreiben duerfen wir die Datei so nicht (Kommentare gingen verloren).
    try {
      daten = parseJsonc(text);
    } catch {
      return { zustand: 'sauber' };
    }
    const k = gefundenerSchluessel(daten);
    return k ? { zustand: 'offen', schluessel: k } : { zustand: 'sauber' };
  }
  const schluessel = gefundenerSchluessel(daten);
  if (!schluessel) return { zustand: 'sauber' };
  if (!gehoertUns(schluessel)) return { zustand: 'fremd', schluessel };

  for (const gruppe of ['mcpServers', 'servers']) {
    const eintrag = (istObjekt(daten) && istObjekt(daten[gruppe]) ? (daten[gruppe] as Record<string, unknown>)[SERVER_NAME] : undefined);
    if (!istObjekt(eintrag) || !istObjekt(eintrag.env)) continue;
    for (const name of SCHLUESSEL_VARIABLEN) delete eintrag.env[name];
  }
  const ende = /\n$/.test(text) ? '\n' : '';
  return { zustand: 'bereinigt', schluessel, text: JSON.stringify(daten, null, 2) + ende };
}

/** Der erste echte Schluessel im cachly-Eintrag, unter `mcpServers` oder `servers`. */
export function gefundenerSchluessel(daten: unknown): string | undefined {
  if (!istObjekt(daten)) return undefined;
  for (const gruppe of ['mcpServers', 'servers']) {
    const g = daten[gruppe];
    const eintrag = istObjekt(g) ? g[SERVER_NAME] : undefined;
    const env = istObjekt(eintrag) ? eintrag.env : undefined;
    if (!istObjekt(env)) continue;
    for (const name of SCHLUESSEL_VARIABLEN) {
      if (istEchterSchluessel(env[name])) return env[name].trim();
    }
  }
  return undefined;
}
