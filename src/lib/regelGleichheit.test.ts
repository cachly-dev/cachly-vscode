import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// buildCopilotInstructions (extension.ts) ist eine Handkopie von
// buildClaudeMdBlock im MCP-Paket (sdk/mcp/src/projektdateien.ts). Dieser Test liest
// beide Quelltexte und verlangt Wortgleichheit. Fehlt eine Quelle, scheitert
// er mit Meldung: ein stilles Ueberspringen liesse die Kopien auseinanderlaufen.

const hier = path.dirname(fileURLToPath(import.meta.url));
const ID = '11111111-2222-3333-4444-555555555555';
const BS = String.fromCharCode(92);

function lies(teil: string[]): string {
  const datei = path.resolve(hier, ...teil);
  if (!fs.existsSync(datei)) {
    throw new Error(`Quelle fehlt: ${datei}. Der Gleichheitstest darf nicht still entfallen.`);
  }
  return fs.readFileSync(datei, 'utf8').split('\r\n').join('\n');
}

/** Der Text zwischen "return `" und dem schliessenden "`;" der Funktion, Platzhalter ersetzt. */
function koerper(quelle: string, funktion: string): string {
  const start = quelle.indexOf(funktion);
  expect(start, `${funktion} nicht gefunden`).toBeGreaterThan(-1);
  const von = quelle.indexOf('return `', start) + 'return `'.length;
  const bis = quelle.indexOf('`;', von);
  return quelle
    .slice(von, bis)
    .split(BS + '`').join('`')
    .replace(/\$\{CLAUDE_MD_MARKER_START\}/g, '<!-- cachly-brain-start -->')
    .replace(/\$\{CLAUDE_MD_MARKER_END\}/g, '<!-- cachly-brain-end -->')
    .replace(/\$\{instanceId\}/g, ID);
}

describe('Abrufregel der VS-Code-Erweiterung', () => {
  const mcp = koerper(lies(['..', '..', '..', 'mcp', 'src', 'projektdateien.ts']), 'export function buildClaudeMdBlock');
  const vs = koerper(lies(['..', 'extension.ts']), 'function buildCopilotInstructions');

  it('ist wortgleich mit dem Block, den die MCP-Einrichtung schreibt', () => {
    // Die Erweiterung setzt die Marken selbst um den Text (brainBlock in writeWorkspaceFiles).
    const ohneMarken = mcp
      .replace('<!-- cachly-brain-start -->\n', '')
      .replace('\n<!-- cachly-brain-end -->', '\n');
    expect(vs).toBe(ohneMarken);
  });

  it('verlangt smart_recall vor jeder Aufgabe', () => {
    expect(vs).toContain('### BEFORE every task (mandatory');
    expect(vs).toContain(`smart_recall(instance_id="${ID}"`);
  });
});
