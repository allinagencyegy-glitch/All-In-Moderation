import { TerminalError } from '../platform/errors.ts';
import type { LogLevel } from '../platform/logger.ts';

/**
 * Runtime configuration.
 *
 * Resolved once at start-up and validated eagerly: a misconfigured process must fail on boot, not
 * on the first customer message. Secrets are never read here — they are resolved by reference
 * through the `SecretResolver` port so that a config dump cannot leak them.
 */

export type OutboundMode = 'SIMULATE' | 'LIVE';

export interface RuntimeConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly role: 'web' | 'worker' | 'all';
  readonly logLevel: LogLevel;
  /**
   * Phase 0 is `SIMULATE`. `LIVE` is rejected at boot until the Meta transport exists and real
   * integration is explicitly authorised — a config flag must never be the only thing standing
   * between a test environment and a real customer's inbox.
   */
  readonly outboundMode: OutboundMode;
  readonly worker: {
    readonly leaseMs: number;
    readonly pollIntervalMs: number;
    readonly maxAttempts: number;
    /** How many worker loops one process runs. Each claims independently. */
    readonly concurrency: number;
    /**
     * How long a shutdown waits for in-flight work before aborting it and handing the lease back.
     * Longer than a typical job, shorter than an orchestrator's kill timeout — a shutdown that
     * outlives `SIGKILL` is not a graceful shutdown, it is a slow crash.
     */
    readonly shutdownGraceMs: number;
  };
  readonly scheduler: {
    /** The reaper's timer. Crash recovery nobody triggers is crash recovery that does not happen. */
    readonly reaperIntervalMs: number;
    readonly relayIntervalMs: number;
    readonly relayBatchSize: number;
  };
  readonly http: {
    readonly port: number;
    readonly host: string;
    /** Caps how long a client may take to send headers and then a whole request. */
    readonly headersTimeoutMs: number;
    readonly requestTimeoutMs: number;
    /** Grace for in-flight requests when shutting the listener down. */
    readonly shutdownGraceMs: number;
  };
  readonly health: {
    readonly inboundLagMs: number;
    readonly outboxLagMs: number;
    readonly deadLetterCeiling: number;
  };
  readonly llm: {
    readonly providerId: string;
    readonly reasonModel: string;
    readonly timeoutMs: number;
    readonly temperature: number;
    readonly maxOutputTokens: number;
  };
  readonly ingest: {
    readonly maxBodyBytes: number;
  };
}

const asInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TerminalError(
      'CONFIG_INVALID',
      `Expected a non-negative integer, received '${value}'`,
    );
  }
  return parsed;
};

/**
 * For values where zero is not a sane setting.
 *
 * A poll interval of 0 is a busy loop; a batch size of 0 is a relay that never relays. Both look
 * like configuration and behave like an outage, so they are rejected at boot rather than
 * discovered in production.
 */
const asPositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = asInt(value, fallback);
  if (parsed === 0) {
    throw new TerminalError('CONFIG_INVALID', `Expected a positive integer, received '0'`);
  }
  return parsed;
};

const asEnum = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TerminalError(
      'CONFIG_INVALID',
      `Expected one of ${allowed.join(', ')}, received '${value}'`,
    );
  }
  return value as T;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const outboundMode = asEnum(env['OUTBOUND_MODE'], ['SIMULATE', 'LIVE'] as const, 'SIMULATE');
  if (outboundMode === 'LIVE') {
    throw new TerminalError(
      'OUTBOUND_LIVE_NOT_AUTHORIZED',
      'OUTBOUND_MODE=LIVE is refused: no provider transport exists and live sending is not authorised in this phase',
    );
  }

  return {
    nodeEnv: asEnum(env['NODE_ENV'], ['development', 'test', 'production'] as const, 'development'),
    role: asEnum(env['APP_ROLE'], ['web', 'worker', 'all'] as const, 'all'),
    logLevel: asEnum(env['LOG_LEVEL'], ['debug', 'info', 'warn', 'error'] as const, 'info'),
    outboundMode,
    worker: {
      leaseMs: asInt(env['WORKER_LEASE_MS'], 60_000),
      pollIntervalMs: asInt(env['WORKER_POLL_INTERVAL_MS'], 1_000),
      maxAttempts: asInt(env['WORKER_MAX_ATTEMPTS'], 5),
      concurrency: asPositiveInt(env['WORKER_CONCURRENCY'], 2),
      shutdownGraceMs: asInt(env['WORKER_SHUTDOWN_GRACE_MS'], 15_000),
    },
    scheduler: {
      reaperIntervalMs: asPositiveInt(env['REAPER_INTERVAL_MS'], 10_000),
      relayIntervalMs: asPositiveInt(env['RELAY_INTERVAL_MS'], 5_000),
      relayBatchSize: asPositiveInt(env['RELAY_BATCH_SIZE'], 100),
    },
    http: {
      port: asInt(env['HTTP_PORT'], 8080),
      host: env['HTTP_HOST'] ?? '0.0.0.0',
      headersTimeoutMs: asPositiveInt(env['HTTP_HEADERS_TIMEOUT_MS'], 10_000),
      requestTimeoutMs: asPositiveInt(env['HTTP_REQUEST_TIMEOUT_MS'], 20_000),
      shutdownGraceMs: asInt(env['HTTP_SHUTDOWN_GRACE_MS'], 10_000),
    },
    health: {
      inboundLagMs: asInt(env['HEALTH_INBOUND_LAG_MS'], 300_000),
      outboxLagMs: asInt(env['HEALTH_OUTBOX_LAG_MS'], 300_000),
      deadLetterCeiling: asInt(env['HEALTH_DEAD_LETTER_CEILING'], 0),
    },
    llm: {
      providerId: env['LLM_PROVIDER'] ?? 'mock',
      reasonModel: env['LLM_REASON_MODEL'] ?? 'mock-model-1',
      timeoutMs: asInt(env['LLM_TIMEOUT_MS'], 20_000),
      temperature: Number(env['LLM_TEMPERATURE'] ?? '0.2'),
      maxOutputTokens: asInt(env['LLM_MAX_OUTPUT_TOKENS'], 1_024),
    },
    ingest: {
      maxBodyBytes: asInt(env['INGEST_MAX_BODY_BYTES'], 1_000_000),
    },
  };
}
