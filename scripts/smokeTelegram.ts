import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { HermesTelegramClient } from '@edge-desk/integrations';

const destination = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
if (!destination) throw new Error('TELEGRAM_ALERT_CHAT_ID is not set');

const idempotencyKey = `edge-desk-smoke:${randomUUID()}`;
const message =
  process.env.TELEGRAM_SMOKE_MESSAGE?.trim() ||
  `Edge Desk deployment smoke test\n${new Date().toISOString()}`;

const result = await HermesTelegramClient.fromEnv().sendAlertCard({
  destination,
  message,
  idempotencyKey,
  traceId: idempotencyKey,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      destination,
      providerMessageId: result.providerMessageId,
      duplicate: result.duplicate,
    },
    null,
    2,
  ),
);
