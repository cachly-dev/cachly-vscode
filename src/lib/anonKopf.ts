/**
 * Kopfzeilen fuer POST-Aufrufe ohne Anmeldung (apiPostAnon). Ein Schluessel
 * reist nur im Kopf `Authorization`, nie im Rumpf oder in der Adresse. Ohne
 * Schluessel (leer oder nur Leerraum) entsteht kein Authorization-Kopf.
 */
export function anonKopf(
  payload: string,
  userAgent: string,
  key = '',
): Record<string, string | number> {
  const kopf: Record<string, string | number> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'User-Agent': userAgent,
  };
  const schluessel = key.trim();
  if (schluessel) kopf['Authorization'] = `Bearer ${schluessel}`;
  return kopf;
}
