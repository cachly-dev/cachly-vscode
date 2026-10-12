// Workspace Trust (eingeschraenkter Modus) und die Meldungen zum Schluessel —
// Texte und Namen an einer Stelle, vscode-frei.
//
// ── Warum (12.10.2026) ───────────────────────────────────────────────────────
//
// Ein frisch geoeffneter Ordner startet in VS Code im eingeschraenkten Modus
// (Restricted Mode): ein duenner Hinweisstreifen oben, ein Eintrag in der
// Statusleiste, kein Dialog. Die Erweiterung erklaerte nicht, dass sie
// Vertrauen braucht (package.json hatte keine `capabilities`; das heisst fuer
// VS Code "nicht unterstuetzt"), und blieb deshalb aus: kein Eintrag im
// Protokoll, kein Konto, keine Datei, kein Hinweis. In 15 Sekunden und in zwei
// Minuten Beobachtung. Erst nach dem Klick auf "Trust" stand das Konto, nach
// 2,0 bis 2,8 Sekunden. Wer den Hinweis uebersieht, erlebt: nichts.
//
// Jetzt erklaert package.json `untrustedWorkspaces: limited`. Im eingeschraenkten
// Modus laeuft nur ein harmloser Teil: Statusleiste und eine einmalige Meldung
// mit einem Knopf, der den Vertrauensdialog oeffnet. Es werden KEINE Dateien
// geschrieben, KEIN Konto angelegt, KEINE Anfrage ans Netz geschickt. Nach dem
// Vertrauen (`workspace.onDidGrantWorkspaceTrust`) laeuft der bisherige Weg.

/** VS Code: oeffnet den Editor "Workspace Trust verwalten" (workspace.ts, MANAGE_TRUST_COMMAND_ID). */
export const VERTRAUEN_BEFEHL = 'workbench.trust.manage';

export const VERTRAUEN_STATUSLEISTE = '$(shield) cachly: trust this folder to connect';

export const VERTRAUEN_STATUSLEISTE_HILFE =
  'cachly is paused because this folder is in Restricted Mode. Click to open Workspace Trust. ' +
  'Until you trust the folder, cachly writes no files, creates no account and contacts no server.';

export const VERTRAUEN_MELDUNG =
  'cachly is paused: VS Code opened this folder in Restricted Mode. Until you trust it, cachly writes no files, ' +
  'creates no account and contacts no server. Trust the folder and cachly connects by itself.';

export const VERTRAUEN_KNOPF = 'Trust this folder...';

/** Beschreibung fuer `capabilities.untrustedWorkspaces` in package.json (der Test haelt beide gleich). */
export const VERTRAUEN_BESCHREIBUNG =
  'In Restricted Mode cachly only shows a status bar item and one notice. It writes no files, creates no account ' +
  'and contacts no server until you trust the folder.';

// ── Schluessel ───────────────────────────────────────────────────────────────

/** Die Meldung nach der Bereinigung, wortgleich wie bestellt. Sie erscheint nur, wenn wirklich ein Schluessel gefunden wurde. */
export const ALTBESTAND_MELDUNG =
  'Your cachly key was stored in project files. It has been moved to your home folder. ' +
  'If you committed those files, rotate the key at cachly.dev.';

export const ALTBESTAND_KNOPF = 'Open cachly.dev';

/**
 * Die Meldung samt dem, was sich nicht umschreiben liess (Kommentare, kaputtes
 * JSON). `verschoben`: mindestens eine Datei ist sauber umgeschrieben, der
 * Schluessel liegt im Heimordner. Sonst stimmt "moved" nicht, und der Text sagt
 * nur, was zu tun ist.
 */
export function altbestandText(verschoben: boolean, offen: string[]): string {
  const dateien = offen.join(', ');
  if (verschoben) {
    return offen.length === 0
      ? ALTBESTAND_MELDUNG
      : `${ALTBESTAND_MELDUNG} These files still contain it and need a manual edit: ${dateien}.`;
  }
  return (
    `Your cachly key is stored in project files that cachly cannot rewrite safely (${dateien}). ` +
    'Remove the key by hand. If you committed those files, rotate the key at cachly.dev.'
  );
}

export const HEIM_KONFLIKT_MELDUNG =
  'A different cachly key already sits in ~/.cachly/credentials.json (from the terminal setup, the Claude Code ' +
  'plugin or another editor). cachly did not overwrite it, and it writes no key into your project. Until the two ' +
  "match, Claude Code in this folder may not reach this folder's Brain.";

export const HEIM_KONFLIKT_ERSETZEN = "Use this extension's key";
export const HEIM_KONFLIKT_BEHALTEN = 'Keep the other key';

export function heimFehlerText(grund: string): string {
  return (
    `cachly could not store your key in ~/.cachly/credentials.json (${grund}). Nothing was written into your ` +
    'project either, so Claude Code will not find the key until this works.'
  );
}

export const VERTRAUEN_CHAT_ANTWORT =
  'cachly is paused: this folder is in Restricted Mode. Trust the folder and cachly connects by itself.';
