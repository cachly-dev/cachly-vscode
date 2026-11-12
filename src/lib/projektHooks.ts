// Hooks im Projekt: der Git-Hook nach jedem Commit (CLS) und die Hooks fuer
// Claude Code (Ambient Recall). vscode-frei, damit ein Test sie auf einem
// Temp-Ordner laufen lassen und danach jede Datei auf den Schluessel pruefen kann.
//
// Beide tragen seit 12.10.2026 KEINEN Schluessel mehr. Bis 0.12.6 stand er in
// `.git/hooks/post-commit` (`export CACHLY_JWT=...`) und in den vier Skripten
// unter `.claude/hooks/` (`process.env.CACHLY_JWT = '...'`). Die Skripte sind
// Projektdateien, die `git add .` einsammelt. Die Hooks finden den Schluessel
// jetzt selbst: Umgebung, dann ~/.cachly/credentials.json (hook-zugang.ts).

import * as fs from 'fs';
import * as path from 'path';
import { buildClsPostCommitHook, CLS_HOOK_VERSION, parseJsonc } from './config';
import {
  buildAmbientHook,
  mergeAmbientSettings,
  AMBIENT_SCRIPT_NAMES,
  AMBIENT_HOOK_VERSION,
  HOOK_BUENDEL,
  type AmbientHookEvent,
  type AmbientHookPaths,
  type ClaudeSettingsLike,
} from './ambient';

type Log = (message: string, ...details: unknown[]) => void;
const keinLog: Log = () => undefined;

/** Ein cachly-Block im Git-Hook, von der Markierung bis zum `exit 0` (mit Shebang davor, falls er allein steht). */
const CLS_BLOCK = /(?:#!\/bin\/sh\n)?# cachly CLS[\s\S]*?\nexit 0\n?/;

/**
 * Installiert den CLS-Git-Hook (post-commit). Idempotent: aktuell = nichts tun,
 * ein alter cachly-Block (auch einer mit Schluessel) = an Ort und Stelle
 * ersetzen, fremder Hook ohne cachly-Block = anhaengen. Wirft nie.
 */
export async function installiereClsHook(root: string, instanceId: string, log: Log = keinLog): Promise<void> {
  try {
    const gitDir = path.join(root, '.git');
    if (!fs.existsSync(gitDir)) return; // kein Git-Ordner (oder eine Worktree-Datei): auslassen
    const hookDir = path.join(gitDir, 'hooks');
    const hookPath = path.join(hookDir, 'post-commit');
    await fs.promises.mkdir(hookDir, { recursive: true });
    const hookScript = buildClsPostCommitHook(instanceId);
    let vorhanden = '';
    try { vorhanden = await fs.promises.readFile(hookPath, 'utf8'); } catch { /* noch keiner */ }

    if (!vorhanden) {
      await fs.promises.writeFile(hookPath, hookScript + '\n', 'utf8');
      try { await fs.promises.chmod(hookPath, 0o755); } catch { /* Windows */ }
      log('Installed CLS hook at .git/hooks/post-commit');
      return;
    }
    if (vorhanden.includes(`cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`)) {
      log('CLS hook already current in .git/hooks/post-commit');
      return;
    }
    if (CLS_BLOCK.test(vorhanden)) {
      const ersetzt = vorhanden.replace(CLS_BLOCK, hookScript);
      await fs.promises.writeFile(hookPath, ersetzt.endsWith('\n') ? ersetzt : ersetzt + '\n', 'utf8');
      try { await fs.promises.chmod(hookPath, 0o755); } catch { /* Windows */ }
      log('Upgraded CLS hook in .git/hooks/post-commit');
      return;
    }
    await fs.promises.writeFile(hookPath, vorhanden.trimEnd() + '\n\n' + hookScript + '\n', 'utf8');
    log('Appended CLS hook to existing .git/hooks/post-commit');
  } catch (e) {
    log('CLS hook install skipped (non-critical)', (e as Error).message);
  }
}

/**
 * Installiert die Ambient-Recall-Hooks (v5): vier kleine Skripte, das Buendel
 * daneben und die Eintraege in `.claude/settings.json`. Idempotent und
 * schonend: fremde Hooks bleiben, alte cachly-Eintraege werden ersetzt.
 * Dasselbe Ergebnis wie `installAmbientHooks` in sdk/mcp. Wirft nie.
 *
 * @param buendelQuelle  Pfad zu `cachly-ambient-einblendung.mjs` (liegt in der Erweiterung unter hooks/).
 */
export async function installiereAmbientHooks(
  root: string,
  instanceId: string,
  buendelQuelle: string,
  log: Log = keinLog,
): Promise<void> {
  try {
    const hookDir = path.join(root, '.claude', 'hooks');
    // Ohne Buendel taten die Skripte nichts: dann lieber gar nichts schreiben.
    let buendel: string;
    try {
      buendel = await fs.promises.readFile(buendelQuelle, 'utf8');
    } catch (e) {
      log(`Ambient hooks skipped: bundle ${HOOK_BUENDEL} not readable`, (e as Error).message);
      return;
    }
    await fs.promises.mkdir(hookDir, { recursive: true });

    let geschrieben = false;
    const buendelPfad = path.join(hookDir, HOOK_BUENDEL);
    let altBuendel = '';
    try { altBuendel = await fs.promises.readFile(buendelPfad, 'utf8'); } catch { /* neu */ }
    // Das Buendel zuerst: ein Skript, das schon laeuft, darf es nie halb geschrieben vorfinden.
    if (altBuendel !== buendel) {
      await fs.promises.writeFile(buendelPfad, buendel, 'utf8');
      geschrieben = true;
    }

    const events: AmbientHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
    // In settings.json steht der Pfad projektbezogen, nicht absolut (04.11.2026):
    // die Datei wird oft eingecheckt, und ein absoluter Pfad brach bei jedem
    // Kollegen und nach jedem Verschieben. Gemessen mit Claude Code 2.1.314
    // unter Windows: `node "${CLAUDE_PROJECT_DIR}/…"` laeuft wie der absolute
    // Pfad; aus einem Unterordner gestartet laedt Claude Code die Projekt-
    // settings.json gar nicht — der absolute Pfad hatte dort keinen Vorteil.
    // Dieselbe Form wie sdk/mcp/src/ambient-hooks.ts (installAmbientHooks).
    const paths = {} as AmbientHookPaths;
    for (const event of events) {
      const p = path.join(hookDir, AMBIENT_SCRIPT_NAMES[event]);
      paths[event] = `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${AMBIENT_SCRIPT_NAMES[event]}`;
      const script = buildAmbientHook(event, instanceId) + '\n';
      let prev = '';
      try { prev = await fs.promises.readFile(p, 'utf8'); } catch { /* neu */ }
      if (prev !== script) {
        await fs.promises.writeFile(p, script, 'utf8');
        try { await fs.promises.chmod(p, 0o755); } catch { /* Windows */ }
        geschrieben = true;
      }
    }

    const settingsPath = path.join(root, '.claude', 'settings.json');
    let existing: ClaudeSettingsLike = {};
    let lesbar = true;
    try {
      existing = parseJsonc(await fs.promises.readFile(settingsPath, 'utf8')) as ClaudeSettingsLike;
    } catch (e) {
      try {
        await fs.promises.stat(settingsPath);
        lesbar = false; // gibt es, laesst sich aber nicht lesen: nie ueberschreiben
        log('.claude/settings.json exists but could not be parsed — not overwriting', (e as Error).message);
      } catch { /* wirklich neu */ }
    }
    if (lesbar) {
      const { settings, changed } = mergeAmbientSettings(existing, paths);
      if (changed) {
        await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        geschrieben = true;
      }
    }
    if (geschrieben) log(`Ambient Recall hooks installed/updated (.claude/hooks, ${AMBIENT_HOOK_VERSION})`);
  } catch (e) {
    log('Ambient hooks install skipped (non-critical)', (e as Error).message);
  }
}

/**
 * Das Buendel in Projekten auffrischen, in denen schon eines liegt.
 *
 * Bis 0.12.18 kam ein neues Buendel nur mit "cachly: Setup" ins Projekt: ein
 * Update der Erweiterung allein liess die alte Datei liegen. Am 12.11.2026 hiess
 * das: der Filter fuer private und Gruppen-Lektionen (MCP 0.10.250) waere bei
 * keinem bestehenden Projekt angekommen.
 *
 * Ersetzt wird NUR das Buendel und NUR, wo es schon liegt. Neue Hooks legt
 * weiter allein das Einrichten an. Geschrieben wird ueber eine Nachbardatei und
 * Umbenennen: ein Hook, der gerade startet, darf keine halbe Datei laden.
 *
 * @returns die Pfade, die neu geschrieben wurden
 */
export async function frischeBuendelAuf(ordner: string[], buendelQuelle: string, log: Log = keinLog): Promise<string[]> {
  let neu: string;
  try {
    neu = await fs.promises.readFile(buendelQuelle, 'utf8');
  } catch (e) {
    log(`Hook bundle refresh skipped: ${HOOK_BUENDEL} not readable`, (e as Error).message);
    return [];
  }
  const geschrieben: string[] = [];
  for (const o of new Set(ordner)) {
    const ziel = path.join(o, '.claude', 'hooks', HOOK_BUENDEL);
    let alt: string;
    try {
      alt = await fs.promises.readFile(ziel, 'utf8');
    } catch {
      continue; // kein Buendel im Projekt: nichts anlegen
    }
    if (alt === neu) continue;
    const zwischen = `${ziel}.${process.pid}.neu`;
    try {
      await fs.promises.writeFile(zwischen, neu, 'utf8');
      await fs.promises.rename(zwischen, ziel);
      geschrieben.push(ziel);
    } catch (e) {
      await fs.promises.rm(zwischen, { force: true }).catch(() => undefined);
      log('Hook bundle refresh failed (non-critical)', ziel, (e as Error).message);
    }
  }
  if (geschrieben.length) log('Hook bundle refreshed', geschrieben);
  return geschrieben;
}
