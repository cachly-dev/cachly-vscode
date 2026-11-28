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
import { nodeDateiZugriff, type DateiZugriff } from './copilotMcp';
import { credentialsDateiPfad } from './schluessel';

export const DASHBOARD_URL = 'https://cachly.dev/instances';

/** Nur Sofort-Test-Schluessel haben kein Konto dahinter; cky_live_ ist verknuepft. */
export function istSofortTestSchluessel(apiKey: string): boolean {
  return apiKey.startsWith('cky_trial_');
}

export const ERSATZ_ANGELEGT_TEXT =
  '🧠 Your trial Brain was removed because it stayed empty and unused for 14 days. '
  + 'cachly created a new, empty Brain for you. Nothing was lost: the old one had no saved lessons.';

export function brainWegText(instanceId: string): string {
  return `The Brain ${instanceId} no longer exists in your account.`;
}

/** Text, wenn das Anlegen des Ersatz-Brains scheitert: sagt, was los ist und was als Naechstes zu tun ist. */
export function ersatzFehlerText(status: number, body: unknown): string {
  const fehler = body && typeof body === 'object' ? String((body as { error?: unknown }).error ?? '') : '';
  const schluss = ' Your lessons stay on this computer and are saved as soon as a Brain is connected.';
  if (status === 403 && /sign_in_required/.test(fehler)) {
    return '🧠 Your trial Brain was removed, and a new one needs a sign-in. Run "Cachly: Connect Brain" to sign in.' + schluss;
  }
  if (status === 402 || status === 403 || status === 429) {
    return '🧠 Your trial Brain was removed, and your plan does not allow a new one right now. Open the dashboard to check your plan, or run "Cachly: Connect Brain".' + schluss;
  }
  return '🧠 Your trial Brain was removed, and cachly could not create a new one (no answer from the server). Check your connection, then run "Cachly: Connect Brain".' + schluss;
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
