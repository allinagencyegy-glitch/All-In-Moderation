import { AppError, TerminalError, TimeoutError, TransientError } from '../../platform/errors.ts';

/**
 * SQLSTATE translation.
 *
 * The retry decision for a database failure is made here, once, rather than at each call site.
 * Getting it wrong in either direction is expensive: retrying a constraint violation burns the
 * budget and delays the human who needs to look at it, while *not* retrying a deadlock turns a
 * routine lock interleaving into a dead-lettered conversation.
 *
 * Codes are listed by name because `40001` means nothing to the next reader.
 */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  exclusionViolation: '23P01',
  insufficientPrivilege: '42501',
  undefinedTable: '42P01',
  undefinedColumn: '42703',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
  adminShutdown: '57P01',
  crashShutdown: '57P02',
  cannotConnectNow: '57P03',
  connectionException: '08000',
  connectionDoesNotExist: '08003',
  connectionFailure: '08006',
  tooManyConnections: '53300',
  readOnlySqlTransaction: '25006',
  inFailedSqlTransaction: '25P02',
} as const;

/**
 * Failures that are worth another attempt, because the *same* statement can succeed unchanged.
 *
 * Deadlocks and serialization failures are the important entries: PostgreSQL resolves them by
 * shooting one transaction, and the correct response is to run it again — not to escalate to a
 * human who can do nothing about a lock ordering.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  PG_ERRORS.serializationFailure,
  PG_ERRORS.deadlockDetected,
  PG_ERRORS.lockNotAvailable,
  PG_ERRORS.adminShutdown,
  PG_ERRORS.crashShutdown,
  PG_ERRORS.cannotConnectNow,
  PG_ERRORS.connectionException,
  PG_ERRORS.connectionDoesNotExist,
  PG_ERRORS.connectionFailure,
  PG_ERRORS.tooManyConnections,
]);

export interface PostgresErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly detail?: string;
  readonly message?: string;
}

export function pgErrorShape(error: unknown): PostgresErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  // `AppError` also carries a string `code`, so a bare duck-type check would misread every domain
  // error raised inside a transaction as a driver error — turning a ConcurrencyConflictError
  // (retryable, meaningful) into a generic constraint violation (terminal, useless).
  if (error instanceof AppError) return null;
  const candidate = error as PostgresErrorShape;
  return typeof candidate.code === 'string' ? candidate : null;
}

export function pgErrorCode(error: unknown): string | null {
  return pgErrorShape(error)?.code ?? null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const shape = pgErrorShape(error);
  if (shape?.code !== PG_ERRORS.uniqueViolation) return false;
  return constraint === undefined || shape.constraint === constraint;
}

export function isTransientPgError(error: unknown): boolean {
  const code = pgErrorCode(error);
  if (code === null) {
    // Driver-level socket failures arrive without a SQLSTATE. They are the most retryable thing
    // there is, so recognise them by name rather than defaulting them to terminal.
    const message = error instanceof Error ? error.message : '';
    return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|Connection terminated|socket hang up/i.test(
      message,
    );
  }
  return TRANSIENT_CODES.has(code);
}

/**
 * Wraps a driver error in the platform hierarchy so the worker's existing retry policy applies
 * unchanged. Nothing about the message is reformatted away: the SQLSTATE and constraint name are
 * the two things an operator actually needs, so both are carried in the details.
 *
 * The statement text is deliberately *not* attached. Parameters routinely contain customer
 * message bodies, and an error log is the easiest place to leak them.
 */
export function translatePgError(error: unknown, operation: string): Error {
  // Domain errors travel through the adapter untouched. The adapter's job is to give database
  // failures a retryability; it has no business re-classifying a decision the domain already made.
  if (error instanceof AppError) return error;
  const shape = pgErrorShape(error);
  const code = shape?.code ?? null;
  const details: Record<string, string> = { operation };
  if (code) details['sqlstate'] = code;
  if (shape?.constraint) details['constraint'] = shape.constraint;
  if (shape?.table) details['table'] = shape.table;

  if (code === PG_ERRORS.queryCanceled) {
    return new TimeoutError(operation, 0);
  }
  if (code === PG_ERRORS.serializationFailure || code === PG_ERRORS.deadlockDetected) {
    // Retryable by definition: PostgreSQL aborted one side of a lock interleaving precisely so
    // that re-running it can succeed.
    return new TransientError(
      'DATABASE_CONCURRENCY_ABORT',
      `Database operation '${operation}' was aborted to break a concurrency conflict`,
      details,
      { cause: error },
    );
  }
  if (isTransientPgError(error)) {
    return new TransientError(
      'DATABASE_UNAVAILABLE',
      `Database operation '${operation}' failed transiently`,
      details,
      { cause: error },
    );
  }
  if (code === PG_ERRORS.insufficientPrivilege) {
    // Almost always a role/grant mistake rather than an attack, but it must never be retried and
    // must never be quiet: a runtime that cannot write is an outage.
    return new TerminalError(
      'DATABASE_PERMISSION_DENIED',
      `Database operation '${operation}' was refused by PostgreSQL privileges`,
      details,
      { cause: error },
    );
  }
  if (code !== null) {
    return new TerminalError(
      'DATABASE_CONSTRAINT_VIOLATION',
      `Database operation '${operation}' violated a constraint`,
      details,
      { cause: error },
    );
  }
  return error instanceof Error
    ? error
    : new TerminalError('DATABASE_ERROR', `Database operation '${operation}' failed`, details);
}
