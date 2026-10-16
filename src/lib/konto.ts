/**
 * Das Netto-Token-Konto aus ~/.cachly/ambient-ledger.jsonl (GROW-024, 16.10.2026).
 *
 * Bis 0.12.7 zaehlte das Panel nur die Einblendungen des @cachly-Chats in
 * globalState. Wer cachly ueber Claude Code (MCP + Hooks) nutzt — die Mehrheit —
 * sah 0, und der Abschnitt verschwand. Das echte Konto schreiben die Hooks
 * (sdk/mcp/src/ambient-ledger.ts): eine Zeile je Einblendung oder Gutschrift,
 * seit MCP 0.10.207 mit der Instanz.
 *
 * Gleiche Leseregeln wie dort: kaputte Zeilen ueberspringen, negative Werte auf
 * 0. Gezaehlt wird die Instanz des Editors; alte Zeilen ohne Instanz und andere
 * Instanzen werden nur genannt. Rein bis auf liesKontoDatei.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Konto {
  /** false: keine Datei oder keine Zeile dieser Instanz — "noch nicht gemessen", nicht 0. */
  gemessen: boolean;
  eintraege: number;
  injected: number;
  prevented: number;
  net: number;
  /** Zeilen aus der Zeit vor MCP 0.10.207 (ohne Instanz), nicht mitgezaehlt. */
  ohneInstanz: number;
  /** Andere Instanzen auf diesem Rechner mit Zeilen, nicht mitgezaehlt. */
  andereInstanzen: number;
}

export function kontoPfad(heim: string = homedir()): string {
  return join(heim, '.cachly', 'ambient-ledger.jsonl');
}

/** Datei lesen; fehlt sie oder ist sie unlesbar: null. */
export function liesKontoDatei(pfad: string = kontoPfad()): string | null {
  try { return readFileSync(pfad, 'utf8'); } catch { return null; }
}

/**
 * Wertet den Dateitext aus. Ohne `instanz` zaehlt jede Zeile (wie
 * `ambient-stats` ohne bekannte Instanz).
 */
export function werteKontoAus(text: string | null, instanz?: string): Konto {
  const konto: Konto = { gemessen: false, eintraege: 0, injected: 0, prevented: 0, net: 0, ohneInstanz: 0, andereInstanzen: 0 };
  if (!text) return konto;
  const andere = new Set<string>();
  for (const zeile of text.split('\n')) {
    const t = zeile.trim();
    if (!t) continue;
    let e: { injected?: unknown; prevented?: unknown; instanz?: unknown };
    try { e = JSON.parse(t) as typeof e; } catch { continue; }
    if (typeof e !== 'object' || e === null) continue;
    const injected = Number(e.injected);
    const prevented = Number(e.prevented);
    if (!Number.isFinite(injected) || !Number.isFinite(prevented)) continue;
    const ihre = typeof e.instanz === 'string' && e.instanz ? e.instanz : '';
    if (instanz) {
      if (!ihre) { konto.ohneInstanz++; continue; }
      if (ihre !== instanz) { andere.add(ihre); continue; }
    }
    konto.eintraege++;
    konto.injected += Math.max(0, injected);
    konto.prevented += Math.max(0, prevented);
  }
  konto.injected = Math.round(konto.injected);
  konto.prevented = Math.round(konto.prevented);
  konto.net = konto.prevented - konto.injected;
  konto.andereInstanzen = andere.size;
  konto.gemessen = konto.eintraege > 0;
  return konto;
}
