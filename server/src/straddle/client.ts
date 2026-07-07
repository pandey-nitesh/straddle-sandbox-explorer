import { SANDBOX_BASE_URL } from "../config.js";
import type { EventBus } from "../engine/bus.js";
import { RealClock } from "../engine/runner.js";
import { createRedactor, type Redactor } from "../redaction.js";
import { StraddleApiError } from "./errors.js";
import type {
  ChargeInput,
  ChargeResult,
  Clock,
  CustomerInput,
  CustomerResult,
  CustomerReviewResult,
  HealthResult,
  PaykeyInput,
  PaykeyResult,
  StraddleClient,
} from "./types.js";

export interface StraddleClientContext {
  run_id: string;
  scenario_id: "a" | "b" | "c" | "d" | "e";
}

export interface CreateStraddleClientOptions {
  apiKey: string;
  bus: EventBus;
  context: StraddleClientContext;
  baseUrl?: string;
  clock?: Clock;
  redactor?: Redactor;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

type JsonObject = Record<string, unknown>;

export function createStraddleClient(
  options: CreateStraddleClientOptions,
): StraddleClient {
  return new FetchStraddleClient(options);
}

class FetchStraddleClient implements StraddleClient {
  private readonly apiKey: string;
  private readonly bus: EventBus;
  private readonly context: StraddleClientContext;
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly redactor: Redactor;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;

  constructor(options: CreateStraddleClientOptions) {
    this.apiKey = options.apiKey;
    this.bus = options.bus;
    this.context = options.context;
    this.baseUrl = options.baseUrl ?? SANDBOX_BASE_URL;
    this.clock = options.clock ?? new RealClock();
    this.redactor = options.redactor ?? createRedactor({ apiKey: options.apiKey });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async health(): Promise<HealthResult> {
    try {
      await this.request<JsonObject>("GET", "/v1/customers", undefined, {
        retry: false,
      });
      return { ok: true, status: 200 };
    } catch (error) {
      if (error instanceof StraddleApiError) {
        return { ok: false, status: error.status, message: error.message };
      }
      return { ok: false, status: 0, message: String(error) };
    }
  }

  async createCustomer(input: CustomerInput): Promise<CustomerResult> {
    const envelope = await this.request<JsonObject>(
      "POST",
      "/v1/customers",
      bodyWithoutIdempotency(input),
      { idempotencyKey: input.idempotencyKey },
    );
    return dataOf(envelope) as unknown as CustomerResult;
  }

  async getCustomerReview(customerId: string): Promise<CustomerReviewResult> {
    const envelope = await this.request<JsonObject>(
      "GET",
      `/v1/customers/${customerId}/review`,
    );
    const data = dataOf(envelope);
    const customer = asRecord(data.customer_details);
    const identity = asRecord(data.identity_details);
    const breakdown = asRecord(identity.breakdown);
    const fraud = asRecord(breakdown.fraud);
    const reputation = asRecord(identity.reputation);
    const email = asRecord(breakdown.email);
    const phone = asRecord(breakdown.phone);
    return {
      customer_id: customerId,
      status: String(customer.status),
      decision:
        typeof identity.decision === "string" ? identity.decision : undefined,
      summary: {
        verification_status: String(customer.status),
        ...(numberOrUndefined(fraud.risk_score) !== undefined
          ? { risk_score: numberOrUndefined(fraud.risk_score) }
          : numberOrUndefined(reputation.risk_score) !== undefined
            ? { risk_score: numberOrUndefined(reputation.risk_score) }
            : {}),
        ...(numberOrUndefined(email.correlation_score) !== undefined
          ? { correlation_score: numberOrUndefined(email.correlation_score) }
          : numberOrUndefined(phone.correlation_score) !== undefined
            ? { correlation_score: numberOrUndefined(phone.correlation_score) }
            : {}),
        reason_codes: collectReasonCodes(breakdown),
      },
    };
  }

  async createPaykey(input: PaykeyInput): Promise<PaykeyResult> {
    const envelope = await this.request<JsonObject>(
      "POST",
      "/v1/bridge/bank_account",
      bodyWithoutIdempotency(input),
      { idempotencyKey: input.idempotencyKey },
    );
    return dataOf(envelope) as unknown as PaykeyResult;
  }

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    const envelope = await this.request<JsonObject>(
      "POST",
      "/v1/charges",
      bodyWithoutIdempotency(input),
      { idempotencyKey: input.idempotencyKey },
    );
    return dataOf(envelope) as unknown as ChargeResult;
  }

  async getCharge(chargeId: string): Promise<ChargeResult> {
    const envelope = await this.request<JsonObject>("GET", `/v1/charges/${chargeId}`);
    return dataOf(envelope) as unknown as ChargeResult;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string; retry?: boolean } = {},
  ): Promise<T> {
    const maxAttempts = options.retry === false ? 1 : this.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = this.clock.now();
      let response: Response | undefined;
      let responseBody: unknown;
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
        };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (options.idempotencyKey !== undefined) {
          headers["Idempotency-Key"] = options.idempotencyKey;
        }
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        responseBody = await parseResponseBody(response);
        this.emitExchange({
          method,
          path,
          status: response.status,
          attempt,
          latencyMs: this.clock.now() - startedAt,
          requestBody: body,
          responseBody,
        });

        if (response.ok) return responseBody as T;

        const error = this.toError({
          status: response.status,
          path,
          body: responseBody,
          message: responseBody === undefined ? `${response.status} status code (no body)` : `Straddle ${response.status}`,
        });
        if (!error.retryable || attempt === maxAttempts) throw error;
        await this.retry(method, path, response.status, attempt + 1, response.headers);
      } catch (error) {
        if (error instanceof StraddleApiError) {
          throw error;
        }
        this.emitExchange({
          method,
          path,
          status: 0,
          attempt,
          latencyMs: this.clock.now() - startedAt,
          requestBody: body,
          responseBody: { error: String(error) },
        });
        if (attempt === maxAttempts) {
          throw new StraddleApiError({
            status: 0,
            errorBody: this.redactor.redactBody({ error: String(error) }),
            path,
            message: String(error),
            retryable: true,
            cause: error,
          });
        }
        await this.retry(method, path, undefined, attempt + 1);
      }
    }
    throw new Error("unreachable retry loop");
  }

  private async retry(
    method: string,
    path: string,
    status: number | undefined,
    attempt: number,
    headers?: Headers,
  ): Promise<void> {
    const delayMs = retryDelay(attempt, headers);
    this.bus.emit({
      type: "retry.scheduled",
      run_id: this.context.run_id,
      scenario_id: this.context.scenario_id,
      method,
      path,
      ...(status !== undefined ? { status } : { error_class: "FetchError" }),
      attempt,
      delay_ms: delayMs,
    });
    await this.clock.sleep(delayMs);
  }

  private emitExchange(args: {
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    attempt: number;
    requestBody?: unknown;
    responseBody?: unknown;
  }): void {
    const responseRecord = asRecord(args.responseBody);
    const meta = asRecord(responseRecord.meta);
    this.bus.emit({
      type: "api.exchange",
      run_id: this.context.run_id,
      scenario_id: this.context.scenario_id,
      method: args.method,
      path: args.path,
      status: args.status,
      latency_ms: Math.max(0, args.latencyMs),
      attempt: args.attempt,
      ...(args.requestBody !== undefined
        ? { request_body: this.redactor.redactBody(args.requestBody) }
        : {}),
      ...(args.responseBody !== undefined
        ? { response_body: this.redactor.redactBody(args.responseBody) }
        : {}),
      ...(typeof meta.api_request_id === "string"
        ? { api_request_id: meta.api_request_id }
        : {}),
    });
  }

  private toError(args: {
    status: number;
    path: string;
    body: unknown;
    message: string;
  }): StraddleApiError {
    const body = asRecord(args.body);
    const meta = asRecord(body.meta);
    return new StraddleApiError({
      status: args.status,
      errorBody: this.redactor.redactBody(args.body),
      path: args.path,
      message: args.message,
      requestId:
        typeof meta.api_request_id === "string" ? meta.api_request_id : undefined,
    });
  }
}

function bodyWithoutIdempotency<T extends { idempotencyKey?: string }>(
  input: T,
): Omit<T, "idempotencyKey"> {
  const { idempotencyKey: _idempotencyKey, ...body } = input;
  return body;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function dataOf(envelope: JsonObject): JsonObject {
  const data = envelope.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Straddle response did not contain an object data envelope");
  }
  return data as JsonObject;
}

function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function collectReasonCodes(breakdown: JsonObject): string[] {
  const codes = new Set<string>();
  for (const value of Object.values(breakdown)) {
    const section = asRecord(value);
    if (Array.isArray(section.codes)) {
      for (const code of section.codes) {
        if (typeof code === "string") codes.add(code);
      }
    }
  }
  return [...codes].sort();
}

function retryDelay(attempt: number, headers?: Headers): number {
  const retryAfterMs = headers?.get("retry-after-ms");
  if (retryAfterMs != null && /^\d+$/.test(retryAfterMs)) {
    return Number.parseInt(retryAfterMs, 10);
  }
  const retryAfter = headers?.get("retry-after");
  if (retryAfter != null && /^\d+$/.test(retryAfter)) {
    return Number.parseInt(retryAfter, 10) * 1000;
  }
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 2));
  return base + Math.floor(Math.random() * 250);
}
