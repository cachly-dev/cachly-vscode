/**
 * Projektwissen in die Regeldateien der KI-Assistenten schreiben (Abhakliste 5.2, 23.10.2026).
 *
 * Warum: Copilot und Cursor rufen smart_recall nie von sich aus auf. Beide laden aber
 * Regeldateien in jeden Chat — Copilot `.github/instructions/*.instructions.md` mit
 * `applyTo`, Cursor `.cursor/rules/*.mdc` mit `alwaysApply`. Der Server liefert den
 * fertigen, gerahmten Block (POST /instances/:id/regelwissen); dieses Modul legt ihn ab.
 *
 * Regeln:
 *  - Eine Datei ohne unsere Kennung (REGEL_MARKE) ist fremd und bleibt unberuehrt.
 *  - Leerer Block = unsere Dateien entfernen (kein veraltetes Wissen stehen lassen).
 *  - Die Pfade kommen in `.git/info/exclude`: lokal, ohne die `.gitignore` des Projekts
 *    anzufassen, damit niemand den Block versehentlich eincheckt.
 *
 * Rein bis auf das Dateisystem — keine vscode-Abhaengigkeit, darum ohne Editor testbar.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Die Kennung, die der Server in die erste Zeile schreibt (regelwissen_handler.go). */
export const REGEL_MARKE = 'Written by cachly';

export interface Regelziel {
  /** Pfad relativ zur Wurzel des Arbeitsbereichs, mit `/`. */
  pfad: string;
  /** Vorspann, den der Assistent zum Einordnen braucht. */
  kopf: string;
}

export const REGELZIELE: readonly Regelziel[] = [
  {
    pfad: '.github/instructions/cachly-wissen.instructions.md',
    kopf: '---\napplyTo: "**"\ndescription: "Project experience from cachly (auto-generated)"\n---\n\n',
  },
  {
    pfad: '.cursor/rules/cachly-wissen.mdc',
    kopf: '---\ndescription: Project experience from cachly (auto-generated)\nalwaysApply: true\n---\n\n',
  },
];

export type Regelaktion = 'geschrieben' | 'unveraendert' | 'entfernt' | 'fremd' | 'fehlt';

export function istUnsere(inhalt: string): boolean {
  return inhalt.includes(REGEL_MARKE);
}

/**
 * Legt den Block in allen Regelzielen ab (oder entfernt unsere Dateien bei leerem Block).
 * Wirft nie; ein Ziel, das sich nicht schreiben laesst, meldet 'fehlt'.
 */
export function schreibeRegelwissen(wurzel: string, markdown: string): Record<string, Regelaktion> {
  const ergebnis: Record<string, Regelaktion> = {};
  const block = markdown.trim();
  for (const ziel of REGELZIELE) {
    const datei = path.join(wurzel, ...ziel.pfad.split('/'));
    try {
      const vorhanden = fs.existsSync(datei) ? fs.readFileSync(datei, 'utf8') : null;
      if (vorhanden !== null && !istUnsere(vorhanden)) {
        ergebnis[ziel.pfad] = 'fremd';
        continue;
      }
      if (!block) {
        if (vorhanden !== null) {
          fs.rmSync(datei, { force: true });
          ergebnis[ziel.pfad] = 'entfernt';
        } else {
          ergebnis[ziel.pfad] = 'unveraendert';
        }
        continue;
      }
      const neu = `${ziel.kopf}${block}\n`;
      if (vorhanden !== null && ohneZeitstempel(vorhanden) === ohneZeitstempel(neu)) {
        ergebnis[ziel.pfad] = 'unveraendert';
        continue;
      }
      fs.mkdirSync(path.dirname(datei), { recursive: true });
      fs.writeFileSync(datei, neu, 'utf8');
      ergebnis[ziel.pfad] = 'geschrieben';
    } catch {
      ergebnis[ziel.pfad] = 'fehlt';
    }
  }
  return ergebnis;
}

/** Nur der Zeitstempel in der ersten Zeile aendert sich bei jedem Abruf — der zaehlt nicht als Aenderung. */
function ohneZeitstempel(s: string): string {
  return s.replace(/<!-- Written by cachly [^ ]+\./, '<!-- Written by cachly.');
}

/**
 * Traegt die Pfade in `.git/info/exclude` ein (nur fehlende, am Ende). Liegt `.git`
 * nicht als Ordner vor (Arbeitsbaum mit `.git`-Datei, kein Git), passiert nichts.
 */
export function ergaenzeGitExclude(wurzel: string, pfade: readonly string[] = REGELZIELE.map((z) => z.pfad)): string[] {
  const gitOrdner = path.join(wurzel, '.git');
  try {
    if (!fs.statSync(gitOrdner).isDirectory()) return [];
  } catch {
    return [];
  }
  const datei = path.join(gitOrdner, 'info', 'exclude');
  const alt = fs.existsSync(datei) ? fs.readFileSync(datei, 'utf8') : '';
  const zeilen = new Set(alt.split(/\r?\n/).map((z) => z.trim()));
  const fehlend = pfade.map((p) => `/${p}`).filter((p) => !zeilen.has(p));
  if (fehlend.length === 0) return [];
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  const trenner = alt === '' || alt.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(datei, `${alt}${trenner}# cachly: automatisch erzeugtes Projektwissen\n${fehlend.join('\n')}\n`, 'utf8');
  return fehlend;
}
