/**
 * Start-Import der Git-Geschichte in ein neues Brain (23.10.2026).
 *
 * Warum: Von 69 neuen fremden Konten der letzten 45 Tage (40 JetBrains, 20 VS Code)
 * hat nur eines je einen Git-Import gemeldet. Der MCP-Server importiert nur, wenn ER
 * das Brain anlegt; legt die Erweiterung es an, bleibt es leer — und mit ihm die
 * Regeldateien (lib/regelwissen.ts).
 *
 * Die Logik steht EINMAL im Hook-Buendel (sdk/mcp/src/startwissen-hook.ts):
 * nur in ein leeres Brain, nur aus einem Git-Repo des Nutzers (Heim-, Paket- und
 * Pluginordner zaehlen nicht), hoechstens 30 Commits, Schalter CACHLY_STARTWISSEN=0.
 * Die Erweiterung startet nur `node <buendel> startwissen-import <ordner>` — mit dem
 * Node, das VS Code selbst mitbringt (ELECTRON_RUN_AS_NODE), damit kein installiertes
 * Node noetig ist.
 *
 * Der Schluessel geht nur ueber die Umgebung an den Kindprozess, nie als Argument:
 * Argumente stehen in jeder Prozessliste.
 *
 * Rein — keine vscode-Abhaengigkeit, darum ohne Editor testbar.
 */

/** Unterbefehl des Buendels; muss STARTWISSEN_IMPORT in sdk/mcp/src/startwissen-hook.ts gleichen. */
export const STARTWISSEN_BEFEHL = 'startwissen-import';

/** So oft je Instanz. Danach nie wieder: ein Brain mit Lektionen braucht keinen Start-Import. */
export const STARTWISSEN_VERSUCHE = 3;

/** Danach wird der Kindprozess beendet. Das Buendel wartet selbst hoechstens 90 s auf die Instanz. */
export const STARTWISSEN_FRIST_MS = 3 * 60_000;

/** Schluessel in globalState: Zahl der Versuche je Instanz. */
export function startwissenSchluessel(instanceId: string): string {
  return `cachly.startwissen.${instanceId}`;
}

export function startwissenFaellig(versuche: number | undefined): boolean {
  return (versuche ?? 0) < STARTWISSEN_VERSUCHE;
}

export interface StartwissenAufruf {
  befehl: string;
  argumente: string[];
  env: Record<string, string | undefined>;
}

export function startwissenAufruf(o: {
  /** process.execPath: in VS Code das Editor-Programm, mit ELECTRON_RUN_AS_NODE ein Node. */
  execPath: string;
  buendel: string;
  ordner: string;
  apiUrl: string;
  apiKey: string;
  instanceId: string;
  env: Record<string, string | undefined>;
}): StartwissenAufruf {
  return {
    befehl: o.execPath,
    argumente: [o.buendel, STARTWISSEN_BEFEHL, o.ordner],
    env: {
      ...o.env,
      ELECTRON_RUN_AS_NODE: '1',
      CACHLY_JWT: o.apiKey,
      CACHLY_BRAIN_INSTANCE_ID: o.instanceId,
      CACHLY_API_URL: o.apiUrl,
    },
  };
}
