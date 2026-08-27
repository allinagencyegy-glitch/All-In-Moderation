/**
 * A minimal Result type.
 *
 * Used where failure is an *expected outcome* that the caller must handle (validation, policy
 * evaluation, optimistic-guard checks) rather than an exceptional condition. Exceptions remain
 * the mechanism for genuine faults; this type is for decisions.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}

/** Unwraps or throws. Only for call sites that have already proven the result is ok. */
export function unwrap<T, E>(r: Result<T, E>, message = 'Called unwrap on an error Result'): T {
  if (r.ok) return r.value;
  throw new Error(`${message}: ${JSON.stringify(r.error)}`);
}
