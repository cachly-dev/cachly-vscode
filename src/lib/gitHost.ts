// Git-Host des Projekts erkennen — rein, ohne vscode, testbar.
//
// 03.11.2026 (vscode-8): Vorher las die Erweiterung nur `.git/config` und pruefte
// `url.includes('gitlab')` vor 'github'. Folgen: github.com/me/gitlab-tools galt als
// GitLab, und in Worktrees und Submodulen (dort ist `.git` eine Datei) wurde nichts
// erkannt und nichts geschrieben.

import * as fs from 'fs';
import * as path from 'path';

export type GitHost = 'github' | 'gitlab' | undefined;

/** Der Rechnername aus einer Git-Adresse (https, ssh://, git@host:pfad). */
export function hostnameAusGitUrl(url: string): string | undefined {
  const u = url.trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^:/\s]+)/i.exec(u);
  if (m) return m[1].toLowerCase();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(u); // git@github.com:me/app.git
  return scp ? scp[1].toLowerCase() : undefined;
}

function hostVonName(host: string | undefined): GitHost {
  if (!host) return undefined;
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  if (host === 'github.com' || host.startsWith('github.')) return 'github';
  return undefined;
}

/** Erkennt den Host am Rechnernamen von `origin` (sonst der ersten Adresse) in einer Git-Konfiguration. */
export function erkenneHostAusConfig(cfg: string): GitHost {
  const urls: Array<{ abschnitt: string; url: string }> = [];
  let abschnitt = '';
  for (const zeile of cfg.split(/\r?\n/)) {
    const k = /^\s*\[(.+)\]\s*$/.exec(zeile);
    if (k) { abschnitt = k[1].trim(); continue; }
    const u = /^\s*url\s*=\s*(.+?)\s*$/.exec(zeile);
    if (u) urls.push({ abschnitt, url: u[1] });
  }
  const origin = urls.find((e) => /^remote\s+"origin"$/.test(e.abschnitt));
  const reihenfolge = origin ? [origin, ...urls.filter((e) => e !== origin)] : urls;
  for (const e of reihenfolge) {
    const h = hostVonName(hostnameAusGitUrl(e.url));
    if (h) return h;
  }
  return undefined;
}

/** Pfad der Git-Konfiguration; loest `.git`-Dateien (Worktree, Submodul) auf. */
export async function gitConfigPfad(root: string): Promise<string> {
  const punktGit = path.join(root, '.git');
  const st = await fs.promises.stat(punktGit);
  if (st.isDirectory()) return path.join(punktGit, 'config');
  const inhalt = await fs.promises.readFile(punktGit, 'utf8');
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(inhalt);
  if (!m) throw new Error('.git ohne gitdir');
  const gitdir = path.resolve(root, m[1]);
  try {
    // Worktree: die gemeinsame Konfiguration liegt im Haupt-Repo.
    const common = (await fs.promises.readFile(path.join(gitdir, 'commondir'), 'utf8')).trim();
    return path.join(path.resolve(gitdir, common), 'config');
  } catch {
    return path.join(gitdir, 'config'); // Submodul
  }
}

export async function erkenneGitHost(root: string): Promise<GitHost> {
  try {
    return erkenneHostAusConfig(await fs.promises.readFile(await gitConfigPfad(root), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Setzt `"<schluessel>": "<wert>"` in einer JSONC-Datei und laesst alles andere stehen
 * (Kommentare, Kommas). Gibt undefined zurueck, wenn der Schluessel nicht genau einmal
 * als Textzeile vorkommt; dann muss der Aufrufer neu schreiben.
 */
export function ersetzeStringWert(text: string, schluessel: string, wert: string): string | undefined {
  const esc = schluessel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${esc}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g');
  const treffer = text.match(re);
  if (!treffer || treffer.length !== 1) return undefined;
  return text.replace(re, (_m, kopf: string) => `${kopf}${JSON.stringify(wert)}`);
}

/**
 * Fuegt `"<schluessel>": "<wert>"` direkt hinter der ersten `{` einer JSONC-Datei ein und laesst
 * jedes andere Byte stehen (Kommentare, Kommas, Einrueckung). 03.11.2026: JSON.stringify haette
 * beim ersten Setup die Kommentare des Nutzers geloescht. Gibt undefined zurueck, wenn die Datei
 * kein Objekt ist (erstes Zeichen ausser Leerraum und Kommentaren ist keine `{`); dann muss der
 * Aufrufer neu schreiben.
 */
export function fuegeStringWertEin(text: string, schluessel: string, wert: string): string | undefined {
  // Naechstes Zeichen suchen, das weder Leerraum noch Kommentar ist.
  const naechstes = (ab: number): number => {
    let i = ab;
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\uFEFF') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '/' && text[i + 1] === '*') {
        const ende = text.indexOf('*/', i + 2);
        if (ende < 0) return -1;
        i = ende + 2;
        continue;
      }
      return i;
    }
    return -1;
  };
  const klammer = naechstes(0);
  if (klammer < 0 || text[klammer] !== '{') return undefined;
  const dahinter = naechstes(klammer + 1);
  if (dahinter < 0) return undefined; // Datei bricht nach der `{` ab: nicht sicher einfuegen
  const leer = text[dahinter] === '}';
  const zeile = `\n  ${JSON.stringify(schluessel)}: ${JSON.stringify(wert)}${leer ? '' : ','}`;
  return text.slice(0, klammer + 1) + zeile + (leer && dahinter === klammer + 1 ? '\n' : '') + text.slice(klammer + 1);
}
