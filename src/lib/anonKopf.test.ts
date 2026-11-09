import { describe, it, expect } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { anonKopf } from './anonKopf';

describe('anonKopf: der Schluessel reist nur im Kopf', () => {
  it('mit Schluessel: Authorization steht im Kopf', () => {
    const kopf = anonKopf('{}', 'ua', 'cky_live_abc');
    expect(kopf['Authorization']).toBe('Bearer cky_live_abc');
  });

  it('ohne Schluessel (leer, Leerraum, weggelassen): kein Authorization-Kopf', () => {
    for (const k of ['', '   ', undefined]) {
      expect(Object.keys(anonKopf('{}', 'ua', k)).map((n) => n.toLowerCase())).not.toContain('authorization');
    }
  });

  it('der Schluessel steht in keinem anderen Kopf', () => {
    const kopf = anonKopf('{"event":"x"}', 'ua', 'cky_live_abc');
    const rest = Object.entries(kopf).filter(([n]) => n !== 'Authorization');
    expect(JSON.stringify(rest)).not.toContain('cky_live_abc');
  });

  it('auf dem Netz: Rumpf ohne api_key, Kopf mit Schluessel; ohne Schluessel kein Kopf', async () => {
    const eingang: { kopf: http.IncomingHttpHeaders; rumpf: string }[] = [];
    const server = http.createServer((req, res) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        eingang.push({ kopf: req.headers, rumpf: d });
        res.end('{}');
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    const senden = (key: string) =>
      new Promise<void>((ok, fehler) => {
        const payload = JSON.stringify({ event: 'e', instance_id: 'i' });
        const req = http.request(
          `http://127.0.0.1:${port}/api/v1/telemetry/mcp`,
          { method: 'POST', headers: anonKopf(payload, 'ua', key) },
          (res) => { res.resume(); res.on('end', ok); },
        );
        req.on('error', fehler);
        req.end(payload);
      });
    try {
      await senden('cky_live_geheim');
      await senden('');
    } finally {
      server.close();
    }
    expect(eingang[0].kopf['authorization']).toBe('Bearer cky_live_geheim');
    expect(eingang[0].rumpf).not.toContain('api_key');
    expect(eingang[0].rumpf).not.toContain('cky_live_geheim');
    expect(eingang[1].kopf['authorization']).toBeUndefined();
    expect(eingang[1].rumpf).not.toContain('api_key');
  });
});
