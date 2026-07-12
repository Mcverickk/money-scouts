import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { HermesTelegramClient, TelegramDeliveryError } from './telegram.js';

test('signs a V2 Hermes webhook request and returns its delivery id', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const client = new HermesTelegramClient({
    webhookUrl: 'http://127.0.0.1:8644/webhooks/edge-desk-alert',
    webhookSecret: 'webhook-secret',
    now: () => 1_750_000_000_000,
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({
        status: 'delivered',
        route: 'edge-desk-alert',
        target: 'telegram',
        delivery_id: 'alert:123',
      });
    },
  });

  const result = await client.sendAlertCard({
    destination: '-1001234567890',
    message: 'EDGE DESK ALERT',
    idempotencyKey: 'alert:123',
    alertId: '123',
    traceId: 'run-1',
  });

  assert.deepEqual(result, { providerMessageId: 'alert:123', duplicate: false });
  assert.equal(capturedUrl, 'http://127.0.0.1:8644/webhooks/edge-desk-alert');
  const body = String(capturedInit?.body);
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('X-Webhook-Timestamp'), '1750000000');
  assert.equal(headers.get('X-Request-ID'), 'alert:123');
  assert.equal(
    headers.get('X-Webhook-Signature-V2'),
    createHmac('sha256', 'webhook-secret').update(`1750000000.${body}`).digest('hex'),
  );
  assert.deepEqual(JSON.parse(body), {
    message: 'EDGE DESK ALERT',
    destination: '-1001234567890',
    alert_id: '123',
    trace_id: 'run-1',
  });
});

test('treats a duplicate Hermes delivery as success', async () => {
  const client = new HermesTelegramClient({
    webhookUrl: 'http://127.0.0.1:8644/webhooks/edge-desk-alert',
    webhookSecret: 'secret',
    fetch: async () => jsonResponse({ status: 'duplicate', delivery_id: 'alert:duplicate' }),
  });

  const result = await client.sendAlertCard({
    destination: '1234',
    message: 'Alert',
    idempotencyKey: 'alert:duplicate',
  });

  assert.deepEqual(result, { providerMessageId: 'alert:duplicate', duplicate: true });
});

test('classifies gateway failures as retryable and authentication failures as permanent', async () => {
  const gatewayFailure = new HermesTelegramClient({
    webhookUrl: 'http://127.0.0.1:8644/webhooks/edge-desk-alert',
    webhookSecret: 'secret',
    fetch: async () => jsonResponse({ status: 'error' }, 502),
  });
  await assert.rejects(
    () =>
      gatewayFailure.sendAlertCard({
        destination: '1234',
        message: 'Alert',
        idempotencyKey: 'alert:retry',
      }),
    (error: unknown) => error instanceof TelegramDeliveryError && error.retryable,
  );

  const authFailure = new HermesTelegramClient({
    webhookUrl: 'http://127.0.0.1:8644/webhooks/edge-desk-alert',
    webhookSecret: 'wrong-secret',
    fetch: async () => jsonResponse({ status: 'error' }, 401),
  });
  await assert.rejects(
    () =>
      authFailure.sendAlertCard({
        destination: '1234',
        message: 'Alert',
        idempotencyKey: 'alert:permanent',
      }),
    (error: unknown) =>
      error instanceof TelegramDeliveryError && !error.retryable && error.status === 401,
  );
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
