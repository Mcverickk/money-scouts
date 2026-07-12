import assert from 'node:assert/strict';
import test from 'node:test';
import { composeTelegramAlert } from './matcher.js';

test('composes a notification-only Telegram card from the deterministic decision context', () => {
  const message = composeTelegramAlert(
    {
      marketTitle: 'Will England win?',
      outcomeName: 'England',
      currentPrice: 0.54,
      signal: {
        category: 'sports',
        direction: 'yes_up',
        expectedMoveBps: 900,
        confidence: 0.78,
        summary: 'England scored in the 63rd minute and now leads 1-0.',
        evidenceIds: ['evidence-1'],
        riskFlags: [],
      },
      evidence: [{ id: 'evidence-1', title: 'Live match feed', url: 'https://example.com/match' }],
    },
    'buy_yes',
    { lagBps: 650 },
    'run-123',
  );

  assert.match(message, /Signal: BUY YES — England/);
  assert.match(message, /Confidence: 78%/);
  assert.match(message, /Current price: 54c/);
  assert.match(message, /Estimated remaining lag: 6\.5 pts/);
  assert.match(message, /Live match feed — https:\/\/example\.com\/match/);
  assert.match(message, /Trace: run-123/);
  assert.match(message, /Mode: notification only/);
});
