export interface HermesRunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface HermesRunResult {
  runId: string;
  sessionId?: string;
  model?: string;
  output: string;
  usage?: HermesRunUsage;
}

export interface SubmitHermesRun {
  input: string;
  instructions: string;
  sessionId: string;
  sessionKey: string;
  idempotencyKey: string;
}

export interface HermesClient {
  assertReady?(): Promise<void>;
  run(request: SubmitHermesRun): Promise<HermesRunResult>;
}

export interface HermesApiClientOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  pollIntervalMs?: number;
  runTimeoutMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

export class HermesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HermesApiError';
  }
}

/**
 * Authenticated client for Hermes Agent's stable API Server Runs API.
 *
 * The gateway owns models, tools, memory, and delegation. This worker only submits
 * a run, polls its durable status, and validates the final application payload.
 */
export class HermesApiClient implements HermesClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly pollIntervalMs: number;
  private readonly runTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HermesApiClientOptions) {
    if (!options.baseUrl.trim()) throw new Error('Hermes API base URL is required');
    if (!options.apiKey.trim()) throw new Error('Hermes API key is required');

    this.baseUrl = options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'hermes-agent';
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.runTimeoutMs = options.runTimeoutMs ?? 45_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HermesApiClient {
    return new HermesApiClient({
      baseUrl: env.HERMES_API_URL ?? 'http://127.0.0.1:8642',
      apiKey: requiredEnv(env, 'HERMES_API_KEY'),
      model: env.HERMES_API_MODEL,
      pollIntervalMs: positiveIntegerEnv(env, 'HERMES_POLL_INTERVAL_MS'),
      runTimeoutMs: positiveIntegerEnv(env, 'HERMES_RUN_TIMEOUT_MS'),
      requestTimeoutMs: positiveIntegerEnv(env, 'HERMES_REQUEST_TIMEOUT_MS'),
    });
  }

  async assertReady(): Promise<void> {
    const capabilities = await this.request('/v1/capabilities', { method: 'GET' });
    const features = asObject(capabilities.features);
    if (features.run_submission !== true || features.run_status !== true) {
      throw new HermesApiError('Hermes API Server does not advertise the required Runs API');
    }
  }

  async run(request: SubmitHermesRun): Promise<HermesRunResult> {
    const submitted = await this.request('/v1/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': request.idempotencyKey,
        'X-Hermes-Session-Key': request.sessionKey,
      },
      body: JSON.stringify({
        model: this.model,
        input: request.input,
        instructions: request.instructions,
        session_id: request.sessionId,
      }),
    });

    const runId = requiredString(submitted, 'run_id');
    const deadline = Date.now() + this.runTimeoutMs;

    while (Date.now() < deadline) {
      const run = await this.request(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
      const status = requiredString(run, 'status');

      if (status === 'completed') {
        return {
          runId,
          sessionId: optionalString(run.session_id),
          model: optionalString(run.model),
          output: requiredString(run, 'output'),
          usage: parseUsage(run.usage),
        };
      }

      if (status === 'failed' || status === 'cancelled') {
        throw new HermesApiError(
          `Hermes run ${runId} ${status}: ${extractErrorMessage(run)}`,
          undefined,
          run,
        );
      }

      if (status === 'waiting_for_approval' || status === 'requires_approval') {
        throw new HermesApiError(
          `Hermes run ${runId} requires approval; the market pipeline does not auto-approve tool calls`,
          undefined,
          run,
        );
      }

      await delay(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    throw new HermesApiError(`Hermes run ${runId} timed out after ${this.runTimeoutMs}ms`);
  }

  private async request(path: string, init: RequestInit): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      });

      const body = await parseResponseBody(response);
      if (!response.ok) {
        throw new HermesApiError(
          `Hermes API ${init.method ?? 'GET'} ${path} returned ${response.status}`,
          response.status,
          body,
        );
      }
      return asObject(body);
    } catch (error) {
      if (error instanceof HermesApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HermesApiError(
          `Hermes API ${init.method ?? 'GET'} ${path} timed out after ${this.requestTimeoutMs}ms`,
        );
      }
      throw new HermesApiError(
        `Hermes API ${init.method ?? 'GET'} ${path} failed: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
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
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HermesApiError('Hermes API returned a non-object JSON payload', undefined, value);
  }
  return value as JsonObject;
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HermesApiError(`Hermes API response is missing string field ${key}`, undefined, object);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseUsage(value: unknown): HermesRunUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as JsonObject;
  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  const totalTokens = nonNegativeNumber(usage.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 2_000) };
  }
}

function extractErrorMessage(run: JsonObject): string {
  const direct = optionalString(run.error) ?? optionalString(run.message);
  if (direct) return direct;
  if (run.error && typeof run.error === 'object' && !Array.isArray(run.error)) {
    return optionalString((run.error as JsonObject).message) ?? 'unknown error';
  }
  return 'unknown error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
