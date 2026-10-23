import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Jede Einrichtung in den Tests (writeWorkspaceFiles) wuerde sonst einen echten
    // Start-Import starten (lib/startwissen.ts). Der fragt die Test-Gegenstelle bis zu
    // 90 s lang ab und schreibt Anfragen in die Protokolle spaeterer Tests (23.10.2026).
    // Die Tests des Start-Imports schalten ihn ausdruecklich ein (src/lib/startwissen.test.ts).
    env: { CACHLY_STARTWISSEN: '0' },
  },
});
