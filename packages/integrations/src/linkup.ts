// Linkup adapter — fresh evidence discovery shared by all domain specialists.
// Every cited fact keeps source URL, publishedAt, and retrievedAt (docs/TECH_ARCHITECTURE.md §4.5).
// Auth: LINKUP_API_KEY.

import type { EvidenceRecord } from '@edge-desk/contracts';

export async function fetchFreshEvidence(
  _query: string,
  _opts?: { maxAgeSeconds?: number },
): Promise<EvidenceRecord> {
  throw new Error('not implemented: linkup.fetchFreshEvidence');
}
