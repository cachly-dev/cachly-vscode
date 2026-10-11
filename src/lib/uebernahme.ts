// "Link Account" — ein Test-Brain in das eigene cachly-Konto uebernehmen.
// Rein, ohne `vscode`-Import: alles hier ist mit schnellen Proben pruefbar
// (uebernahme.test.ts). Die Anbindung an VS Code steht in extension.ts.
//
// ── Warum es so gebaut ist (11.10.2026) ─────────────────────────────────────
//
// Bis heute meldete "Link Account" neu an und legte ein NEUES Brain an; die
// Lektionen blieben im Test-Brain. Ein erster Entwurf zum Mitnehmen lief ueber
// einen weiterreichbaren Link (PR #711) — den konnte ein Angreifer einem
// angemeldeten Opfer unterschieben.
//
// Jetzt beweist DIESE Erweiterung beides im selben Aufruf an
// POST /auth/trial/claim: die Anmeldung (Keycloak-Token aus der Geraete-
// Anmeldung im Browser) und den Besitz (den Test-Schluessel). Der Server zieht
// das Brain um, widerruft jeden Test-Schluessel und gibt einen neuen zurueck.
//
// Der Test-Schluessel zaehlt nur, wenn er in den BENUTZER-Einstellungen steht.
// cachly.apiKey ist eine Fenster-Einstellung: Ein fremdes Repository kann in
// seiner .vscode/settings.json einen eigenen Test-Schluessel setzen. "Link
// Account" in so einem Ordner wuerde sonst das Brain des Fremden in dein
// Konto ziehen.

import { DEFAULT_API_URL, normalizeBaseUrl } from './config';

export const KEYCLOAK_BASIS = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
export const CLI_CLIENT = 'cachly-cli';
export const TEST_KEY_KOPF = 'X-Trial-Key';

/** Transport: ein POST, der jeden Status zurueckgibt statt zu werfen. */
export type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: unknown }>;
/** Transport: ein GET, der jeden Status zurueckgibt. */
export type Get = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;

export function istTestSchluessel(wert: string | undefined | null): wert is string {
  return typeof wert === 'string' && /^cky_trial_[A-Za-z0-9]{8,}$/.test(wert.trim());
}

/** Die Ebenen von cachly.apiKey, wie `config.inspect('apiKey')` sie liefert. */
export interface SchluesselQuellen {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

export type QuellenUrteil =
  | { art: 'test'; schluessel: string }
  | { art: 'kein-schluessel' }
  | { art: 'konto' }
  | { art: 'arbeitsbereich' };

/**
 * Sagt, ob "Link Account" hier ein Test-Brain uebernehmen darf. Steht ein
 * Schluessel in den Arbeitsbereich-Einstellungen, ueberdeckt er den eigenen —
 * dann wird abgelehnt, egal welcher.
 */
export function pruefeSchluesselQuelle(q: SchluesselQuellen | undefined): QuellenUrteil {
  const leer = (v: string | undefined) => !v || !v.trim();
  if (!leer(q?.workspaceFolderValue) || !leer(q?.workspaceValue)) return { art: 'arbeitsbereich' };
  const global = q?.globalValue?.trim() ?? '';
  if (!global) return { art: 'kein-schluessel' };
  if (istTestSchluessel(global)) return { art: 'test', schluessel: global };
  return { art: 'konto' };
}

export type AdressUrteil = { art: 'ok'; url: string } | { art: 'arbeitsbereich' };

/**
 * Die API-Adresse fuer Link Account. Auch cachly.apiUrl ist eine
 * Fenster-Einstellung: Ein fremdes Repository koennte sie umbiegen, und das
 * Anmelde-Token ginge an seinen Server. Darum nur die Benutzer-Einstellung
 * oder die cachly-Adresse; steht im Arbeitsbereich eine, wird abgelehnt.
 */
export function pruefeApiAdresse(q: SchluesselQuellen | undefined, standard = DEFAULT_API_URL): AdressUrteil {
  const leer = (v: string | undefined) => !v || !v.trim();
  if (!leer(q?.workspaceFolderValue) || !leer(q?.workspaceValue)) return { art: 'arbeitsbereich' };
  return { art: 'ok', url: normalizeBaseUrl(q?.globalValue, standard) };
}

// ── Anmeldung: Keycloak-Geraete-Anmeldung (RFC 8628) ─────────────────────────

export interface Geraetecode {
  deviceCode: string;
  userCode: string;
  adresse: string;
  intervallMs: number;
  frist: number;
}

const formular = (felder: Record<string, string>) => new URLSearchParams(felder).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

/**
 * Direkt bei Keycloak, NICHT ueber /auth/device der cachly-API: Die gibt am
 * Ende einen API-Schluessel aus, und ein Schluessel ist hier keine Anmeldung.
 */
export async function starteKeycloakAnmeldung(post: Post, basis = KEYCLOAK_BASIS, jetzt = Date.now()): Promise<Geraetecode> {
  const r = await post(`${basis}/auth/device`, FORM, formular({ client_id: CLI_CLIENT, scope: 'openid' }));
  const d = (r.body ?? {}) as {
    device_code?: string; user_code?: string; verification_uri?: string;
    verification_uri_complete?: string; interval?: number; expires_in?: number;
  };
  if (r.status !== 200 || !d.device_code || !d.user_code) {
    throw new Error(`sign-in could not start (HTTP ${r.status})`);
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    adresse: d.verification_uri_complete ?? d.verification_uri ?? 'https://auth.cachly.dev/realms/cachly/device',
    intervallMs: Math.max(1, d.interval ?? 5) * 1000,
    frist: jetzt + Math.max(60, d.expires_in ?? 600) * 1000,
  };
}

export type Abfrage =
  | { art: 'token'; token: string }
  | { art: 'warten' }
  | { art: 'langsamer' }
  | { art: 'fehler'; grund: string };

export async function frageAnmeldungAb(post: Post, code: Geraetecode, basis = KEYCLOAK_BASIS): Promise<Abfrage> {
  let r: { status: number; body: unknown };
  try {
    r = await post(`${basis}/token`, FORM, formular({
      client_id: CLI_CLIENT,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.deviceCode,
    }));
  } catch {
    return { art: 'warten' };
  }
  if (r.status >= 500) return { art: 'warten' };
  const d = (r.body ?? {}) as { access_token?: string; error?: string };
  if (d.access_token) return { art: 'token', token: d.access_token };
  if (d.error === 'authorization_pending') return { art: 'warten' };
  if (d.error === 'slow_down') return { art: 'langsamer' };
  return { art: 'fehler', grund: d.error ?? `HTTP ${r.status}` };
}

/**
 * Wartet, bis die Anmeldung bestaetigt ist. Liefert null bei Abbruch durch den
 * Menschen, wirft bei Absage oder Ablauf.
 */
export async function warteAufKeycloakAnmeldung(
  post: Post,
  code: Geraetecode,
  o: { basis?: string; schlafe?: (ms: number) => Promise<void>; jetzt?: () => number; abgebrochen?: () => boolean } = {},
): Promise<string | null> {
  const schlafe = o.schlafe ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jetzt = o.jetzt ?? Date.now;
  let takt = code.intervallMs;
  while (jetzt() < code.frist) {
    await schlafe(takt);
    if (o.abgebrochen?.()) return null;
    const a = await frageAnmeldungAb(post, code, o.basis);
    if (a.art === 'token') return a.token;
    if (a.art === 'langsamer') takt = Math.min(takt + 5000, 30_000);
    if (a.art === 'fehler') throw new Error(`sign-in failed: ${a.grund}`);
  }
  throw new Error('sign-in timed out');
}

// ── Die Uebernahme ──────────────────────────────────────────────────────────

export interface UebernahmeAntwort {
  apiKey: string;
  instanceId: string;
  accountCreated: boolean;
  revokedKeys: number;
  brainRestarting: boolean;
}

export class UebernahmeFehler extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
    this.name = 'UebernahmeFehler';
  }
}

export async function uebernimm(
  post: Post,
  apiUrl: string,
  anmeldeToken: string,
  testSchluessel: string,
  userAgent?: string,
): Promise<UebernahmeAntwort> {
  if (anmeldeToken.startsWith('cky_')) {
    throw new UebernahmeFehler(403, 'sign_in_required', 'An API key is not a sign-in.');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${anmeldeToken}`,
    [TEST_KEY_KOPF]: testSchluessel,
  };
  if (userAgent) headers['User-Agent'] = userAgent;
  const r = await post(`${apiUrl.replace(/\/+$/, '')}/auth/trial/claim`, headers, JSON.stringify({ client: 'vscode' }));
  const d = (r.body ?? {}) as {
    api_key?: string; instance_id?: string; account_created?: boolean; revoked_keys?: number;
    brain_restarting?: boolean; error?: string; reason?: string;
  };
  if (r.status !== 200 || !d.api_key || !d.instance_id) {
    throw new UebernahmeFehler(r.status, d.reason ?? 'unknown', d.error ?? `HTTP ${r.status}`);
  }
  return {
    apiKey: d.api_key,
    instanceId: d.instance_id,
    accountCreated: d.account_created === true,
    revokedKeys: d.revoked_keys ?? 0,
    brainRestarting: d.brain_restarting !== false,
  };
}

/** Erreicht der NEUE Schluessel genau dieses Brain? Erst dann heisst es "Lessons kept". */
export async function brainImKonto(get: Get, apiUrl: string, neuerSchluessel: string, instanzId: string): Promise<boolean> {
  try {
    const r = await get(`${apiUrl.replace(/\/+$/, '')}/api/v1/instances/${encodeURIComponent(instanzId)}`,
      { Authorization: `Bearer ${neuerSchluessel}`, Accept: 'application/json' });
    return r.status === 200 && (r.body as { id?: string } | null)?.id === instanzId;
  } catch {
    return false;
  }
}

export function erfolgsText(a: UebernahmeAntwort, bestaetigt: boolean): string {
  const teile = [bestaetigt
    ? 'Your test Brain is now part of your account. Lessons kept.'
    : 'Your test Brain was moved to your account, but the new key could not reach it yet.'];
  if (a.brainRestarting) teile.push('It restarts once with a new password (about 20 seconds).');
  teile.push('The test key no longer works; the new key is saved.');
  return teile.join(' ');
}

export function fehlerText(e: unknown): string {
  if (!(e instanceof UebernahmeFehler)) {
    return `The Brain was not moved: ${(e as Error)?.message ?? String(e)}. Nothing was changed.`;
  }
  switch (e.reason) {
    case 'trial_key_invalid':
      return 'This test key is unknown or was already claimed. Nothing was changed.';
    case 'not_a_test_account':
      return 'This Brain already belongs to an account. There is nothing to link.';
    case 'sign_in_required':
      return 'The sign-in was not accepted. Try again and finish the sign-in in the browser.';
    case 'claim_unavailable':
      return 'Moving the Brain is not possible right now. Nothing was changed. Please try again later.';
    default:
      return `${e.message}${/nothing/i.test(e.message) ? '' : ' Nothing was changed.'}`;
  }
}
