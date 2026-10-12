// Altbestand: Schluessel, die eine aeltere Fassung der Erweiterung ins Projekt
// geschrieben hat, wieder herausnehmen — ohne etwas anderes anzufassen.
//
// Wer die Erweiterung bis 0.12.6 benutzt hat, hat in seinem Projekt:
//   - `.mcp.json`                           mit mcpServers.cachly.env.CACHLY_JWT
//   - `.claude/hooks/cachly-ambient-*.mjs`  mit `process.env.CACHLY_JWT = '...'`
//   - `.git/hooks/post-commit`              mit `export CACHLY_JWT="..."`
//     (der liegt in .git und wird nicht eingecheckt; er liegt aber im Projektordner)
// und `.vscode/mcp.json`, wenn ein Werkzeug dort den Schluessel eingetragen hat.
//
// ── Was als "unseres" gilt ──────────────────────────────────────────────────
//
// Wir schreiben eine Datei nur um, wenn der Schluessel darin einer ist, den wir
// kennen: der der Erweiterung oder der, der im Heimordner liegt. Ein Projekt
// aus einem fremden Repository kann den Schluessel eines anderen Menschen
// enthalten; den fassen wir nicht an (er stuende danach als Aenderung im
// Git-Stand, die niemand bestellt hat) und melden ihn auch nicht als "bei dir
// gefunden".
//
// ── Reihenfolge ──────────────────────────────────────────────────────────────
//
// Erst liegt der Schluessel im Heimordner, dann verschwindet er aus dem
// Projekt. Umgekehrt stuende der MCP-Server nach dem Umschreiben ohne Schluessel
// da. Gelingt die Ablage nicht (anderer Schluessel dort, Platte voll), bleibt
// das Projekt unveraendert und der Aufrufer erfaehrt, warum.

import * as fs from 'fs';
import * as path from 'path';
import { AMBIENT_SCRIPT_NAMES } from './ambient';
import { installiereAmbientHooks, installiereClsHook } from './projektHooks';
import { entferneSchluesselAusMcpJson } from './mcpJson';
import { legeSchluesselImHeimAb, liesHeimSchluessel, type HeimAblage } from './schluessel';

type Log = (message: string, ...details: unknown[]) => void;

/** Eine Fundstelle, relativ zum Projektordner (mit `/`). */
export interface Fundstelle {
  datei: string;
  art: 'mcp-json' | 'vscode-mcp-json' | 'hook-skript' | 'git-hook';
  schluessel: string;
  /** Nur bei Hook-Dateien: die Instanz, die in der Datei steht. */
  instanceId?: string;
  /** Nur bei MCP-Dateien: der Text ohne Schluessel. */
  neuerText?: string;
}

export interface AltbestandEingabe {
  /** Projektordner: Arbeitsordner, Git-Wurzeln. Doppelte sind egal. */
  ordner: string[];
  /** Der Schluessel der Erweiterung (cachly.apiKey), oder ''. */
  eigenerSchluessel: string;
  /** Die Instanz der Erweiterung; geht mit in den Heimordner. */
  instanceId?: string;
  home?: string;
  /** Pfad zu cachly-ambient-einblendung.mjs in der Erweiterung. */
  buendelQuelle: string;
  /** Darf ein anderer Schluessel im Heimordner ersetzt werden? (Nur, wenn wir ihn selbst dorthin gelegt haben.) */
  darfErsetzen?: (alterSchluessel: string) => boolean;
  /** Der Mensch hat bestaetigt: den Schluessel im Heimordner ersetzen. */
  erzwingen?: boolean;
  log?: Log;
}

export interface AltbestandErgebnis {
  /** Dateien (mit Projektordner davor), aus denen der Schluessel entfernt wurde. */
  bereinigt: string[];
  /** Dateien mit einem Schluessel, den wir nicht kennen: unangetastet. */
  fremd: string[];
  /** Dateien mit unserem Schluessel, die sich nicht verlustfrei umschreiben liessen (Kommentare, kaputtes JSON). */
  offen: string[];
  /** Die Ablage im Heimordner, falls sie gebraucht wurde. */
  heim?: HeimAblage;
  /** Der Schluessel, den wir im Heimordner abgelegt haben (nur wenn die Ablage gelang). */
  heimSchluessel?: string;
}

function normalisiert(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

async function liesOderNichts(datei: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(datei, 'utf8');
  } catch {
    return undefined;
  }
}

/** Den Wert aus `process.env.NAME = '...'` zurueck in Klartext (Gegenstueck zu jsString in ambient.ts). */
function ausJsString(roh: string): string {
  return roh.replace(/\\(.)/g, '$1');
}

export function schluesselImHookSkript(text: string): { schluessel?: string; instanceId?: string } {
  const k = /process\.env\.CACHLY_JWT\s*=\s*'((?:\\.|[^'\\])*)'/.exec(text);
  const i = /process\.env\.CACHLY_BRAIN_INSTANCE_ID\s*=\s*'((?:\\.|[^'\\])*)'/.exec(text);
  const schluessel = k ? ausJsString(k[1]).trim() : undefined;
  return { schluessel: schluessel || undefined, instanceId: i ? ausJsString(i[1]) : undefined };
}

export function schluesselImGitHook(text: string): { schluessel?: string; instanceId?: string } {
  // Nur im cachly-Block: ein fremder Hook darf eine eigene Variable gleichen Namens haben.
  const block = /# cachly CLS[\s\S]*?\nexit 0\n?/.exec(text)?.[0];
  if (!block) return {};
  const k = /^export CACHLY_JWT="([^"\n]*)"/m.exec(block);
  const i = /^export CACHLY_BRAIN_INSTANCE_ID="([^"\n]*)"/m.exec(block);
  return { schluessel: k?.[1].trim() || undefined, instanceId: i?.[1] };
}

/** Sucht alle Stellen mit einem Schluessel. Liest nur. */
export async function sucheSchluesselImProjekt(
  ordner: string,
  gehoertUns: (schluessel: string) => boolean,
): Promise<{ funde: Fundstelle[]; fremd: string[]; offen: string[] }> {
  const funde: Fundstelle[] = [];
  const fremd: string[] = [];
  const offen: string[] = [];
  const rel = (p: string) => p.replace(/\\/g, '/');

  for (const [datei, art] of [
    ['.mcp.json', 'mcp-json'],
    [path.join('.vscode', 'mcp.json'), 'vscode-mcp-json'],
  ] as const) {
    const text = await liesOderNichts(path.join(ordner, datei));
    const r = entferneSchluesselAusMcpJson(text, gehoertUns);
    if (r.zustand === 'fremd') fremd.push(rel(datei));
    else if (r.zustand === 'offen') {
      // Mit Kommentaren wissen wir den Schluessel, duerfen aber nicht umschreiben.
      if (r.schluessel && gehoertUns(r.schluessel)) offen.push(rel(datei));
      else if (r.schluessel) fremd.push(rel(datei));
    } else if (r.zustand === 'bereinigt') {
      funde.push({ datei: rel(datei), art, schluessel: r.schluessel, neuerText: r.text });
    }
  }

  for (const name of Object.values(AMBIENT_SCRIPT_NAMES)) {
    const datei = path.join('.claude', 'hooks', name);
    const text = await liesOderNichts(path.join(ordner, datei));
    if (!text) continue;
    const { schluessel, instanceId } = schluesselImHookSkript(text);
    if (!schluessel) continue;
    if (gehoertUns(schluessel)) funde.push({ datei: rel(datei), art: 'hook-skript', schluessel, instanceId });
    else fremd.push(rel(datei));
  }

  const gitHook = await liesOderNichts(path.join(ordner, '.git', 'hooks', 'post-commit'));
  if (gitHook) {
    const { schluessel, instanceId } = schluesselImGitHook(gitHook);
    if (schluessel) {
      if (gehoertUns(schluessel)) funde.push({ datei: '.git/hooks/post-commit', art: 'git-hook', schluessel, instanceId });
      else fremd.push('.git/hooks/post-commit');
    }
  }
  return { funde, fremd, offen };
}

/**
 * Nimmt unsere Schluessel aus den Projektdateien und legt sie im Heimordner ab.
 * Wirft nie. Gibt es nichts zu tun, kommt ein leeres Ergebnis zurueck.
 */
export async function bereinigeAltbestand(e: AltbestandEingabe): Promise<AltbestandErgebnis> {
  const log = e.log ?? (() => undefined);
  const ergebnis: AltbestandErgebnis = { bereinigt: [], fremd: [], offen: [] };
  try {
    const eigener = e.eigenerSchluessel.trim();
    const heimSchluessel = await liesHeimSchluessel(e.home);
    const gehoertUns = (k: string) => k === eigener || k === heimSchluessel;

    const gesehen = new Set<string>();
    const projekte: Array<{ ordner: string; funde: Fundstelle[] }> = [];
    for (const ordner of e.ordner) {
      const n = normalisiert(ordner);
      if (gesehen.has(n)) continue;
      gesehen.add(n);
      const s = await sucheSchluesselImProjekt(ordner, gehoertUns);
      ergebnis.fremd.push(...s.fremd.map((d) => path.join(ordner, d)));
      ergebnis.offen.push(...s.offen.map((d) => path.join(ordner, d)));
      if (s.funde.length) projekte.push({ ordner, funde: s.funde });
    }
    if (projekte.length === 0) return ergebnis;

    // Erst in den Heimordner, dann aus dem Projekt. Ein Schluessel, der dort
    // schon liegt (gleich oder von uns), braucht keine Ablage.
    const gefunden = projekte.flatMap((p) => p.funde.map((f) => f.schluessel));
    const abzulegen = gefunden.find((k) => k === eigener) ?? gefunden[0];
    if (abzulegen !== heimSchluessel) {
      ergebnis.heim = await legeSchluesselImHeimAb(
        { apiKey: abzulegen, instanceId: e.instanceId, home: e.home, darfErsetzen: e.darfErsetzen, erzwingen: e.erzwingen },
      );
      if (ergebnis.heim.zustand === 'konflikt' || ergebnis.heim.zustand === 'fehler') {
        log('Altbestand: Schluessel bleibt im Projekt, Ablage im Heimordner nicht moeglich', ergebnis.heim.zustand);
        return ergebnis;
      }
      ergebnis.heimSchluessel = abzulegen;
    }

    for (const { ordner, funde } of projekte) {
      for (const f of funde) {
        const ziel = path.join(ordner, f.datei);
        if (f.neuerText !== undefined) {
          await fs.promises.writeFile(ziel, f.neuerText, 'utf8');
          ergebnis.bereinigt.push(ziel);
        }
      }
      // Hooks: neu schreiben, mit der Instanz, die in der alten Datei stand
      // (das Projekt kann an einer anderen Instanz haengen als dieses Fenster).
      const skripte = funde.filter((f) => f.art === 'hook-skript');
      if (skripte.length) {
        const instanceId = skripte.find((f) => f.instanceId)?.instanceId ?? e.instanceId;
        await bereinigeHookSkripte(ordner, skripte, instanceId, e.buendelQuelle, log);
        ergebnis.bereinigt.push(...skripte.map((f) => path.join(ordner, f.datei)));
      }
      const git = funde.find((f) => f.art === 'git-hook');
      if (git) {
        const instanceId = git.instanceId ?? e.instanceId;
        if (instanceId) await installiereClsHook(ordner, instanceId, log);
        // Hat das Neuschreiben die Zeile nicht erwischt (kein Instanz, fremder Aufbau), faellt sie einzeln heraus.
        const ziel = path.join(ordner, git.datei);
        const text = await liesOderNichts(ziel);
        if (text !== undefined && schluesselImGitHook(text).schluessel) {
          const ohne = text.replace(/# cachly CLS[\s\S]*?\nexit 0\n?/, (block) => block.replace(/^export CACHLY_JWT="[^"\n]*"\r?\n/m, ''));
          await fs.promises.writeFile(ziel, ohne, 'utf8');
        }
        ergebnis.bereinigt.push(ziel);
      }
    }
  } catch (err) {
    log('Altbestand: Bereinigung abgebrochen (nicht kritisch)', (err as Error).message);
  }
  return ergebnis;
}

/**
 * Die vier Skripte ohne Schluessel neu schreiben. Normalfall: die aktuellen
 * v5-Skripte samt Buendel (wie ein frisches Einrichten). Faellt das Buendel
 * aus, wird nur die Zeile mit dem Schluessel aus jedem Skript genommen — der
 * Schluessel darf nie am Buendel haengen.
 */
async function bereinigeHookSkripte(
  ordner: string,
  skripte: Fundstelle[],
  instanceId: string | undefined,
  buendelQuelle: string,
  log: Log,
): Promise<void> {
  if (instanceId && (await liesOderNichts(buendelQuelle)) !== undefined) {
    await installiereAmbientHooks(ordner, instanceId, buendelQuelle, log);
  }
  // Was danach noch einen Schluessel traegt, verliert die Zeile.
  for (const f of skripte) {
    const ziel = path.join(ordner, f.datei);
    const text = await liesOderNichts(ziel);
    if (text === undefined || !schluesselImHookSkript(text).schluessel) continue;
    const ohne = text.replace(/^process\.env\.CACHLY_JWT\s*=\s*'(?:\\.|[^'\\])*';?\r?\n?/m, '');
    await fs.promises.writeFile(ziel, ohne, 'utf8');
  }
}
