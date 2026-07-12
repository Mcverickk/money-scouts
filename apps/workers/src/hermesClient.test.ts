import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesApiClient, HermesApiError } from './hermesClient.js';

test('HermesApiClient submits and polls a run with auth and stable identity headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const replies = [
    jsonResponse({ run_id: 'hermes-run-1', status: 'started' }),
    jsonResponse({ run_id: 'hermes-run-1', status: 'running' }),
    jsonResponse({
      run_id: 'hermes-run-1',
      status: 'completed',
      session_id: 'session-1',
      model: 'hermes-agent',
      output: '{"ok":true}',
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    }),
  ];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    return reply;
  };
  const client = new HermesApiClient({
    baseUrl: 'http://127.0.0.1:8642/v1/',
    apiKey: 'secret',
    pollIntervalMs: 1,
    fetch: fetchMock,
  });

  const result = await client.run({
    input: 'input',
    instructions: 'instructions',
    sessionId: 'session-1',
    sessionKey: 'edge-desk:market:market-1',
    idempotencyKey: 'edge-desk-orchestration:run-1',
  });

  assert.equal(result.runId, 'hermes-run-1');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'http://127.0.0.1:8642/v1/runs',
      'http://127.0.0.1:8642/v1/runs/hermes-run-1',
      'http://127.0.0.1:8642/v1/runs/hermes-run-1',
    ],
  );

  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer secret');
  assert.equal(headers.get('Idempotency-Key'), 'edge-desk-orchestration:run-1');
  assert.equal(headers.get('X-Hermes-Session-Key'), 'edge-desk:market:market-1');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    model: 'hermes-agent',
    input: 'input',
    instructions: 'instructions',
    session_id: 'session-1',
  });
});

test('HermesApiClient refuses runs waiting on an approval', async () => {
  const replies = [
    jsonResponse({ run_id: 'hermes-run-2', status: 'started' }),
    jsonResponse({ run_id: 'hermes-run-2', status: 'waiting_for_approval' }),
  ];
  const client = new HermesApiClient({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'secret',
    pollIntervalMs: 1,
    fetch: async () => replies.shift() ?? jsonResponse({}, 500),
  });

  await assert.rejects(
    () =>
      client.run({
        input: 'input',
        instructions: 'instructions',
        sessionId: 'session-2',
        sessionKey: 'market-2',
        idempotencyKey: 'run-2',
      }),
    (error: unknown) =>
      error instanceof HermesApiError && /does not auto-approve tool calls/.test(error.message),
  );
});

test('HermesApiClient validates Runs API capabilities', async () => {
  const client = new HermesApiClient({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'secret',
    fetch: async () =>
      jsonResponse({ features: { run_submission: true, run_status: true } }),
  });

  await client.assertReady();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
