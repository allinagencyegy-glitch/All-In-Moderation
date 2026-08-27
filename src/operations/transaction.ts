/**
 * The transaction boundary port.
 *
 * This is the mechanism behind "persist first, process second" (ADR-006) and behind the
 * transactional outbox (ADR-009): the domain write, the job enqueue, and the outbox insert must
 * commit together or not at all. With a queue in a different store this guarantee is impossible,
 * which is the argument that decided ADR-004.
 *
 * Postgres implements it with BEGIN/COMMIT; the in-memory adapter implements it with a snapshot
 * and restore, so the *same* atomicity test runs against both.
 */
export interface TransactionRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** For call sites that genuinely have a single write and no coordination requirement. */
export const passthroughTransactionRunner: TransactionRunner = {
  run: (fn) => fn(),
};
