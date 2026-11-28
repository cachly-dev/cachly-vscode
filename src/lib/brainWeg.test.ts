import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { brainWegText, ersatzFehlerText, ersetzeHeimInstanz, istSofortTestSchluessel } from './brainWeg';

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
