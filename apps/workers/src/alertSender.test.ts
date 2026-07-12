import assert from 'node:assert/strict';
import test from 'node:test';
import { computeBackoffMs } from './alertSender.js';

test('Telegram retry backoff grows exponentially and respects the cap', () => {
  assert.equal(computeBackoffMs(1, 1_000, 60_000), 1_000);
  assert.equal(computeBackoffMs(2, 1_000, 60_000), 2_000);
  assert.equal(computeBackoffMs(5, 1_000, 60_000), 16_000);
  assert.equal(computeBackoffMs(20, 1_000, 60_000), 60_000);
});
