#!/usr/bin/env node
/**
 * Holt das Hook-Buendel aus sdk/mcp in die Erweiterung.
 *
 *   sdk/mcp/hooks/cachly-ambient-einblendung.mjs   Quelle (erzeugt: npm run plugin-hooks:write)
 *   sdk/vscode/hooks/cachly-ambient-einblendung.mjs  Kopie, die ins VSIX kommt
 *
 * Die Erweiterung schreibt die vier Hook-Skripte mit dem Buendel daneben in
 * `.claude/hooks/` (src/lib/projektHooks.ts) — dieselben Dateien wie `setup`
 * im MCP-Server. Eine Quelle, eine Kopie, ein Waechter
 * (src/lib/buendel.test.ts).
 *
 * Aufruf (aus sdk/vscode):
 *   npm run hooks:sync       kopiert, wenn sdk/mcp daneben liegt
 *   npm run hooks:pruefen    meldet Abweichung, schreibt nicht
 *
 * Liegt sdk/mcp nicht daneben (der oeffentliche Spiegel cachly-vscode hat nur
 * diesen Ordner), bleibt die eingecheckte Kopie, wie sie ist.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const NAME = 'cachly-ambient-einblendung.mjs';
const QUELLE = resolve(HIER, '..', '..', 'mcp', 'hooks', NAME);
const ZIEL = resolve(HIER, '..', 'hooks', NAME);
const nurPruefen = process.argv.includes('--pruefen');

if (!existsSync(QUELLE)) {
  if (!existsSync(ZIEL)) {
    console.error(`FEHLT: ${ZIEL} — und ${QUELLE} liegt auch nicht daneben. Ohne das Buendel tun die Hook-Skripte nichts.`);
    process.exit(1);
  }
  console.log(`sdk/mcp liegt nicht daneben (Spiegel): eingecheckte Kopie bleibt (${ZIEL}).`);
  process.exit(0);
}

const gleich = existsSync(ZIEL) && readFileSync(QUELLE).equals(readFileSync(ZIEL));
if (gleich) {
  console.log('Hook-Buendel in sdk/vscode/hooks/ ist aktuell.');
  process.exit(0);
}
if (nurPruefen) {
  console.error(`ABWEICHUNG: ${ZIEL} ist nicht die Fassung aus sdk/mcp/hooks/. Abhilfe: npm run hooks:sync (in sdk/vscode).`);
  process.exit(1);
}
mkdirSync(join(HIER, '..', 'hooks'), { recursive: true });
copyFileSync(QUELLE, ZIEL);
console.log('Hook-Buendel nach sdk/vscode/hooks/ kopiert.');
