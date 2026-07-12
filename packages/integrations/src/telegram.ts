import { createHmac } from 'node:crypto';

export interface TelegramDeliveryRequest {
  destination: string;
  message: string;
  idempotencyKey: string;
  alertId?: string;
  traceId?: string;
}

export interface SendResult {
  providerMessageId: string;
  duplicate: boolean;
}

export interface TelegramSender {
  sendAlertCard(request: TelegramDeliveryRequest): Promise<SendResult>;
}

export interface HermesTelegramClientOptions {
  webhookUrl: string;
  webhookSecret: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface WebhookResponse {
  status?: unknown;
  delivery_id?: unknown;
  error?: unknown;
}

/**
 * Sends an already-approved alert through Hermes' webhook direct-delivery mode.
 * No second agent/LLM run occurs: Hermes authenticates, deduplicates, renders the
 * configured template, and uses its Telegram gateway adapter.
 */
export class HermesTelegramClient implements TelegramSender {
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: HermesTelegramClientOptions) {
    if (!options.webhookUrl.trim()) throw new Error('Hermes Telegram webhook URL is required');
    if (!options.webhookSecret.trim()) {
      throw new Error('Hermes Telegram webhook secret is required');
    }
    this.webhookUrl = options.webhookUrl;
    this.webhookSecret = options.webhookSecret;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HermesTelegramClient {
    return new HermesTelegramClient({
      webhookUrl: requiredEnv(env, 'HERMES_TELEGRAM_WEBHOOK_URL'),
      webhookSecret: requiredEnv(env, 'HERMES_TELEGRAM_WEBHOOK_SECRET'),
      requestTimeoutMs: positiveIntegerEnv(env, 'TELEGRAM_DELIVERY_TIMEOUT_MS') ?? 10_000,
    });
  }

  async sendAlertCard(request: TelegramDeliveryRequest): Promise<SendResult> {
    validateRequest(request);
    const body = JSON.stringify({
      message: request.message,
      destination: request.destination,
      alert_id: request.alertId,
      trace_id: request.traceId,
    });
    const timestamp = Math.floor(this.now() / 1_000).toString();
    const signature = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature-V2': signature,
          'X-Request-ID': request.idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
      const payload = await parseWebhookResponse(response);

      if (!response.ok) {
        throw new TelegramDeliveryError(
          `Hermes Telegram webhook returned ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
          payload,
        );
      }

      const status = typeof payload.status === 'string' ? payload.status : '';
      const deliveryId =
        typeof payload.delivery_id === 'string' && payload.delivery_id
          ? payload.delivery_id
          : request.idempotencyKey;
      if (status === 'delivered') {
        return { providerMessageId: deliveryId, duplicate: false };
      }
      if (status === 'duplicate') {
        return { providerMessageId: deliveryId, duplicate: true };
      }
      throw new TelegramDeliveryError(
        `Hermes Telegram webhook returned unexpected status ${status || 'unknown'}`,
        false,
        response.status,
        payload,
      );
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TelegramDeliveryError(
          `Hermes Telegram webhook timed out after ${this.requestTimeoutMs}ms`,
          true,
        );
      }
      throw new TelegramDeliveryError(
        `Hermes Telegram webhook failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TelegramDeliveryError';
  }
}

function validateRequest(request: TelegramDeliveryRequest): void {
  if (!request.destination.trim()) throw new Error('Telegram destination is required');
  if (!request.message.trim()) throw new Error('Telegram message is required');
  if (!request.idempotencyKey.trim()) throw new Error('Telegram idempotency key is required');
  if (request.idempotencyKey.length > 255) {
    throw new Error('Telegram idempotency key must be at most 255 characters');
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function parseWebhookResponse(response: Response): Promise<WebhookResponse> {
  const text = await response.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as WebhookResponse)
      : {};
  } catch {
    return { error: text.slice(0, 2_000) };
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
