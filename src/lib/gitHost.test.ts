import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { erkenneGitHost, erkenneHostAusConfig, ersetzeStringWert, fuegeStringWertEin, hostnameAusGitUrl } from './gitHost';

const temp: string[] = [];
afterEach(() => { for (const p of temp.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-githost-')); temp.push(p); return p; };
const cfg = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;

describe('hostnameAusGitUrl', () => {
  it('liest https, ssh:// und git@host:pfad', () => {
    expect(hostnameAusGitUrl('https://github.com/me/app.git')).toBe('github.com');
    expect(hostnameAusGitUrl('https://user:tok@gitlab.com/me/app.git')).toBe('gitlab.com');
    expect(hostnameAusGitUrl('ssh://git@gitlab.example.org:2222/me/app.git')).toBe('gitlab.example.org');
    expect(hostnameAusGitUrl('git@github.com:me/app.git')).toBe('github.com');
  });
});

describe('erkenneHostAusConfig (vscode-8)', () => {
  it('ein Name im Pfad macht keinen Host: github.com/me/gitlab-tools ist GitHub', () => {
    expect(erkenneHostAusConfig(cfg('https://github.com/me/gitlab-tools.git'))).toBe('github');
    expect(erkenneHostAusConfig(cfg('https://gitlab.com/me/github-mirror.git'))).toBe('gitlab');
  });

  it('eigene GitLab-Adresse mit gitlab. am Anfang; unbekannte Hosts bleiben unbekannt', () => {
    expect(erkenneHostAusConfig(cfg('git@gitlab.firma.de:team/app.git'))).toBe('gitlab');
    expect(erkenneHostAusConfig(cfg('https://git.firma.de/gitlab/app.git'))).toBeUndefined();
  });

  it('origin hat Vorrang vor anderen Remotes', () => {
    const t = `[remote "upstream"]\n\turl = https://gitlab.com/x/y.git\n[remote "origin"]\n\turl = https://github.com/me/app.git\n`;
    expect(erkenneHostAusConfig(t)).toBe('github');
  });
});

describe('erkenneGitHost mit .git als Datei (vscode-8)', () => {
  it('Worktree: nimmt die Konfiguration des Haupt-Repos (commondir)', async () => {
    const haupt = tmp();
    fs.mkdirSync(path.join(haupt, '.git', 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(haupt, '.git', 'config'), cfg('git@github.com:me/app.git'));
    fs.writeFileSync(path.join(haupt, '.git', 'worktrees', 'w1', 'commondir'), '../..\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(haupt, '.git', 'worktrees', 'w1')}\n`);
    expect(await erkenneGitHost(wt)).toBe('github');
  });

  it('Submodul: gitdir mit eigener config', async () => {
    const wurzel = tmp();
    fs.mkdirSync(path.join(wurzel, '.git', 'modules', 'm'), { recursive: true });
    fs.writeFileSync(path.join(wurzel, '.git', 'modules', 'm', 'config'), cfg('https://gitlab.com/me/m.git'));
    fs.mkdirSync(path.join(wurzel, 'm'));
    fs.writeFileSync(path.join(wurzel, 'm', '.git'), 'gitdir: ../.git/modules/m\n');
    expect(await erkenneGitHost(path.join(wurzel, 'm'))).toBe('gitlab');
  });

  it('kein .git: undefined, kein Fehler', async () => {
    expect(await erkenneGitHost(tmp())).toBeUndefined();
  });
});

describe('ersetzeStringWert (vscode-9)', () => {
  it('tauscht nur den Wert und laesst Kommentare und Kommas stehen', () => {
    const t = '{\n  // Notiz\n  "a": 1,\n  "cachly.instanceId": "alt",\n}\n';
    expect(ersetzeStringWert(t, 'cachly.instanceId', 'neu')).toBe('{\n  // Notiz\n  "a": 1,\n  "cachly.instanceId": "neu",\n}\n');
  });

  it('fehlender oder doppelter Schluessel: undefined', () => {
    expect(ersetzeStringWert('{ "a": 1 }', 'cachly.instanceId', 'x')).toBeUndefined();
    expect(ersetzeStringWert('{ "k": "1", "k": "2" }', 'k', 'x')).toBeUndefined();
  });
});

describe('fuegeStringWertEin (vscode-9, Schluessel fehlt)', () => {
  it('Datei mit Kommentaren: nur die neue Zeile kommt hinzu, der Rest bleibt Byte fuer Byte', () => {
    const t = '// Kopf\n{\n  // Notiz\n  "a": 1, /* x */\n  "b": [1,2],\n}\n';
    const neu = fuegeStringWertEin(t, 'cachly.instanceId', 'neu');
    expect(neu).toBe('// Kopf\n{\n  "cachly.instanceId": "neu",\n  // Notiz\n  "a": 1, /* x */\n  "b": [1,2],\n}\n');
  });

  it('leeres Objekt: kein Komma zu viel', () => {
    expect(fuegeStringWertEin('{}', 'k', 'v')).toBe('{\n  "k": "v"\n}');
    expect(fuegeStringWertEin('{ // nur Notiz\n}', 'k', 'v')).toBe('{\n  "k": "v" // nur Notiz\n}');
  });

  it('kein Objekt oder leer: undefined', () => {
    expect(fuegeStringWertEin('', 'k', 'v')).toBeUndefined();
    expect(fuegeStringWertEin('[1]', 'k', 'v')).toBeUndefined();
    expect(fuegeStringWertEin('{ // offen', 'k', 'v')).toBeUndefined();
  });
});
