// Der Schluessel gehoert in den Heimordner, nicht in das Projekt.
//
// ── Warum (12.10.2026) ───────────────────────────────────────────────────────
//
// Eine echte VS-Code-Probe (1.140.0, Erweiterung 0.12.5) zeigte: Die
// Erweiterung schrieb den Schluessel in `.mcp.json` und in vier Hook-Dateien
// unter `.claude/hooks/`, nichts davon in `.gitignore`. `git add .` checkt ihn
// ein; bei einem oeffentlichen Repository steht er danach auf GitHub.
//
// Der MCP-Server und die Hooks lesen den Schluessel selbst, in dieser
// Reihenfolge: Umgebung, dann ~/.cachly/credentials.json
// (sdk/mcp/src/credentials.ts, resolveApiKey; die Hooks ueber hook-zugang.ts).
// Diese Datei legt ihn dort ab. Format und Ort sind dieselben wie beim
// MCP-Server (saveApiKey) und beim JetBrains-Plugin (seit #754):
//
//     ~/.cachly/credentials.json   { "apiKey": "...", "instanceId": "..." }
//
// ── Liegt dort schon ein anderer Schluessel ─────────────────────────────────
//
// Dann steht er aus gutem Grund dort: das Terminal-Setup, das Claude-Code-
// Plugin oder ein anderer Editor haben ihn abgelegt. Ihn still zu ueberschreiben
// hiesse, deren Konto zu wechseln. Wir ersetzen nur, was wir selbst
// abgelegt haben (`darfErsetzen`) oder was der Mensch ausdruecklich bestaetigt
// (`erzwingen`). Sonst kommt `konflikt` zurueck, und die Erweiterung fragt.

import { createHash } from 'crypto';
import { homedir } from 'os';
import * as path from 'path';
import { nodeDateiZugriff, type DateiZugriff } from './copilotMcp';

export function credentialsDateiPfad(home: string): string {
  return path.join(home, '.cachly', 'credentials.json');
}

/** Kurzer Fingerabdruck eines Schluessels: damit wir uns merken koennen, WAS wir abgelegt haben, ohne es ein zweites Mal zu speichern. */
export function schluesselFingerabdruck(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export interface HeimAblageEingabe {
  apiKey: string;
  instanceId?: string;
  /** Standard `os.homedir()`. Tests geben einen Temp-Ordner. */
  home?: string;
  /** Darf ein anderer Schluessel, der schon dort liegt, ersetzt werden? Standard: nein. */
  darfErsetzen?: (alterSchluessel: string) => boolean;
  /** Der Mensch hat ausdruecklich bestaetigt: ersetzen. */
  erzwingen?: boolean;
}

export type HeimAblage =
  | { zustand: 'geschrieben' | 'unveraendert'; datei: string }
  /** Dort liegt ein anderer Schluessel; nichts wurde veraendert. */
  | { zustand: 'konflikt'; datei: string }
  | { zustand: 'fehler'; datei: string; grund: string };

interface CredentialsInhalt {
  apiKey?: unknown;
  instanceId?: unknown;
  [k: string]: unknown;
}

function lesbarerInhalt(text: string | undefined): CredentialsInhalt | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as CredentialsInhalt) : undefined;
  } catch {
    return undefined;
  }
}

function echt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' && !/^\$\{[^}]*\}$/.test(v.trim()) ? v.trim() : undefined;
}

/** Der Schluessel, der im Heimordner liegt, oder undefined. Wirft nie. */
export async function liesHeimSchluessel(home: string = homedir(), dateien: DateiZugriff = nodeDateiZugriff): Promise<string | undefined> {
  try {
    return echt(lesbarerInhalt(await dateien.lesen(credentialsDateiPfad(home)))?.apiKey);
  } catch {
    return undefined;
  }
}

/**
 * Legt den Schluessel in `~/.cachly/credentials.json` ab. Wirft nie.
 * Schreibt nur, wenn sich etwas aendert; die Datei ist nur fuer den Besitzer
 * lesbar (0600, unter Windows ohne Wirkung).
 */
export async function legeSchluesselImHeimAb(e: HeimAblageEingabe, dateien: DateiZugriff = nodeDateiZugriff): Promise<HeimAblage> {
  const datei = credentialsDateiPfad(e.home ?? homedir());
  try {
    const key = e.apiKey.trim();
    if (!key) return { zustand: 'fehler', datei, grund: 'no key to store' };

    const alt = lesbarerInhalt(await dateien.lesen(datei));
    const altKey = echt(alt?.apiKey);
    const instanz = e.instanceId?.trim() || undefined;

    if (altKey === key) {
      // Derselbe Schluessel: nur die Instanz nachtragen, wenn sie fehlt. Eine
      // vorhandene Instanz bleibt; sie gehoert zu diesem Konto und kann eine
      // andere sein, als die dieses Fensters.
      if (instanz && !echt(alt?.instanceId)) {
        await dateien.schreiben(datei, JSON.stringify({ ...alt, apiKey: key, instanceId: instanz }, null, 2), true);
        return { zustand: 'geschrieben', datei };
      }
      return { zustand: 'unveraendert', datei };
    }

    if (altKey && !e.erzwingen && !(e.darfErsetzen?.(altKey))) return { zustand: 'konflikt', datei };

    // Neuer Schluessel: eine alte Instanz daneben waere eine falsche Paarung
    // (sie kann zu einem anderen Konto gehoeren) — wie in saveApiKey des MCP-Servers.
    await dateien.schreiben(datei, JSON.stringify({ apiKey: key, ...(instanz ? { instanceId: instanz } : {}) }, null, 2), true);
    return { zustand: 'geschrieben', datei };
  } catch (err) {
    return { zustand: 'fehler', datei, grund: (err as Error).message };
  }
}
