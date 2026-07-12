// Telegram delivery — goes through the Hermes messaging gateway, not the raw Bot API
// (docs/HERMES_INTEGRATION.md "Messaging gateway"). This module is the thin call surface
// the alert sender uses; delivery state/idempotency lives in delivery_outbox.

export interface SendResult {
  providerMessageId: string;
}

export async function sendAlertCard(_destination: string, _message: string): Promise<SendResult> {
  throw new Error('not implemented: telegram.sendAlertCard');
}
