// Deterministic core of the matcher (docs/TECH_ARCHITECTURE.md §4.7).
// Models may extract features and write explanations; this code owns the price math
// and the notify gates. Direction-signed so a downward signal is not scored with an
// upward-only lag formula.

import type { MatcherAction, SignalDirection, SpecialistSignal } from '@edge-desk/contracts';

export const SCORING_POLICY_VERSION = 'sports-v1';

export interface LagThresholds {
  minEvidenceConfidence: number;
  maxEvidenceAgeSeconds: number;
  maxSnapshotAgeSeconds: number;
  maxSpreadBps: number;
  minDepthUsd: number;
  minLagBps: number;
}

export interface LagInputs {
  signal: SpecialistSignal;
  /** Baseline yes-price observed BEFORE the event (0..1). */
  preEventPrice: number;
  preEventObservedAt: Date;
  /** Current yes-price observed AFTER the event (0..1). */
  currentPrice: number;
  currentObservedAt: Date;
  eventOccurredAt: Date;
  spreadBps: number;
  depthUsd: number;
  evidenceAgeSeconds: number;
  /** A matching alert already exists inside the cooldown window. */
  inCooldown: boolean;
  now?: Date;
}

export interface LagResult {
  action: MatcherAction;
  observedMoveBps: number;
  lagBps: number;
  /** Empty when action is 'notify'; otherwise every gate that failed. */
  failedGates: string[];
}

export function signalDirectionSign(direction: SignalDirection): 1 | -1 {
  return direction === 'yes_up' ? 1 : -1;
}

export function computeLagBps(
  preEventPrice: number,
  currentPrice: number,
  expectedMoveBps: number,
  direction: SignalDirection,
): { observedMoveBps: number; lagBps: number } {
  const observedMoveBps = Math.round((currentPrice - preEventPrice) * 10_000);
  const signedObservedMoveBps = observedMoveBps * signalDirectionSign(direction);
  return { observedMoveBps, lagBps: expectedMoveBps - signedObservedMoveBps };
}

export function evaluateLag(inputs: LagInputs, thresholds: LagThresholds): LagResult {
  const now = inputs.now ?? new Date();
  const { observedMoveBps, lagBps } = computeLagBps(
    inputs.preEventPrice,
    inputs.currentPrice,
    inputs.signal.expectedMoveBps,
    inputs.signal.direction,
  );

  const failedGates: string[] = [];
  const needsReview: string[] = [];

  // Ordering integrity: current price alone cannot establish lag (§4.4).
  if (inputs.preEventObservedAt >= inputs.eventOccurredAt) {
    needsReview.push('baseline_not_before_event');
  }
  if (inputs.currentObservedAt <= inputs.eventOccurredAt) {
    needsReview.push('current_snapshot_not_after_event');
  }

  if (inputs.signal.confidence < thresholds.minEvidenceConfidence) {
    failedGates.push('confidence_below_threshold');
  }
  if (inputs.evidenceAgeSeconds > thresholds.maxEvidenceAgeSeconds) {
    failedGates.push('evidence_stale');
  }
  const snapshotAgeSeconds = (now.getTime() - inputs.currentObservedAt.getTime()) / 1000;
  if (snapshotAgeSeconds > thresholds.maxSnapshotAgeSeconds) {
    failedGates.push('snapshot_stale');
  }
  if (inputs.spreadBps > thresholds.maxSpreadBps) {
    failedGates.push('spread_too_wide');
  }
  if (inputs.depthUsd < thresholds.minDepthUsd) {
    failedGates.push('depth_too_thin');
  }
  if (lagBps < thresholds.minLagBps) {
    failedGates.push('lag_below_minimum');
  }
  if (inputs.inCooldown) {
    failedGates.push('cooldown_active');
  }
  if (inputs.signal.riskFlags.length > 0) {
    failedGates.push(`risk_flags:${inputs.signal.riskFlags.join(',')}`);
  }

  const action: MatcherAction =
    needsReview.length > 0 ? 'needs_review' : failedGates.length > 0 ? 'ignore' : 'notify';

  return { action, observedMoveBps, lagBps, failedGates: [...needsReview, ...failedGates] };
}
