import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Jede Einrichtung in den Tests (writeWorkspaceFiles) wuerde sonst einen echten
    // Start-Import starten (lib/startwissen.ts). Der fragt die Test-Gegenstelle bis zu
    // 90 s lang ab und schreibt Anfragen in die Protokolle spaeterer Tests (23.10.2026).
    // Die Tests des Start-Imports schalten ihn ausdruecklich ein (src/lib/startwissen.test.ts).
    env: { CACHLY_STARTWISSEN: '0' },
    // Untergrenze 1 Worker: Die Runner auf node-4 setzen seit 27.11.2026
    // VITEST_MAX_THREADS/FORKS=3 gegen Ueberlast. vitest 2.x nimmt als Untergrenze
    // sonst "Kerne minus 1" (11) und bricht mit "minThreads and maxThreads must
    // not conflict" ab, bevor ein Test laeuft.
    poolOptions: { threads: { minThreads: 1 }, forks: { minForks: 1 } },
  },
});
