import { describe, it, expect } from 'vitest';
import {
  pruefeSchluesselQuelle, pruefeApiAdresse, istTestSchluessel, starteKeycloakAnmeldung, frageAnmeldungAb, warteAufKeycloakAnmeldung,
  uebernimm, brainImKonto, erfolgsText, fehlerText, UebernahmeFehler, KEYCLOAK_BASIS, type Post, type Geraetecode,
} from './uebernahme';

const TEST = 'cky_trial_0123456789abcdef0123456789abcdef';

function postMit(...antworten: Array<{ status: number; body: unknown }>) {
  const aufrufe: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const post: Post = async (url, headers, body) => {
    aufrufe.push({ url, headers, body });
    return antworten.shift() ?? { status: 500, body: {} };
  };
  return { post, aufrufe };
}

describe('pruefeSchluesselQuelle', () => {
  it('nimmt einen Test-Schluessel aus den Benutzer-Einstellungen', () => {
    expect(pruefeSchluesselQuelle({ globalValue: TEST })).toEqual({ art: 'test', schluessel: TEST });
  });

  // Ein fremdes Repository kann cachly.apiKey in .vscode/settings.json setzen.
  // Dann wuerde "Link Account" dessen Brain ins eigene Konto ziehen.
  it('lehnt ab, sobald ein Schluessel im Arbeitsbereich steht', () => {
    const fremd = 'cky_trial_ffffffffffffffffffffffffffffffff';
    expect(pruefeSchluesselQuelle({ globalValue: TEST, workspaceValue: fremd })).toEqual({ art: 'arbeitsbereich' });
    expect(pruefeSchluesselQuelle({ globalValue: TEST, workspaceFolderValue: fremd })).toEqual({ art: 'arbeitsbereich' });
    expect(pruefeSchluesselQuelle({ workspaceValue: fremd })).toEqual({ art: 'arbeitsbereich' });
  });

  it('erkennt fehlenden Schluessel und echten Kontoschluessel', () => {
    expect(pruefeSchluesselQuelle(undefined)).toEqual({ art: 'kein-schluessel' });
    expect(pruefeSchluesselQuelle({ globalValue: '  ' })).toEqual({ art: 'kein-schluessel' });
    expect(pruefeSchluesselQuelle({ globalValue: 'cky_live_0123456789abcdef' })).toEqual({ art: 'konto' });
    expect(istTestSchluessel('cky_live_0123456789abcdef')).toBe(false);
  });
});

describe('pruefeApiAdresse', () => {
  it('nimmt die Benutzer-Einstellung oder die cachly-Adresse', () => {
    expect(pruefeApiAdresse(undefined)).toEqual({ art: 'ok', url: 'https://api.cachly.dev' });
    expect(pruefeApiAdresse({ globalValue: 'https://selbst.example/' })).toEqual({ art: 'ok', url: 'https://selbst.example' });
  });

  // Sonst ginge das Anmelde-Token an den Server eines fremden Repositorys.
  it('lehnt ab, sobald der Arbeitsbereich eine eigene Adresse setzt', () => {
    expect(pruefeApiAdresse({ workspaceValue: 'https://angreifer.example' })).toEqual({ art: 'arbeitsbereich' });
    expect(pruefeApiAdresse({ globalValue: 'https://api.cachly.dev', workspaceFolderValue: 'https://x' }))
      .toEqual({ art: 'arbeitsbereich' });
  });
});

describe('Anmeldung bei Keycloak', () => {
  const code: Geraetecode = { deviceCode: 'dc', userCode: 'ABCD-EFGH', adresse: 'x', intervallMs: 5000, frist: 10_000 };

  it('startet bei Keycloak mit cachly-cli, nicht ueber /auth/device der API', async () => {
    const { post, aufrufe } = postMit({ status: 200, body: {
      device_code: 'dc', user_code: 'ABCD-EFGH', interval: 5, expires_in: 600,
      verification_uri_complete: 'https://auth.cachly.dev/realms/cachly/device?user_code=ABCD-EFGH',
    } });
    const c = await starteKeycloakAnmeldung(post, KEYCLOAK_BASIS, 0);
    expect(aufrufe[0].url).toBe(`${KEYCLOAK_BASIS}/auth/device`);
    expect(aufrufe[0].body).toContain('client_id=cachly-cli');
    expect(c.adresse).toContain('user_code=ABCD-EFGH');
    expect(c.frist).toBe(600_000);
  });

  it('liest die Antworten der Abfrage', async () => {
    expect(await frageAnmeldungAb(postMit({ status: 200, body: { access_token: 'eyJ.t' } }).post, code))
      .toEqual({ art: 'token', token: 'eyJ.t' });
    expect(await frageAnmeldungAb(postMit({ status: 400, body: { error: 'authorization_pending' } }).post, code))
      .toEqual({ art: 'warten' });
    expect(await frageAnmeldungAb(postMit({ status: 400, body: { error: 'expired_token' } }).post, code))
      .toEqual({ art: 'fehler', grund: 'expired_token' });
  });

  it('Abbruch durch den Menschen liefert null, ohne weiter zu fragen', async () => {
    const { post, aufrufe } = postMit();
    let uhr = 0;
    const token = await warteAufKeycloakAnmeldung(post, code,
      { schlafe: async (ms) => { uhr += ms; }, jetzt: () => uhr, abgebrochen: () => true });
    expect(token).toBeNull();
    expect(aufrufe).toHaveLength(0);
  });
});

describe('uebernimm', () => {
  it('schickt Anmeldung und Test-Schluessel im selben Aufruf', async () => {
    const { post, aufrufe } = postMit({ status: 200, body: {
      api_key: 'cky_live_neu', instance_id: 'inst-1', account_created: true, revoked_keys: 1, brain_restarting: true,
    } });
    const erg = await uebernimm(post, 'https://api.cachly.dev', 'eyJ.anmeldung', TEST, 'cachly-vscode/1');
    expect(aufrufe[0].url).toBe('https://api.cachly.dev/auth/trial/claim');
    expect(aufrufe[0].headers.Authorization).toBe('Bearer eyJ.anmeldung');
    expect(aufrufe[0].headers['X-Trial-Key']).toBe(TEST);
    expect(JSON.parse(aufrufe[0].body)).toEqual({ client: 'vscode' });
    expect(erg).toEqual({ apiKey: 'cky_live_neu', instanceId: 'inst-1', accountCreated: true, revokedKeys: 1, brainRestarting: true });
  });

  it('ein API-Schluessel als Anmeldung geht gar nicht erst raus', async () => {
    const { post, aufrufe } = postMit();
    await expect(uebernimm(post, 'https://a', 'cky_live_x', TEST)).rejects.toBeInstanceOf(UebernahmeFehler);
    expect(aufrufe).toHaveLength(0);
  });

  it('meldet den Grund des Servers, und nie einen Erfolg ohne Schluessel', async () => {
    const e1 = await uebernimm(postMit({ status: 409, body: { reason: 'app_account', error: 'No.' } }).post, 'https://a', 'eyJ', TEST)
      .catch((e) => e);
    expect(e1).toBeInstanceOf(UebernahmeFehler);
    expect(e1.reason).toBe('app_account');
    const e2 = await uebernimm(postMit({ status: 200, body: {} }).post, 'https://a', 'eyJ', TEST).catch((e) => e);
    expect(e2).toBeInstanceOf(UebernahmeFehler);
  });
});

describe('Texte', () => {
  const erg = { apiKey: 'k', instanceId: 'i', accountCreated: false, revokedKeys: 1, brainRestarting: true };

  it('"Lessons kept" nur, wenn der neue Schluessel das Brain erreicht', () => {
    expect(erfolgsText(erg, true)).toContain('Your test Brain is now part of your account. Lessons kept.');
    expect(erfolgsText(erg, false)).not.toContain('Lessons kept');
  });

  it('jede Absage sagt, was jetzt gilt', () => {
    expect(fehlerText(new UebernahmeFehler(403, 'trial_key_invalid', 'x'))).toContain('Nothing was changed');
    expect(fehlerText(new UebernahmeFehler(409, 'instance_limit', 'Delete a Brain first.'))).toBe('Delete a Brain first. Nothing was changed.');
    expect(fehlerText(new Error('timeout'))).toContain('Nothing was changed');
  });
});

describe('brainImKonto', () => {
  it('ja nur bei 200 und genau diesem Brain', async () => {
    expect(await brainImKonto(async () => ({ status: 200, body: { id: 'i' } }), 'https://a', 'k', 'i')).toBe(true);
    expect(await brainImKonto(async () => ({ status: 401, body: {} }), 'https://a', 'k', 'i')).toBe(false);
    expect(await brainImKonto(async () => { throw new Error('offline'); }, 'https://a', 'k', 'i')).toBe(false);
  });
});
