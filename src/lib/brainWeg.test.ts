import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  brainWegText, ersatzAngelegtText, ersatzFehlerText, ersetzeHeimInstanz, ersetzeKennungImText, ersetzeKennungInOrdnern,
  grundAusFehler, GRUND_LEER_ABGERAEUMT, istSofortTestSchluessel,
} from './brainWeg';

describe('istSofortTestSchluessel', () => {
  it('nur cky_trial_ gilt als Sofort-Test', () => {
    expect(istSofortTestSchluessel('cky_trial_abc')).toBe(true);
    expect(istSofortTestSchluessel('cky_live_abc')).toBe(false);
    expect(istSofortTestSchluessel('cky_test_abc')).toBe(false);
    expect(istSofortTestSchluessel('')).toBe(false);
  });
});

describe('Texte', () => {
  it('nennt die Kennung des fehlenden Brains', () => {
    expect(brainWegText('abc-1')).toBe('The Brain abc-1 no longer exists in your account.');
  });
  it('Anlegen gescheitert: Anmeldung, Tarif, Netz je mit naechstem Schritt', () => {
    expect(ersatzFehlerText(403, { error: 'sign_in_required' })).toMatch(/needs a sign-in.*Connect Brain/);
    expect(ersatzFehlerText(403, { error: 'plan_limit' })).toMatch(/plan does not allow/);
    expect(ersatzFehlerText(402, null)).toMatch(/plan does not allow/);
    expect(ersatzFehlerText(0, null)).toMatch(/Check your connection/);
    for (const s of [0, 402, 403, 500]) expect(ersatzFehlerText(s, null)).toMatch(/lessons stay on this computer/);
  });
});

describe('ersetzeHeimInstanz', () => {
  const mitHeim = (inhalt: unknown) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-bw-'));
    if (inhalt !== undefined) {
      fs.mkdirSync(path.join(home, '.cachly'));
      fs.writeFileSync(path.join(home, '.cachly', 'credentials.json'), typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt));
    }
    return home;
  };
  const lies = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.cachly', 'credentials.json'), 'utf8'));
  const e = (home: string) => ({ apiKey: 'cky_trial_x', alteId: 'alt', neueId: 'neu', home });

  it('ersetzt nur, wenn Schluessel UND alte Kennung genau passen', async () => {
    const home = mitHeim({ apiKey: 'cky_trial_x', instanceId: 'alt', weiteres: 1 });
    expect(await ersetzeHeimInstanz(e(home))).toBe('ersetzt');
    expect(lies(home)).toEqual({ apiKey: 'cky_trial_x', instanceId: 'neu', weiteres: 1 });
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('fremde Kennung, fremder Schluessel, keine Datei, kaputte Datei: unberuehrt', async () => {
    for (const inhalt of [
      { apiKey: 'cky_trial_x', instanceId: 'fremd' },
      { apiKey: 'cky_live_y', instanceId: 'alt' },
      undefined,
      '{kaputt',
    ]) {
      const home = mitHeim(inhalt);
      const vorher = inhalt === undefined ? undefined : fs.readFileSync(path.join(home, '.cachly', 'credentials.json'), 'utf8');
      expect(await ersetzeHeimInstanz(e(home))).toBe('unberuehrt');
      if (vorher !== undefined) expect(fs.readFileSync(path.join(home, '.cachly', 'credentials.json'), 'utf8')).toBe(vorher);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Meldung nach dem Ersatz: nur mit Grund von der API', () => {
  it('Grund leer_abgeraeumt: 14 Tage und "nichts verloren"', () => {
    const t = ersatzAngelegtText('alt-1', GRUND_LEER_ABGERAEUMT);
    expect(t).toContain('stayed empty and unused for 14 days');
    expect(t).toContain('Nothing was lost: the old one had no saved lessons.');
  });
  it('kein Grund oder anderer Grund: neutral', () => {
    for (const g of [undefined, 'etwas_anderes']) {
      const t = ersatzAngelegtText('alt-1', g);
      expect(t).toBe('🧠 Your trial Brain alt-1 no longer exists. cachly created a new, empty Brain for you.');
      expect(t).not.toMatch(/14 days|Nothing was lost/);
    }
  });
  it('grundAusFehler liest body.grund', () => {
    expect(grundAusFehler({ status: 404, body: { error: 'not found', grund: 'leer_abgeraeumt' } })).toBe('leer_abgeraeumt');
    expect(grundAusFehler({ status: 404, body: { error: 'not found' } })).toBeUndefined();
    expect(grundAusFehler({ status: 404, body: null })).toBeUndefined();
    expect(grundAusFehler(new Error('x'))).toBeUndefined();
  });
  it('Fehlertexte behaupten keine Begruendung', () => {
    for (const s of [0, 402, 403, 500]) expect(ersatzFehlerText(s, null)).not.toMatch(/14 days|was removed/);
  });
});

describe('Kennung im Text tauschen', () => {
  const ALT = '11111111-2222-3333-4444-555555555555';
  const NEU = '99999999-8888-7777-6666-555555555555';
  it('nur ganze Vorkommen der alten Kennung', () => {
    expect(ersetzeKennungImText(`{"a":"${ALT}","b":"${ALT}"}`, ALT, NEU)).toBe(`{"a":"${NEU}","b":"${NEU}"}`);
    expect(ersetzeKennungImText(`"${ALT}-x"`, ALT, NEU)).toBeUndefined();
    expect(ersetzeKennungImText(`"0${ALT}"`, ALT, NEU)).toBeUndefined();
    expect(ersetzeKennungImText('nichts', ALT, NEU)).toBeUndefined();
  });
  it('ersetzeKennungInOrdnern: zwei Ordner mit alter Kennung, einer mit fremder', async () => {
    const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-kennung-'));
    try {
      const ordner = ['a', 'b', 'c'].map((n) => path.join(wurzel, n));
      const ids = [ALT, ALT, 'fremd-0000'];
      ordner.forEach((o, i) => {
        fs.mkdirSync(path.join(o, '.vscode'), { recursive: true });
        fs.writeFileSync(path.join(o, '.vscode', 'settings.json'), `{ "cachly.instanceId": "${ids[i]}" }`);
      });
      const geaendert = await ersetzeKennungInOrdnern(ordner, ALT, NEU);
      expect(geaendert.length).toBe(2);
      expect(fs.readFileSync(path.join(ordner[0]!, '.vscode', 'settings.json'), 'utf8')).toContain(NEU);
      expect(fs.readFileSync(path.join(ordner[1]!, '.vscode', 'settings.json'), 'utf8')).toContain(NEU);
      expect(fs.readFileSync(path.join(ordner[2]!, '.vscode', 'settings.json'), 'utf8')).toContain('fremd-0000');
    } finally { fs.rmSync(wurzel, { recursive: true, force: true }); }
  });
});
