// Pure, vscode-free configuration helpers — fully unit-testable.
//
// These encode the config-resolution rules that have historically caused
// "Brain: OFFLINE" bugs. Keeping them here (with no `vscode` import) means they
// can be exercised by fast unit tests without the VS Code test host.

export const DEFAULT_API_URL = 'https://api.cachly.dev';

/**
 * Normalize a user-provided API base URL.
 *
 * vscode's `config.get(key, default)` only returns the default when the value
 * is `undefined`. A user who sets `cachly.apiUrl` to an EMPTY STRING (a common
 * stale-setting mistake) would otherwise get `''` back, turning every request
 * into a host-less relative URL that always fails → "Brain: OFFLINE" forever.
 *
 * Rules: empty/whitespace → fallback; trailing slashes stripped so URL
 * concatenation (`${base}/api/...`) never produces a double slash.
 */
export function normalizeBaseUrl(
  raw: string | undefined | null,
  fallback: string = DEFAULT_API_URL,
): string {
  const v = (raw ?? '').trim();
  return (v || fallback).replace(/\/+$/, '');
}

export interface InstanceIdSources {
  /** cachly.instanceId at the user/global scope. */
  global: string;
  /** Folder-scoped setting (multi-root workspaces); only used when it differs from global. */
  folder?: string;
  /** Value read FRESH from the git-root `.vscode/settings.json` (source of truth). */
  fileId?: string;
  /** Cached gitRootInstanceMap value for this git root (fallback only). */
  cached?: string;
}

export type InstanceIdSource = 'folder' | 'file' | 'cache' | 'global' | 'none';

export interface InstanceIdResolution {
  id: string;
  source: InstanceIdSource;
}

/**
 * Resolve the effective Brain instance id from all candidate sources.
 *
 * Precedence (highest first):
 *   1. folder-scoped setting (multi-root) when it differs from global
 *   2. on-disk `.vscode/settings.json` in the git root  ← source of truth
 *   3. cached gitRootInstanceMap value  ← fallback only (file unreadable/missing)
 *   4. global setting
 *
 * The file beats the cache on purpose: a previous bug checked the cache FIRST
 * and never invalidated it, so editing `.vscode/settings.json` (e.g. fixing a
 * stale/foreign instance id) had no effect and the status bar stayed OFFLINE.
 */
export function resolveInstanceId(s: InstanceIdSources): InstanceIdResolution {
  if (s.folder && s.folder !== s.global) return { id: s.folder, source: 'folder' };
  if (s.fileId) return { id: s.fileId, source: 'file' };
  if (s.cached) return { id: s.cached, source: 'cache' };
  if (s.global) return { id: s.global, source: 'global' };
  return { id: '', source: 'none' };
}

export type BrainStatus =
  | 'healthy'
  | 'empty'
  | 'degraded'
  | 'unreachable'
  | 'setup_needed'
  | 'not_found';

/**
 * Map an instance-fetch HTTP status to a Brain health status.
 *
 * 401/403 → re-auth needed (key expired/revoked); 404 → the instance id points
 * at something this key can't see (stale/foreign id) — a distinct, actionable
 * state, NOT a generic network "unreachable". Everything else → unreachable.
 */
export function classifyInstanceError(status: number): BrainStatus {
  if (status === 401 || status === 403) return 'setup_needed';
  if (status === 404) return 'not_found';
  return 'unreachable';
}

/** Validate the Cachly API key format (cky_live_… / cky_trial_… / cky_test_…). */
export function isValidApiKey(key: string | undefined | null): boolean {
  return /^cky_(live|trial|test)_[A-Za-z0-9]+$/.test((key ?? '').trim());
}

/** Validate a Brain instance id (UUID v4-ish; accepts any hex UUID shape). */
export function isValidInstanceId(id: string | undefined | null): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((id ?? '').trim());
}

/** Build the canonical instance URL — used by health checks and the Brain Doctor. */
export function instanceUrl(baseUrl: string, instanceId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/v1/instances/${instanceId}`;
}

/**
 * Build the `.git/hooks/post-commit` CLS (Continuous Learning Stream) script.
 *
 * Robustness — the previous inline version interpolated the commit message into
 * a `node -e "... message:'$MSG' ..."` JS string, so any message with an
 * apostrophe ("don't") produced invalid JS and the hook silently ingested
 * nothing (and was injectable). This version:
 *   • passes message/sha/files to node via ENVIRONMENT VARIABLES (no JS-source
 *     interpolation → no quoting/injection breakage), and
 *   • hands the JSON to the CLI via execFileSync (no shell re-parsing).
 *   • embeds CACHLY_JWT only when provided so `cls-ingest` can authenticate.
 *
 * Kept in sync with sdk/mcp/src/cls-hook.ts.
 */
export const CLS_HOOK_VERSION = 'v2';

export function buildClsPostCommitHook(instanceId: string, apiKey?: string): string {
  const nodeProgram =
    "try{" +
    "var p={instance_id:process.env.CACHLY_BRAIN_INSTANCE_ID,source:'git_commit'," +
    "payload:{message:process.env.CLS_MSG||'',sha:process.env.CLS_SHA||''," +
    "files:(process.env.CLS_FILES||'').split(',').filter(Boolean)}};" +
    "require('child_process').execFileSync('npx',['@cachly-dev/mcp-server@latest','cls-ingest',JSON.stringify(p)]," +
    "{stdio:'ignore',timeout:8000});" +
    "}catch(e){}";
  return [
    `#!/bin/sh`,
    `# cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION} (installed by Cachly VS Code extension)`,
    `# Runs silently on every commit to keep your brain up to date.`,
    `export CACHLY_BRAIN_INSTANCE_ID="${instanceId}"`,
    ...(apiKey ? [`export CACHLY_JWT="${apiKey}"`] : []),
    `CLS_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `CLS_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | cut -c1-200)`,
    `CLS_FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')`,
    `export CLS_SHA CLS_MSG CLS_FILES`,
    `node -e "${nodeProgram}" 2>/dev/null &`,
    `exit 0`,
  ].join('\n');
}

/**
 * Parse JSONC (JSON with Comments) — the format VS Code uses for settings.json.
 *
 * Plain `JSON.parse` THROWS on `//` / `/* *​/` comments and trailing commas,
 * which previously made the extension fall back to a stale cached instance id
 * (→ 404 on every recall, "Brain: OFFLINE") and could even wipe the user's
 * settings.json on setup. This strips comments and trailing commas that are
 * OUTSIDE string literals, then hands the result to JSON.parse.
 */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') { inStr = false; }
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1'); // drop trailing commas
  return JSON.parse(out) as Record<string, unknown>;
}
