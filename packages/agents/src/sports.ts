// Sports specialist — the only specialist in MVP scope (docs/TECH_ARCHITECTURE.md §4.6).
// Interprets goals, cards, injuries, game state, and settlement rules; returns the
// normalized SpecialistSignal, never sends messages or trades.
//
// Runtime wiring lives in docs/HERMES_INTEGRATION.md: use Hermes `delegate_task` for the
// price/evidence fan-out (latency-sensitive), Kanban for post-alert lifecycle.

import type { EvidenceRecord, NormalizedEvent, SpecialistSignal } from '@edge-desk/contracts';

export async function interpretSportsEvent(
  _event: NormalizedEvent,
  _evidence: EvidenceRecord,
): Promise<SpecialistSignal> {
  throw new Error('not implemented: agents.interpretSportsEvent');
}
