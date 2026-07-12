import assert from 'node:assert/strict';
import test from 'node:test';
import { labelOutcome } from './outcomeTracker.js';

test('labelOutcome treats small moves as flat regardless of sign', () => {
  assert.equal(labelOutcome(0, 50), 'flat');
  assert.equal(labelOutcome(50, 50), 'flat');
  assert.equal(labelOutcome(-50, 50), 'flat');
});

test('labelOutcome is correct when the move exceeds the threshold in the predicted direction', () => {
  assert.equal(labelOutcome(51, 50), 'correct');
  assert.equal(labelOutcome(1000, 50), 'correct');
});

test('labelOutcome is wrong when the move exceeds the threshold against the predicted direction', () => {
  assert.equal(labelOutcome(-51, 50), 'wrong');
  assert.equal(labelOutcome(-1000, 50), 'wrong');
});
