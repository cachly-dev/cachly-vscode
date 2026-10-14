/**
 * Welches Programm die Erweiterung gerade traegt (Abhakliste 1.3, 14.10.2026).
 *
 * Bis 0.12.6 meldete jedes Ereignis `editor: 'vscode'` — auch aus Cursor,
 * Windsurf oder VSCodium, die dieselbe Erweiterung laden. Im Trichter war
 * deshalb nicht zu sehen, aus welchem Programm eine Anmeldung kommt, und
 * Fragen wie "haengen die Cursor-Nutzer an derselben Stelle?" blieben offen.
 *
 * Die Quelle ist `vscode.env.appName`. Der Wert landet in der Spalte
 * `mcp_events.editor` (hoechstens 32 Zeichen); was nicht bekannt ist, wird
 * zu einem kurzen Kennwort aus Kleinbuchstaben, nie zu Freitext.
 */

const BEKANNT: ReadonlyArray<[RegExp, string]> = [
  // "Visual Studio Code" und "Visual Studio Code - Insiders" — dieselbe Regel
  // wie hatCopilot (copilotMcp.ts), die darauf aufbaut.
  [/^Visual Studio Code\b/, 'vscode'],
  [/\bcursor\b/i, 'cursor'],
  [/\bwindsurf\b/i, 'windsurf'],
  [/\bvscodium\b/i, 'vscodium'],
  [/\btrae\b/i, 'trae'],
  [/\bkiro\b/i, 'kiro'],
  [/\bpositron\b/i, 'positron'],
];

/** Kurzname des Programms fuer die Meldung, zum Beispiel 'vscode' oder 'cursor'. */
export function programmName(appName: string | undefined): string {
  const name = String(appName ?? '').trim();
  for (const [muster, kurz] of BEKANNT) if (muster.test(name)) return kurz;
  const kennwort = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return kennwort || 'vscode';
}

/** `vscode.version` fuer die Meldung: nur Ziffern, Punkte, Bindestriche, hoechstens 32 Zeichen. */
export function editorFassung(version: string | undefined): string {
  return String(version ?? '').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32);
}
