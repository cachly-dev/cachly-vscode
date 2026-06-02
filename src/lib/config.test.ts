import { describe, it, expect } from 'vitest';
import {
  DEFAULT_API_URL,
  normalizeBaseUrl,
  resolveInstanceId,
  classifyInstanceError,
  isValidApiKey,
  isValidInstanceId,
  instanceUrl,
  parseJsonc,
} from './config';

describe('normalizeBaseUrl', () => {
  it('returns the default when value is undefined/null', () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_API_URL);
    expect(normalizeBaseUrl(null)).toBe(DEFAULT_API_URL);
  });

  it('returns the default for empty / whitespace-only strings (the OFFLINE bug)', () => {
    expect(normalizeBaseUrl('')).toBe(DEFAULT_API_URL);
    expect(normalizeBaseUrl('   ')).toBe(DEFAULT_API_URL);
  });

  it('strips trailing slashes so URL concatenation never doubles them', () => {
    expect(normalizeBaseUrl('https://api.cachly.dev/')).toBe('https://api.cachly.dev');
    expect(normalizeBaseUrl('https://api.cachly.dev///')).toBe('https://api.cachly.dev');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  https://self.host  ')).toBe('https://self.host');
  });

  it('honors a custom fallback', () => {
    expect(normalizeBaseUrl('', 'https://fallback.test')).toBe('https://fallback.test');
  });
});

describe('resolveInstanceId', () => {
  it('prefers a folder setting that differs from global', () => {
    expect(resolveInstanceId({ global: 'g', folder: 'f', fileId: 'x', cached: 'c' }))
      .toEqual({ id: 'f', source: 'folder' });
  });

  it('ignores a folder setting equal to global and falls through to the file', () => {
    expect(resolveInstanceId({ global: 'g', folder: 'g', fileId: 'file-id' }))
      .toEqual({ id: 'file-id', source: 'file' });
  });

  it('prefers the on-disk file over the cache (the stale-cache bug)', () => {
    expect(resolveInstanceId({ global: '', fileId: 'fresh', cached: 'stale' }))
      .toEqual({ id: 'fresh', source: 'file' });
  });

  it('falls back to cache only when the file is unavailable', () => {
    expect(resolveInstanceId({ global: '', cached: 'cached-id' }))
      .toEqual({ id: 'cached-id', source: 'cache' });
  });

  it('falls back to global when nothing else is present', () => {
    expect(resolveInstanceId({ global: 'global-id' }))
      .toEqual({ id: 'global-id', source: 'global' });
  });

  it('reports none when no source has a value', () => {
    expect(resolveInstanceId({ global: '' })).toEqual({ id: '', source: 'none' });
  });
});

describe('classifyInstanceError', () => {
  it('maps 401/403 to setup_needed', () => {
    expect(classifyInstanceError(401)).toBe('setup_needed');
    expect(classifyInstanceError(403)).toBe('setup_needed');
  });
  it('maps 404 to not_found (stale/foreign id)', () => {
    expect(classifyInstanceError(404)).toBe('not_found');
  });
  it('maps everything else to unreachable', () => {
    expect(classifyInstanceError(500)).toBe('unreachable');
    expect(classifyInstanceError(0)).toBe('unreachable');
    expect(classifyInstanceError(502)).toBe('unreachable');
  });
});

describe('isValidApiKey', () => {
  it('accepts live/trial/test keys', () => {
    expect(isValidApiKey('cky_live_347504dfda26396f2283099011666f3c')).toBe(true);
    expect(isValidApiKey('cky_trial_abc123')).toBe(true);
    expect(isValidApiKey('cky_test_XYZ789')).toBe(true);
  });
  it('rejects malformed keys', () => {
    expect(isValidApiKey('')).toBe(false);
    expect(isValidApiKey('cky_live_')).toBe(false);
    expect(isValidApiKey('sk_live_abc')).toBe(false);
    expect(isValidApiKey('cky_prod_abc')).toBe(false);
    expect(isValidApiKey(undefined)).toBe(false);
  });
  it('trims whitespace before validating', () => {
    expect(isValidApiKey('  cky_live_abc  ')).toBe(true);
  });
});

describe('isValidInstanceId', () => {
  it('accepts a UUID', () => {
    expect(isValidInstanceId('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0')).toBe(true);
  });
  it('rejects non-UUIDs', () => {
    expect(isValidInstanceId('not-a-uuid')).toBe(false);
    expect(isValidInstanceId('')).toBe(false);
    expect(isValidInstanceId(undefined)).toBe(false);
  });
});

describe('instanceUrl', () => {
  it('builds the canonical instance endpoint and normalizes the base', () => {
    expect(instanceUrl('https://api.cachly.dev/', 'abc'))
      .toBe('https://api.cachly.dev/api/v1/instances/abc');
  });
});

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('strips // line comments (the settings.json OFFLINE bug)', () => {
    const text = `{
      // YAML schema associations
      "cachly.instanceId": "8e03addd-a2d9-406e-bcbb-d6d8c938a3d0"
    }`;
    expect(parseJsonc(text)['cachly.instanceId']).toBe('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0');
  });

  it('strips /* block comments */', () => {
    expect(parseJsonc('{ /* c */ "a": 1 }')).toEqual({ a: 1 });
  });

  it('removes trailing commas before } and ]', () => {
    expect(parseJsonc('{"a":1,"list":[1,2,],}')).toEqual({ a: 1, list: [1, 2] });
  });

  it('does NOT strip // or /* inside string values', () => {
    const text = '{"url":"https://api.cachly.dev","glob":"a/*.ts"}';
    expect(parseJsonc(text)).toEqual({ url: 'https://api.cachly.dev', glob: 'a/*.ts' });
  });

  it('preserves all keys when comments are interleaved', () => {
    const text = `{
      "cachly.apiKey": "cky_live_abc", // key
      "cachly.instanceId": "id", /* id */
      "chat.tools": { "x": true }, // trailing
    }`;
    const p = parseJsonc(text);
    expect(Object.keys(p)).toHaveLength(3);
    expect(p['cachly.instanceId']).toBe('id');
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJsonc('{"q":"a \\" b // not a comment"}')).toEqual({ q: 'a " b // not a comment' });
  });
});

