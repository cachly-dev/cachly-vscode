import { describe, it, expect } from 'vitest';
import { editorFassung, programmName } from './programm';
import { hatCopilot } from './copilotMcp';

describe('programmName: welches Programm die Erweiterung traegt', () => {
  it('die bekannten Programme', () => {
    expect(programmName('Visual Studio Code')).toBe('vscode');
    expect(programmName('Visual Studio Code - Insiders')).toBe('vscode');
    expect(programmName('Cursor')).toBe('cursor');
    expect(programmName('Windsurf')).toBe('windsurf');
    expect(programmName('VSCodium')).toBe('vscodium');
    expect(programmName('Trae')).toBe('trae');
    expect(programmName('Kiro')).toBe('kiro');
    expect(programmName('Positron')).toBe('positron');
  });

  it('Unbekanntes wird ein kurzes Kennwort, nie Freitext und nie laenger als die Spalte', () => {
    expect(programmName('Neuer Editor 3000!')).toBe('neuer-editor-3000');
    expect(programmName('x'.repeat(80)).length).toBe(32);
    expect(programmName('')).toBe('vscode');
    expect(programmName(undefined)).toBe('vscode');
  });

  it('eine Regel fuer VS Code: hatCopilot und programmName sind sich einig', () => {
    for (const name of ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']) {
      expect(hatCopilot(name), name).toBe(programmName(name) === 'vscode');
    }
  });
});

describe('editorFassung', () => {
  it('behaelt die Fassung, wirft alles andere weg', () => {
    expect(editorFassung('1.105.0')).toBe('1.105.0');
    expect(editorFassung('1.106.0-insider')).toBe('1.106.0-insider');
    expect(editorFassung('1.0 <script>')).toBe('1.0script');
    expect(editorFassung(undefined)).toBe('');
    expect(editorFassung('9'.repeat(50)).length).toBe(32);
  });
});
