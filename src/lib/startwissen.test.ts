import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  STARTWISSEN_BEFEHL, STARTWISSEN_VERSUCHE, startwissenAufruf, startwissenFaellig, startwissenSchluessel,
} from './startwissen';
import { HOOK_BUENDEL } from './ambient';

// Anlass (23.10.2026): 69 neue fremde Konten in 45 Tagen, nur eines mit Git-Import.
// Legt die Erweiterung das Brain an, importierte niemand die Git-Geschichte.

const SCHLUESSEL = 'cky_live_nur_fuer_den_test_0001';
const INSTANZ = '00000000-0000-4000-8000-000000000001';

const aufruf = (env: Record<string, string | undefined> = {}) => startwissenAufruf({
  execPath: process.execPath,
  buendel: path.join(__dirname, '..', '..', 'hooks', HOOK_BUENDEL),
  ordner: os.tmpdir(),
  apiUrl: 'http://127.0.0.1:9',
  apiKey: SCHLUESSEL,
  instanceId: INSTANZ,
  env,
});

describe('startwissenAufruf', () => {
  it('gibt den Schluessel nur ueber die Umgebung weiter, nie als Argument', () => {
    const a = aufruf({ PATH: 'x' });
    expect(a.argumente.join(' ')).not.toContain(SCHLUESSEL);
    expect(a.env.CACHLY_JWT).toBe(SCHLUESSEL);
    expect(a.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INSTANZ);
    expect(a.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(a.env.PATH).toBe('x');
    expect(a.argumente.slice(1)).toEqual([STARTWISSEN_BEFEHL, os.tmpdir()]);
  });
});

describe('startwissenFaellig', () => {
  it('hoechstens drei Versuche je Instanz', () => {
    expect(startwissenFaellig(undefined)).toBe(true);
    expect(startwissenFaellig(STARTWISSEN_VERSUCHE - 1)).toBe(true);
    expect(startwissenFaellig(STARTWISSEN_VERSUCHE)).toBe(false);
    expect(startwissenSchluessel(INSTANZ)).toBe(`cachly.startwissen.${INSTANZ}`);
  });
});

describe('Buendel kennt den Befehl', () => {
  it('gleicher Unterbefehl wie im MCP-Paket (eine Quelle)', () => {
    const quelle = path.join(__dirname, '..', '..', '..', 'mcp', 'src', 'startwissen-hook.ts');
    if (!fs.existsSync(quelle)) throw new Error(`MCP-Quelle fehlt: ${quelle} — der Gleichheitstest darf nicht still entfallen`);
    expect(fs.readFileSync(quelle, 'utf8')).toContain(`STARTWISSEN_IMPORT = '${STARTWISSEN_BEFEHL}'`);
  });

  // Der echte Lauf des mitgelieferten Buendels, ohne Netz: Ein Ordner ohne Git und ohne
  // Startvorrat endet als "kein-repo" und hinterlaesst den Auftrag fuer den MCP-Server.
  // Ein falscher Unterbefehl haette keinen Auftrag geschrieben.
  const lauf = (env: Record<string, string>) => {
    const heim = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-start-heim-'));
    const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-start-ordner-'));
    try {
      const a = startwissenAufruf({
        execPath: process.execPath,
        buendel: path.join(__dirname, '..', '..', 'hooks', HOOK_BUENDEL),
        ordner, apiUrl: 'http://127.0.0.1:9', apiKey: SCHLUESSEL, instanceId: INSTANZ,
        env: { ...process.env, HOME: heim, USERPROFILE: heim, CACHLY_STARTVORRAT: '0', ...env },
      });
      const r = spawnSync(a.befehl, a.argumente, { env: a.env, timeout: 30_000, encoding: 'utf8' });
      const auftrag = fs.existsSync(path.join(heim, '.cachly'))
        ? fs.readdirSync(path.join(heim, '.cachly')).filter((n) => !n.endsWith('.tmp'))
        : [];
      return { r, auftrag };
    } finally {
      fs.rmSync(heim, { recursive: true, force: true });
      fs.rmSync(ordner, { recursive: true, force: true });
    }
  };

  it('das mitgelieferte Buendel fuehrt den Start-Import aus und endet sauber', () => {
    // vitest.config.ts schaltet den Start-Import fuer alle anderen Tests ab.
    const { r, auftrag } = lauf({ CACHLY_STARTWISSEN: '1' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(auftrag.length).toBe(1);
  });

  it('mit CACHLY_STARTWISSEN=0 passiert nichts', () => {
    const { r, auftrag } = lauf({ CACHLY_STARTWISSEN: '0' });
    expect(r.status).toBe(0);
    expect(auftrag).toEqual([]);
  });
});
