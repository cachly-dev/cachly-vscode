import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { kontoPfad, liesKontoDatei, werteKontoAus } from './konto';

// Zeilen im Format von sdk/mcp/src/ambient-ledger.ts serializeEntry (seit MCP 0.10.207 mit instanz).
const zeile = (o: Record<string, unknown>) => JSON.stringify({ ts: '2026-10-16T12:00:00.000Z', event: 'UserPromptSubmit', injected: 0, prevented: 0, ...o });

describe('werteKontoAus', () => {
  it('zaehlt nur die eigene Instanz und nennt den Rest', () => {
    const text = [
      zeile({ injected: 100 }),
      zeile({ injected: 7, instanz: 'inst-a' }),
      zeile({ event: 'credit', prevented: 50, instanz: 'inst-a' }),
      zeile({ injected: 500, instanz: 'inst-b' }),
      'kaputt{',
      '',
    ].join('\n');
    expect(werteKontoAus(text, 'inst-a')).toEqual({
      gemessen: true, eintraege: 2, injected: 7, prevented: 50, net: 43, ohneInstanz: 1, andereInstanzen: 1,
    });
  });

  it('auch eine negative Bilanz wird gezeigt', () => {
    expect(werteKontoAus(zeile({ injected: 300, instanz: 'i' }), 'i').net).toBe(-300);
  });

  it('ohne Instanz zaehlt alles (wie ambient-stats)', () => {
    const k = werteKontoAus([zeile({ injected: 1 }), zeile({ injected: 2, instanz: 'x' })].join('\n'));
    expect(k).toMatchObject({ eintraege: 2, injected: 3, ohneInstanz: 0, andereInstanzen: 0 });
  });

  it('keine Datei oder keine eigene Zeile: nicht gemessen — nicht 0', () => {
    expect(werteKontoAus(null, 'i').gemessen).toBe(false);
    expect(werteKontoAus(zeile({ injected: 5, instanz: 'anders' }), 'i')).toMatchObject({ gemessen: false, andereInstanzen: 1 });
  });
});

describe('liesKontoDatei', () => {
  it('liest ~/.cachly/ambient-ledger.jsonl, fehlt sie: null', () => {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-konto-'));
    expect(liesKontoDatei(kontoPfad(heim))).toBeNull();
    mkdirSync(join(heim, '.cachly'));
    writeFileSync(kontoPfad(heim), zeile({ injected: 9 }) + '\n');
    expect(werteKontoAus(liesKontoDatei(kontoPfad(heim))).injected).toBe(9);
  });
});
