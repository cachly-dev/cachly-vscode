// Das gespeicherte Brain ist weg (404), der Schluessel wird aber angenommen.
//
// Seit 28.11.2026 loescht die API taeglich Sofort-Test-Brains, die 14 Tage alt,
// nie benutzt und leer sind (api/internal/service/sofort_test_abraeumer.go).
// Konto und Schluessel (cky_trial_...) bleiben gueltig, nur die Instanz ist weg.
// Dieselbe Regel gilt im MCP-Server und im JetBrains-Plugin:
//   - Sofort-Test-Schluessel: einmal je Sitzung ein neues, leeres Brain anlegen.
//   - Registrierter Schluessel: NIE anlegen (dort liegen echte Lektionen), nur melden.
// Dieser Teil ist rein; Netz und Einstellungen liegen in extension.ts.

import { homedir } from 'os';
import * as path from 'path';
import { nodeDateiZugriff, type DateiZugriff } from './copilotMcp';
import { credentialsDateiPfad } from './schluessel';

export const DASHBOARD_URL = 'https://cachly.dev/instances';

/** Nur Sofort-Test-Schluessel haben kein Konto dahinter; cky_live_ ist verknuepft. */
export function istSofortTestSchluessel(apiKey: string): boolean {
  return apiKey.startsWith('cky_trial_');
}

/** Loeschgrund in der 404-Antwort der API (Feld `grund`), wenn der Abraeumer das Brain entfernt hat. */
export const GRUND_LEER_ABGERAEUMT = 'leer_abgeraeumt';

/** Das Feld `grund` aus einem HttpError (oder einer Antwort mit `body`); sonst undefined. */
export function grundAusFehler(e: unknown): string | undefined {
  const body = e && typeof e === 'object' ? (e as { body?: unknown }).body : undefined;
  const grund = body && typeof body === 'object' ? (body as { grund?: unknown }).grund : undefined;
  return typeof grund === 'string' ? grund : undefined;
}

/**
 * Die Meldung nach dem Anlegen des Ersatz-Brains. "14 Tage leer, nichts verloren"
 * steht NUR da, wenn die API den Grund `leer_abgeraeumt` genannt hat; sonst weiss
 * der Client nicht, warum das Brain fehlt, und sagt nur, was stimmt.
 */
export function ersatzAngelegtText(alteId: string, grund?: string): string {
  return grund === GRUND_LEER_ABGERAEUMT
    ? '🧠 Your trial Brain was removed because it stayed empty and unused for 14 days. '
      + 'cachly created a new, empty Brain for you. Nothing was lost: the old one had no saved lessons.'
    : `🧠 Your trial Brain ${alteId} no longer exists. cachly created a new, empty Brain for you.`;
}

export function brainWegText(instanceId: string): string {
  return `The Brain ${instanceId} no longer exists in your account.`;
}

/** Text, wenn das Anlegen des Ersatz-Brains scheitert: sagt, was los ist und was als Naechstes zu tun ist. */
export function ersatzFehlerText(status: number, body: unknown): string {
  const fehler = body && typeof body === 'object' ? String((body as { error?: unknown }).error ?? '') : '';
  const schluss = ' Your lessons stay on this computer and are saved as soon as a Brain is connected.';
  if (status === 403 && /sign_in_required/.test(fehler)) {
    return '🧠 Your trial Brain no longer exists, and a new one needs a sign-in. Run "Cachly: Connect Brain" to sign in.' + schluss;
  }
  if (status === 402 || status === 403 || status === 429) {
    return '🧠 Your trial Brain no longer exists, and your plan does not allow a new one right now. Open the dashboard to check your plan, or run "Cachly: Connect Brain".' + schluss;
  }
  return '🧠 Your trial Brain no longer exists, and cachly could not create a new one (no answer from the server). Check your connection, then run "Cachly: Connect Brain".' + schluss;
}

/**
 * Ersetzt die Instanz in ~/.cachly/credentials.json, aber NUR wenn dort genau der
 * aktuelle Schluessel UND genau die alte Instanz stehen. Alles andere gehoert einem
 * anderen Konto oder Editor und bleibt unberuehrt. Wirft nie.
 */
export async function ersetzeHeimInstanz(
  e: { apiKey: string; alteId: string; neueId: string; home?: string },
  dateien: DateiZugriff = nodeDateiZugriff,
): Promise<'ersetzt' | 'unberuehrt'> {
  try {
    const datei = credentialsDateiPfad(e.home ?? homedir());
    const text = await dateien.lesen(datei);
    if (!text) return 'unberuehrt';
    const inhalt = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
    if (!inhalt || typeof inhalt !== 'object' || Array.isArray(inhalt)) return 'unberuehrt';
    if (inhalt.apiKey !== e.apiKey || inhalt.instanceId !== e.alteId) return 'unberuehrt';
    await dateien.schreiben(datei, JSON.stringify({ ...inhalt, instanceId: e.neueId }, null, 2), true);
    return 'ersetzt';
  } catch {
    return 'unberuehrt';
  }
}

// ── Alle Ordner eines Arbeitsbereichs umstellen ─────────────────────────────

/** Die Projektdateien, in denen die Kennung des Brains stehen kann (relativ zum Ordner). */
export const KENNUNG_DATEIEN = ['.vscode/settings.json', '.mcp.json', '.vscode/mcp.json'];

const KENNUNG_ZEICHEN = /[0-9A-Za-z-]/;

/**
 * Tauscht in einem Text GENAU die alte Kennung gegen die neue: nur ganze Vorkommen
 * (an beiden Seiten kein weiteres Kennungszeichen), alles andere bleibt Zeichen
 * fuer Zeichen. Gibt undefined zurueck, wenn die alte Kennung nicht vorkommt.
 */
export function ersetzeKennungImText(text: string, alteId: string, neueId: string): string | undefined {
  if (!alteId || alteId === neueId) return undefined;
  let aus = '';
  let von = 0;
  let treffer = false;
  for (let i = text.indexOf(alteId); i !== -1; i = text.indexOf(alteId, von)) {
    const davor = i > 0 ? text[i - 1]! : '';
    const danach = text[i + alteId.length] ?? '';
    if ((davor && KENNUNG_ZEICHEN.test(davor)) || (danach && KENNUNG_ZEICHEN.test(danach))) {
      aus += text.slice(von, i + alteId.length);
    } else {
      aus += text.slice(von, i) + neueId;
      treffer = true;
    }
    von = i + alteId.length;
  }
  return treffer ? aus + text.slice(von) : undefined;
}

/**
 * Stellt in ALLEN Ordnern die Projektdateien von der alten auf die neue Kennung um,
 * die genau die alte tragen. Ordner und Dateien mit einer anderen Kennung bleiben
 * unberuehrt. Gibt die geaenderten Dateien zurueck. Wirft nie.
 */
export async function ersetzeKennungInOrdnern(
  ordner: string[], alteId: string, neueId: string, dateien: DateiZugriff = nodeDateiZugriff,
): Promise<string[]> {
  const geaendert: string[] = [];
  for (const o of ordner) {
    for (const rel of KENNUNG_DATEIEN) {
      const pfad = path.join(o, ...rel.split('/'));
      try {
        const text = await dateien.lesen(pfad);
        if (text === undefined) continue;
        const neu = ersetzeKennungImText(text, alteId, neueId);
        if (neu === undefined) continue;
        await dateien.schreiben(pfad, neu);
        geaendert.push(pfad);
      } catch { /* diese Datei bleibt, wie sie ist */ }
    }
  }
  return geaendert;
}
