// Ein Ersatz fuer das Modul `vscode`, gerade genug, damit extension.ts im Test
// laeuft. Er legt nichts in VS Code ab, sondern in `zustand`, den der Test liest.
// Dateizugriffe gehen auf echte (Temp-)Ordner; Netzzugriffe der Erweiterung
// gehen an die Adresse, die der Test in `cachly.apiUrl` einstellt (eine
// Attrappe auf 127.0.0.1, nie die Produktion).

import * as fs from 'fs';
import * as path from 'path';

export interface Meldung {
  art: 'info' | 'warn' | 'error';
  text: string;
  knoepfe: string[];
}

export interface Statuseintrag {
  text: string;
  tooltip?: string;
  command?: string;
  sichtbar: boolean;
  entsorgt: boolean;
}

function frischerZustand() {
  return {
  isTrusted: true,
  appName: 'Visual Studio Code',
  ordner: [] as string[],
  aktiveDatei: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  meldungen: [] as Meldung[],
  /** Antwort auf eine Meldung mit Knoepfen: Funktion (Text, Knoepfe) -> Knopf oder undefined. */
  antwort: (_text: string, _knoepfe: string[]): string | undefined => undefined,
  statusEintraege: [] as Statuseintrag[],
  befehle: new Map<string, (...a: unknown[]) => unknown>(),
  ausgefuehrt: [] as Array<{ id: string; args: unknown[] }>,
  vertrauenHoerer: new Set<() => void>(),
  geoeffnet: [] as string[],
  chatTeilnehmer: [] as string[],
  };
}

export const zustand = frischerZustand();

/** Zwischen zwei Tests: alles auf Anfang (das Modul bleibt dasselbe, vitest merkt sich die Attrappe). */
export function zuruecksetzen(): void {
  Object.assign(zustand, frischerZustand());
  version = '1.140.0';
}

const entsorgbar = (fn: () => void = () => undefined) => ({ dispose: fn });
const ereignis = () => () => entsorgbar();

function uri(p: string) {
  return { fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file', toString: () => `file://${p.replace(/\\/g, '/')}` };
}

export let version = '1.140.0';
/** Fuer Tests, die eine aeltere VS-Code-Fassung brauchen (live binding). */
export function setzeVersion(v: string): void { version = v; }

export const Uri = {
  file: uri,
  parse: (s: string) => ({ fsPath: s, path: s, scheme: 'https', toString: () => s }),
  joinPath: (u: { fsPath: string }, ...teile: string[]) => uri(path.join(u.fsPath, ...teile)),
};

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { Beside: -2, Active: -1, One: 1 };
export const ProgressLocation = { Notification: 15, Window: 10, SourceControl: 1 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export class ThemeColor { constructor(public id: string) {} }
export class MarkdownString { constructor(public value = '') {} }
export class Range { constructor(public a?: unknown, public b?: unknown, public c?: unknown, public d?: unknown) {} }
export class CodeLens { constructor(public range?: unknown, public command?: unknown) {} }

class FakeEventEmitter<T> {
  private hoerer: Array<(e: T) => void> = [];
  event = (l: (e: T) => void) => { this.hoerer.push(l); return entsorgbar(); };
  fire(e: T) { for (const l of this.hoerer) l(e); }
  dispose() { this.hoerer = []; }
}
export { FakeEventEmitter as EventEmitter };

function konfiguration(abschnitt?: string) {
  const voll = (k: string) => (abschnitt ? `${abschnitt}.${k}` : k);
  return {
    get<T>(k: string, standard?: T): T | undefined {
      const v = zustand.config[voll(k)];
      return (v === undefined ? standard : v) as T | undefined;
    },
    has: (k: string) => zustand.config[voll(k)] !== undefined,
    inspect: () => undefined,
    async update(k: string, wert: unknown) {
      if (wert === undefined) delete zustand.config[voll(k)];
      else zustand.config[voll(k)] = wert;
    },
  };
}

export const workspace = {
  get isTrusted() { return zustand.isTrusted; },
  onDidGrantWorkspaceTrust(l: () => void) {
    zustand.vertrauenHoerer.add(l);
    return entsorgbar(() => zustand.vertrauenHoerer.delete(l));
  },
  get workspaceFolders() {
    return zustand.ordner.length
      ? zustand.ordner.map((p, index) => ({ uri: uri(p), name: path.basename(p), index }))
      : undefined;
  },
  getWorkspaceFolder(u: { fsPath: string }) {
    const p = zustand.ordner.find((o) => u.fsPath === o || u.fsPath.startsWith(o + path.sep));
    return p ? { uri: uri(p), name: path.basename(p), index: 0 } : undefined;
  },
  getConfiguration: konfiguration,
  asRelativePath: (p: string) => p,
  textDocuments: [] as unknown[],
  findFiles: async () => [] as unknown[],
  onDidChangeConfiguration: ereignis(),
  onDidChangeTextDocument: ereignis(),
  onDidOpenTextDocument: ereignis(),
  fs: {
    async readFile(u: { fsPath: string }) { return new Uint8Array(await fs.promises.readFile(u.fsPath)); },
    async writeFile(u: { fsPath: string }, inhalt: Uint8Array) {
      await fs.promises.mkdir(path.dirname(u.fsPath), { recursive: true });
      await fs.promises.writeFile(u.fsPath, inhalt);
    },
    async createDirectory(u: { fsPath: string }) { await fs.promises.mkdir(u.fsPath, { recursive: true }); },
    async stat(u: { fsPath: string }) { return fs.promises.stat(u.fsPath); },
  },
};

function meldung(art: Meldung['art']) {
  return async (text: string, ...knoepfe: unknown[]) => {
    const namen = knoepfe.filter((k): k is string => typeof k === 'string');
    zustand.meldungen.push({ art, text, knoepfe: namen });
    return namen.length ? zustand.antwort(text, namen) : undefined;
  };
}

export const window = {
  showInformationMessage: meldung('info'),
  showWarningMessage: meldung('warn'),
  showErrorMessage: meldung('error'),
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  setStatusBarMessage: () => entsorgbar(),
  withProgress: async (_o: unknown, aufgabe: (p: { report(): void }) => Promise<unknown>) => aufgabe({ report: () => undefined }),
  createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: ereignis() }, onDidDispose: ereignis(), reveal: () => undefined, dispose: () => undefined }),
  createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
  createStatusBarItem(): Statuseintrag & { show(): void; hide(): void; dispose(): void } {
    const e: Statuseintrag = { text: '', sichtbar: false, entsorgt: false };
    zustand.statusEintraege.push(e);
    return Object.assign(e, {
      show() { e.sichtbar = true; },
      hide() { e.sichtbar = false; },
      dispose() { e.entsorgt = true; e.sichtbar = false; },
    });
  },
  get activeTextEditor() {
    return zustand.aktiveDatei ? { document: { uri: uri(zustand.aktiveDatei), scheme: 'file' } } : undefined;
  },
  onDidChangeActiveTextEditor: ereignis(),
};

export const commands = {
  registerCommand(id: string, fn: (...a: unknown[]) => unknown) {
    zustand.befehle.set(id, fn);
    return entsorgbar(() => zustand.befehle.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]) {
    zustand.ausgefuehrt.push({ id, args });
    return zustand.befehle.get(id)?.(...args);
  },
};

export const languages = {
  registerCodeLensProvider: () => entsorgbar(),
  onDidChangeDiagnostics: ereignis(),
  getDiagnostics: () => [] as unknown[],
};

export const extensions = { getExtension: () => ({ packageJSON: { version: '0.0.0-test' } }) };
export const authentication = { getSession: async () => undefined };
export const chat = {
  createChatParticipant(id: string) {
    zustand.chatTeilnehmer.push(id);
    return entsorgbar(() => { zustand.chatTeilnehmer = zustand.chatTeilnehmer.filter((i) => i !== id); });
  },
};

export const env = {
  get appName() { return zustand.appName; },
  openExternal: async (u: { toString(): string }) => { zustand.geoeffnet.push(u.toString()); return true; },
  clipboard: { writeText: async () => undefined },
  machineId: 'test',
  sessionId: 'test',
};

/** Wie VS Code, wenn der Mensch auf "Trust" klickt. */
export function vertrauenGewaehren(): void {
  zustand.isTrusted = true;
  for (const l of [...zustand.vertrauenHoerer]) l();
}
