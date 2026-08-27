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
