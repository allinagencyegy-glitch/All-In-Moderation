/**
 * Error taxonomy.
 *
 * The single most important property here is `retryability`. The job system decides whether to
 * retry, back off, or dead-letter based on the error class — not on string matching, and not on
 * a caller remembering to set a flag. An error whose retryability is unknown is treated as
 * TERMINAL, because retrying an unknown failure forever is how a queue turns into an outage.
 */

export type Retryability = 'RETRYABLE' | 'TERMINAL';

export interface ErrorContext {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export class AppError extends Error {
  readonly code: string;
  readonly retryability: Retryability;
  readonly context: ErrorContext;

  constructor(
    code: string,
    message: string,
    retryability: Retryability,
    context: ErrorContext = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.retryability = retryability;
    this.context = context;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryability: this.retryability,
      context: this.context,
    };
  }
}

/** A transient dependency failure: timeouts, 5xx, connection resets, lock contention. */
export class TransientError extends AppError {
  constructor(
    code: string,
    message: string,
    context?: ErrorContext,
    options?: { cause?: unknown },
  ) {
    super(code, message, 'RETRYABLE', context, options);
  }
}

/** A failure that will recur identically no matter how many times it is retried. */
export class TerminalError extends AppError {
  constructor(
    code: string,
    message: string,
    context?: ErrorContext,
    options?: { cause?: unknown },
  ) {
    super(code, message, 'TERMINAL', context, options);
  }
}

/** Input that violates a schema or contract. Never retryable. */
export class ValidationError extends TerminalError {
  readonly issues: readonly { path: string; message: string }[];
  constructor(message: string, issues: readonly { path: string; message: string }[] = []) {
    super('VALIDATION_FAILED', message, { issueCount: issues.length });
    this.issues = issues;
  }
}

/** An attempted state transition the domain forbids. Always a bug; never retryable. */
export class InvalidTransitionError extends TerminalError {
  constructor(entity: string, from: string, to: string, reason?: string) {
    super(
      'INVALID_TRANSITION',
      `${entity}: cannot transition ${from} -> ${to}${reason ? ` (${reason})` : ''}`,
      { entity, from, to },
    );
  }
}

/** A cross-tenant access attempt. Always terminal, always audited, always alerting. */
export class TenantViolationError extends TerminalError {
  constructor(expectedAccountId: string, actualAccountId: string, resource: string) {
    super('TENANT_VIOLATION', `Cross-tenant access to ${resource}`, {
      expectedAccountId,
      actualAccountId,
      resource,
    });
  }
}

/** An action the policy layer refused. Terminal by design: retrying a denial is meaningless. */
export class PolicyDeniedError extends TerminalError {
  constructor(action: string, reason: string) {
    super('POLICY_DENIED', `Action ${action} denied: ${reason}`, { action, reason });
  }
}

/**
 * A compare-and-swap that lost.
 *
 * Someone else advanced the row between the read and the write. Retryable by design: the caller
 * re-reads and decides again, which is the only safe answer to a lost update. Never swallow it —
 * a silently discarded conflict is how a human takeover gets overwritten by the AI.
 */
export class ConcurrencyConflictError extends TransientError {
  constructor(resource: string, expectedVersion: number) {
    super(
      'CONCURRENCY_CONFLICT',
      `${resource} changed concurrently; expected version ${String(expectedVersion)}`,
      { resource, expectedVersion },
    );
  }
}

/** A dependency call that exceeded its deadline. Outcome is *unknown*, not failed. */
export class TimeoutError extends TransientError {
  constructor(operation: string, timeoutMs: number) {
    super('TIMEOUT', `${operation} exceeded ${timeoutMs}ms`, { operation, timeoutMs });
  }
}

/** A capability deliberately not built yet. Fails loudly rather than silently doing nothing. */
export class NotImplementedError extends TerminalError {
  constructor(what: string, plannedPhase?: string) {
    super(
      'NOT_IMPLEMENTED',
      `${what} is not implemented${plannedPhase ? ` (planned: ${plannedPhase})` : ''}`,
      { what },
    );
  }
}

/**
 * Classifies any thrown value. Unknown errors are TERMINAL on purpose: an unrecognised failure
 * retried without bound is worse than one that dead-letters and asks a human to look.
 */
export function retryabilityOf(error: unknown): Retryability {
  if (error instanceof AppError) return error.retryability;
  return 'TERMINAL';
}

export function describeError(error: unknown): { code: string; message: string; name: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, name: error.name };
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message, name: error.name };
  }
  return { code: 'UNKNOWN', message: String(error), name: 'NonError' };
}
