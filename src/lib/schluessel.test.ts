import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { credentialsDateiPfad, legeSchluesselImHeimAb, liesHeimSchluessel, schluesselFingerabdruck } from './schluessel';

const KEY = 'cky_live_abcdef1234567890';
const ANDERER = 'cky_live_zzzzzzzzzzzzzzzz';
const INST = '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-heim-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const lies = () => JSON.parse(fs.readFileSync(credentialsDateiPfad(home), 'utf8'));

describe('legeSchluesselImHeimAb', () => {
  it('legt Schluessel und Instanz im Format des MCP-Servers ab ({apiKey, instanceId})', async () => {
    const r = await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home });
    expect(r.zustand).toBe('geschrieben');
    expect(r.datei).toBe(path.join(home, '.cachly', 'credentials.json'));
    expect(lies()).toEqual({ apiKey: KEY, instanceId: INST });
    expect(await liesHeimSchluessel(home)).toBe(KEY);
  });

  it('schreibt nicht zweimal: derselbe Schluessel ist "unveraendert"', async () => {
    await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home });
    const vorher = fs.readFileSync(credentialsDateiPfad(home), 'utf8');
    const r = await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home });
    expect(r.zustand).toBe('unveraendert');
    expect(fs.readFileSync(credentialsDateiPfad(home), 'utf8')).toBe(vorher);
  });

  it('traegt die Instanz nach, wenn sie fehlt, und ueberschreibt eine vorhandene nicht', async () => {
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    fs.writeFileSync(credentialsDateiPfad(home), JSON.stringify({ apiKey: KEY }));
    expect((await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home })).zustand).toBe('geschrieben');
    expect(lies()).toEqual({ apiKey: KEY, instanceId: INST });
    expect((await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: 'eine-andere', home })).zustand).toBe('unveraendert');
    expect(lies().instanceId).toBe(INST);
  });

  it('ueberschreibt einen ANDEREN Schluessel nicht still: konflikt, Datei unveraendert', async () => {
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    const fremd = JSON.stringify({ apiKey: ANDERER, instanceId: 'fremde-instanz' });
    fs.writeFileSync(credentialsDateiPfad(home), fremd);
    const r = await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home });
    expect(r.zustand).toBe('konflikt');
    expect(fs.readFileSync(credentialsDateiPfad(home), 'utf8')).toBe(fremd);
  });

  it('ersetzt einen anderen Schluessel nur, wenn wir ihn selbst abgelegt haben oder der Mensch es bestaetigt', async () => {
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    fs.writeFileSync(credentialsDateiPfad(home), JSON.stringify({ apiKey: ANDERER, instanceId: 'alte-instanz' }));

    const meiner = schluesselFingerabdruck(ANDERER);
    const darf = (alt: string) => schluesselFingerabdruck(alt) === meiner;
    expect((await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home, darfErsetzen: darf })).zustand).toBe('geschrieben');
    // neue Datei, alte Instanz ist weg (falsche Paarung waere sie)
    expect(lies()).toEqual({ apiKey: KEY, instanceId: INST });

    fs.writeFileSync(credentialsDateiPfad(home), JSON.stringify({ apiKey: ANDERER }));
    expect((await legeSchluesselImHeimAb({ apiKey: KEY, home, darfErsetzen: () => false })).zustand).toBe('konflikt');
    expect((await legeSchluesselImHeimAb({ apiKey: KEY, home, erzwingen: true })).zustand).toBe('geschrieben');
    expect(lies()).toEqual({ apiKey: KEY });
  });

  it('behandelt eine kaputte Datei wie eine leere (wie der MCP-Server)', async () => {
    fs.mkdirSync(path.join(home, '.cachly'), { recursive: true });
    fs.writeFileSync(credentialsDateiPfad(home), '{ kaputt');
    expect((await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home })).zustand).toBe('geschrieben');
    expect(lies().apiKey).toBe(KEY);
  });

  it('wirft nie: ein Heimordner, in den man nicht schreiben kann, ist "fehler"', async () => {
    const blockiert = path.join(home, 'datei-statt-ordner');
    fs.writeFileSync(blockiert, 'x');
    const r = await legeSchluesselImHeimAb({ apiKey: KEY, home: blockiert });
    expect(r.zustand).toBe('fehler');
  });

  it('legt keine Temp-Datei mit dem Schluessel daneben liegen', async () => {
    await legeSchluesselImHeimAb({ apiKey: KEY, instanceId: INST, home });
    expect(fs.readdirSync(path.join(home, '.cachly'))).toEqual(['credentials.json']);
  });
});
