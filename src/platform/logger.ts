/**
 * Structured logging with PII redaction built into the type, not left to discipline.
 *
 * Two rules this module makes hard to break:
 *   1. Every log line carries the tenant (ADR-002). A log you cannot attribute to an account is
 *      a log you cannot hand to that account during an incident.
 *   2. Customer content never reaches a log field by accident. Values are redacted by key name
 *      *and* the API offers no way to log a `Message` object wholesale.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger with additional bound fields (account_id, trace_id, job_id, ...). */
  child(fields: LogFields): Logger;
}

/**
 * Field names whose values are always redacted. Deliberately conservative: it is cheaper to
 * redact something harmless than to discover customer text in a log aggregator.
 */
const REDACTED_KEYS = new Set([
  'text',
  'body',
  'message_text',
  'content',
  'payload',
  'email',
  'phone',
  'phone_number',
  'address',
  'name',
  'display_name',
  'full_name',
  'token',
  'secret',
  'access_token',
  'app_secret',
  'signature',
  'authorization',
  'password',
  'credentials',
  'external_id',
  'psid',
]);

export const REDACTED = '[redacted]';

function redact(fields: LogFields): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      REDACTED_KEYS.has(key.toLowerCase()) && value !== undefined && value !== null
        ? REDACTED
        : value;
  }
  return out;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly time: string;
  readonly fields: Readonly<Record<string, LogValue>>;
}

export type LogSink = (record: LogRecord) => void;

export const jsonConsoleSink: LogSink = (record) => {
  const line = JSON.stringify({
    level: record.level,
    time: record.time,
    msg: record.message,
    ...record.fields,
  });
  if (record.level === 'error' || record.level === 'warn') console.error(line);
  else console.log(line);
};

export function createLogger(options: {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
  bound?: LogFields;
}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? jsonConsoleSink;
  const now = options.now ?? (() => new Date());
  const bound = options.bound ?? {};

  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    sink({
      level: recordLevel,
      message,
      time: now().toISOString(),
      fields: redact({ ...bound, ...(fields ?? {}) }),
    });
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) =>
      createLogger({
        ...(options.level !== undefined ? { level: options.level } : {}),
        ...(options.sink !== undefined ? { sink: options.sink } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        bound: { ...bound, ...fields },
      }),
  };
}

/** Captures records in memory. Used by tests to assert on what was (and was not) logged. */
export function createMemoryLogger(level: LogLevel = 'debug'): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createLogger({ level, sink: (r) => records.push(r) });
  return { logger, records };
}
