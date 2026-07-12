import { getPool } from '@edge-desk/db';
import {
  HermesTelegramClient,
  TelegramDeliveryError,
  type TelegramSender,
} from '@edge-desk/integrations';
import type pg from 'pg';

export interface AlertSenderWorkerOptions {
  pool?: pg.Pool;
  sender?: TelegramSender;
  pollIntervalMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  signal?: AbortSignal;
  logger?: Pick<Console, 'info' | 'error'>;
}

export interface AlertDeliveryJob {
  outboxId: string;
  alertId: string;
  traceId: string;
  destination: string;
  idempotencyKey: string;
  message: string;
  attemptCount: number;
}

export type AlertDeliveryResult =
  | { status: 'idle' }
  | { status: 'sent'; job: AlertDeliveryJob; providerMessageId: string; duplicate: boolean }
  | { status: 'retry_scheduled'; job: AlertDeliveryJob; retryAt: Date; error: string }
  | { status: 'failed'; job: AlertDeliveryJob; error: string };

/**
 * Polls the transactional outbox and sends approved cards through Hermes' Telegram
 * direct-delivery webhook. The matcher remains responsible for creating alerts/outbox rows.
 */
export async function runAlertSenderWorker(options: AlertSenderWorkerOptions = {}): Promise<void> {
  const pool = options.pool ?? getPool();
  const sender = options.sender ?? HermesTelegramClient.fromEnv();
  const pollIntervalMs =
    options.pollIntervalMs ?? envPositiveInteger('ALERT_SENDER_POLL_INTERVAL_MS', 1_000);
  const logger = options.logger ?? console;

  logger.info('Telegram alert sender worker started');
  while (!options.signal?.aborted) {
    const result = await processNextAlert(pool, sender, options);
    if (result.status === 'idle') {
      await abortableDelay(pollIntervalMs, options.signal);
      continue;
    }
    if (result.status === 'sent') {
      logger.info(
        `Telegram alert ${result.job.alertId} sent via Hermes (${result.providerMessageId}${result.duplicate ? ', duplicate acknowledged' : ''})`,
      );
    } else if (result.status === 'retry_scheduled') {
      logger.error(
        `Telegram alert ${result.job.alertId} retry scheduled for ${result.retryAt.toISOString()}: ${result.error}`,
      );
    } else {
      logger.error(`Telegram alert ${result.job.alertId} failed permanently: ${result.error}`);
    }
  }
  logger.info('Telegram alert sender worker stopped');
}

export async function processNextAlert(
  pool: pg.Pool,
  sender: TelegramSender,
  options: Pick<
    AlertSenderWorkerOptions,
    'maxAttempts' | 'retryBaseMs' | 'retryMaxMs'
  > = {},
): Promise<AlertDeliveryResult> {
  const job = await claimNextTelegramAlert(pool);
  if (!job) return { status: 'idle' };

  try {
    const delivery = await sender.sendAlertCard({
      destination: job.destination,
      message: job.message,
      idempotencyKey: job.idempotencyKey,
      alertId: job.alertId,
      traceId: job.traceId,
    });
    await persistDelivered(pool, job, delivery.providerMessageId);
    return {
      status: 'sent',
      job,
      providerMessageId: delivery.providerMessageId,
      duplicate: delivery.duplicate,
    };
  } catch (error) {
    const message = errorMessage(error).slice(0, 4_000);
    const retryable = error instanceof TelegramDeliveryError ? error.retryable : true;
    const maxAttempts = options.maxAttempts ?? envPositiveInteger('TELEGRAM_MAX_ATTEMPTS', 5);

    if (!retryable || job.attemptCount >= maxAttempts) {
      await persistPermanentFailure(pool, job, message);
      return { status: 'failed', job, error: message };
    }

    const retryAt = new Date(
      Date.now() +
        computeBackoffMs(
          job.attemptCount,
          options.retryBaseMs ?? envPositiveInteger('TELEGRAM_RETRY_BASE_MS', 1_000),
          options.retryMaxMs ?? envPositiveInteger('TELEGRAM_RETRY_MAX_MS', 60_000),
        ),
    );
    await persistRetry(pool, job, retryAt, message);
    return { status: 'retry_scheduled', job, retryAt, error: message };
  }
}

export async function claimNextTelegramAlert(pool: pg.Pool): Promise<AlertDeliveryJob | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query<AlertJobRow>(
      `select o.id::text as outbox_id,
              o.alert_id::text,
              a.run_id::text as trace_id,
              o.destination,
              o.idempotency_key,
              o.attempt_count,
              a.message
         from delivery_outbox o
         join alerts a on a.id = o.alert_id
        where o.channel = 'telegram'
          and o.status = 'pending'
          and o.next_attempt_at <= now()
        order by o.next_attempt_at, o.created_at, o.id
        for update of o skip locked
        limit 1`,
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('commit');
      return undefined;
    }

    const updated = await client.query<{ attempt_count: number }>(
      `update delivery_outbox
          set status = 'sending', attempt_count = attempt_count + 1, last_error = null
        where id = $1
        returning attempt_count`,
      [row.outbox_id],
    );
    await client.query(`update alerts set status = 'sending' where id = $1`, [row.alert_id]);
    await client.query('commit');

    return {
      outboxId: row.outbox_id,
      alertId: row.alert_id,
      traceId: row.trace_id,
      destination: row.destination,
      idempotencyKey: row.idempotency_key,
      message: row.message,
      attemptCount: updated.rows[0]?.attempt_count ?? row.attempt_count + 1,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function persistDelivered(
  pool: pg.Pool,
  job: AlertDeliveryJob,
  providerMessageId: string,
): Promise<void> {
  const client = await pool.connect();
  const sentAt = new Date();
  try {
    await client.query('begin');
    const updated = await client.query(
      `update delivery_outbox
          set status = 'sent', provider_message_id = $2, sent_at = $3, last_error = null
        where id = $1 and status = 'sending'`,
      [job.outboxId, providerMessageId, sentAt],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`delivery outbox ${job.outboxId} is no longer in sending state`);
    }
    await client.query(
      `update alerts set status = 'sent', sent_at = $2 where id = $1`,
      [job.alertId, sentAt],
    );
    await client.query(
      `insert into outcome_jobs (alert_id, horizon_minutes, scheduled_for)
       select $1, horizon, $2::timestamptz + make_interval(mins => horizon)
         from unnest(array[10, 20, 40]) as horizon
       on conflict (alert_id, horizon_minutes) do nothing`,
      [job.alertId, sentAt],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function persistRetry(
  pool: pg.Pool,
  job: AlertDeliveryJob,
  retryAt: Date,
  error: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update delivery_outbox
          set status = 'pending', next_attempt_at = $2, last_error = $3
        where id = $1 and status = 'sending'`,
      [job.outboxId, retryAt, error],
    );
    await client.query(`update alerts set status = 'pending' where id = $1`, [job.alertId]);
    await client.query('commit');
  } catch (persistError) {
    await client.query('rollback');
    throw persistError;
  } finally {
    client.release();
  }
}

async function persistPermanentFailure(
  pool: pg.Pool,
  job: AlertDeliveryJob,
  error: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update delivery_outbox
          set status = 'failed', last_error = $2
        where id = $1 and status = 'sending'`,
      [job.outboxId, error],
    );
    await client.query(`update alerts set status = 'failed' where id = $1`, [job.alertId]);
    await client.query('commit');
  } catch (persistError) {
    await client.query('rollback');
    throw persistError;
  } finally {
    client.release();
  }
}

export function computeBackoffMs(attempt: number, baseMs: number, maximumMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maximumMs, baseMs * 2 ** exponent);
}

interface AlertJobRow {
  outbox_id: string;
  alert_id: string;
  trace_id: string;
  destination: string;
  idempotency_key: string;
  attempt_count: number;
  message: string;
}

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
