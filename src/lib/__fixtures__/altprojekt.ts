// Ein Projekt, wie es die Erweiterung 0.12.6 und davor hinterlassen hat —
// samt Schluessel in .mcp.json, in den vier Hook-Skripten und im Git-Hook.
// Die Texte sind der alte Stand Zeichen fuer Zeichen (extension.ts 0.12.6,
// lib/ambient.ts v3, lib/config.ts CLS v2). Nur fuer Tests.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SCHLUESSEL = 'cky_trial_0123456789abcdefABCDEF';
export const INSTANZ = '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0';

const EREIGNISSE = {
  SessionStart: 'cachly-ambient-session-start.mjs',
  UserPromptSubmit: 'cachly-ambient-prompt-submit.mjs',
  PreToolUse: 'cachly-ambient-pre-tool.mjs',
  Stop: 'cachly-ambient-stop.mjs',
} as const;

/** Das v3-Skript von 0.12.6, mit dem Schluessel als Zeichenkette. */
export function altesHookSkript(event: keyof typeof EREIGNISSE, instanceId: string, apiKey: string): string {
  return [
    `#!/usr/bin/env node`,
    `// cachly Ambient Recall — ${event} v3`,
    `// Pushes relevant memory into context automatically. Cross-platform Node hook`,
    `// (no shell script — runs identically on Windows/macOS/Linux). Never blocks`,
    `// the agent: every failure path exits 0 with no output (graceful degrade).`,
    `import { spawn } from 'node:child_process';`,
    `process.env.CACHLY_BRAIN_INSTANCE_ID = '${instanceId}';`,
    `process.env.CACHLY_JWT = '${apiKey}';`,
    `process.env.CACHLY_HOOK_EVENT = '${event}';`,
    `try {`,
    `  const child = spawn('npx @cachly-dev/mcp-server@latest ambient-recall', { shell: true, stdio: ['inherit', 'inherit', 'ignore'] });`,
    `  child.on('error', () => process.exit(0));`,
    `  child.on('close', () => process.exit(0));`,
    `} catch {`,
    `  process.exit(0);`,
    `}`,
  ].join('\n') + '\n';
}

/** Der CLS-Git-Hook v2 von 0.12.6, mit `export CACHLY_JWT`. */
export function alterGitHook(instanceId: string, apiKey: string): string {
  return [
    `#!/bin/sh`,
    `# cachly CLS — Continuous Learning Stream v2 (installed by Cachly VS Code extension)`,
    `# Runs silently on every commit to keep your brain up to date.`,
    `export CACHLY_BRAIN_INSTANCE_ID="${instanceId}"`,
    `export CACHLY_JWT="${apiKey}"`,
    `CLS_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `export CLS_SHA`,
    `exit 0`,
  ].join('\n') + '\n';
}

export interface AltprojektOptionen {
  /** Standard: SCHLUESSEL */
  schluessel?: string;
  instanceId?: string;
  /** Ein fremder Server und ein fremder Hook, die unangetastet bleiben muessen. */
  mitFremdem?: boolean;
}

export const FREMDER_GIT_HOOK = '#!/bin/sh\necho "mein eigener post-commit"\n';

/** Legt ein Projekt mit .git, .mcp.json, .claude/ und dem alten Git-Hook an. Gibt den Ordner zurueck. */
export function legeAltprojektAn(optionen: AltprojektOptionen = {}): string {
  const key = optionen.schluessel ?? SCHLUESSEL;
  const inst = optionen.instanceId ?? INSTANZ;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cachly-altprojekt-'));
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');

  const mcp: Record<string, unknown> = {
    cachly: {
      command: 'npx',
      args: ['-y', '@cachly-dev/mcp-server@latest'],
      env: { CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_JWT: key, CACHLY_BRAIN_INSTANCE_ID: inst },
    },
  };
  if (optionen.mitFremdem) mcp.fremd = { command: 'node', args: ['server.js'], env: { TOKEN: 'bleibt' } };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: mcp }, null, 2));

  const hookDir = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const settingsHooks: Record<string, unknown[]> = {};
  for (const [event, name] of Object.entries(EREIGNISSE)) {
    const p = path.join(hookDir, name);
    fs.writeFileSync(p, altesHookSkript(event as keyof typeof EREIGNISSE, inst, key));
    settingsHooks[event] = [
      {
        ...(event === 'PreToolUse' ? { matcher: 'Edit|Write|MultiEdit|NotebookEdit' } : {}),
        hooks: [{ type: 'command', command: `node "${p.replace(/\\/g, '/')}"`, timeout: 10 }],
      },
    ];
  }
  if (optionen.mitFremdem) {
    settingsHooks.SessionStart.unshift({ hooks: [{ type: 'command', command: '/usr/local/bin/mein-hook.sh' }] });
  }
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: settingsHooks }, null, 2) + '\n',
  );

  fs.writeFileSync(
    path.join(root, '.git', 'hooks', 'post-commit'),
    (optionen.mitFremdem ? FREMDER_GIT_HOOK + '\n' : '') + alterGitHook(inst, key),
  );
  return root;
}

/** Alle Dateien unter `root`, die den Text enthalten (relativ, mit `/`). Geht in .git hinein. */
export function dateienMit(root: string, text: string): string[] {
  const treffer: string[] = [];
  const geh = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) geh(p);
      else if (fs.readFileSync(p).includes(text)) treffer.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  geh(root);
  return treffer.sort();
}

export function alleDateien(root: string): string[] {
  const liste: string[] = [];
  const geh = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) geh(p);
      else liste.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  geh(root);
  return liste.sort();
}
