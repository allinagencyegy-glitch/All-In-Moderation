/**
 * Identifier primitives.
 *
 * Two properties matter here:
 *  - Ids are *branded* so that an `AccountId` can never be passed where a `ConversationId` is
 *    expected. Tenant safety (ADR-002) leans on the type system, and untyped string ids are the
 *    hole through which that leaks.
 *  - Ids are *time-sortable* (ULID). Insert locality matters for the ledger and the job table,
 *    and a sortable id is a cheap tiebreaker for stable ordering.
 */

declare const brandSymbol: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type AccountId = Brand<string, 'AccountId'>;
export type UserId = Brand<string, 'UserId'>;
export type ChannelConnectionId = Brand<string, 'ChannelConnectionId'>;
export type ChannelIdentityId = Brand<string, 'ChannelIdentityId'>;
export type ContactIdentityId = Brand<string, 'ContactIdentityId'>;
export type RawInboundEventId = Brand<string, 'RawInboundEventId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ModeratorRunId = Brand<string, 'ModeratorRunId'>;
export type OutboundActionId = Brand<string, 'OutboundActionId'>;
export type HandoffId = Brand<string, 'HandoffId'>;
export type LeadCandidateId = Brand<string, 'LeadCandidateId'>;
export type KnowledgeEntryId = Brand<string, 'KnowledgeEntryId'>;
export type KnowledgeGapId = Brand<string, 'KnowledgeGapId'>;
export type AccountPackVersionId = Brand<string, 'AccountPackVersionId'>;
export type JobId = Brand<string, 'JobId'>;
export type DeadLetterId = Brand<string, 'DeadLetterId'>;
export type DomainEventId = Brand<string, 'DomainEventId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type TraceId = Brand<string, 'TraceId'>;

/**
 * Casts a raw string into a branded id. This is the *only* sanctioned crossing point, so it is
 * easy to grep for. Adapters use it when hydrating rows; domain code should never need it.
 */
export function asId<T extends string>(value: string): T {
  return value as T;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
  let out = '';
  let remaining = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = remaining % 32;
    out = CROCKFORD[mod]! + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

/**
 * Generates identifiers. Injected rather than imported so that tests can be fully deterministic
 * — a run that cannot be reproduced byte-for-byte is a run that cannot be debugged.
 */
export interface IdFactory {
  next<T extends string>(prefix: string): T;
}

export function createUlidIdFactory(
  randomBytes: (n: number) => Uint8Array,
  nowMs: () => number,
): IdFactory {
  let lastTime = -1;
  let lastRandom: number[] = [];

  const nextRandom = (): number[] => {
    const bytes = randomBytes(RANDOM_LEN);
    return Array.from(bytes, (b) => b % 32);
  };

  // Monotonic within the same millisecond: increment the random part rather than emitting a
  // duplicate. Without this, two ids created in the same tick can sort arbitrarily.
  const bumpRandom = (chars: number[]): number[] => {
    const next = [...chars];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]! < 31) {
        next[i] = next[i]! + 1;
        return next;
      }
      next[i] = 0;
    }
    return nextRandom();
  };

  return {
    next<T extends string>(prefix: string): T {
      const time = nowMs();
      if (time === lastTime) {
        lastRandom = bumpRandom(lastRandom);
      } else {
        lastTime = time;
        lastRandom = nextRandom();
      }
      const random = lastRandom.map((v) => CROCKFORD[v]!).join('');
      return `${prefix}_${encodeTime(time)}${random}` as T;
    },
  };
}

/** Deterministic ids for tests: `cnv_0001`, `cnv_0002`, ... per prefix. */
export function createDeterministicIdFactory(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next<T extends string>(prefix: string): T {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(4, '0')}` as T;
    },
  };
}

export const ID_PREFIX = {
  account: 'acc',
  user: 'usr',
  channelConnection: 'chc',
  channelIdentity: 'chi',
  contactIdentity: 'cti',
  rawInboundEvent: 'rie',
  conversation: 'cnv',
  message: 'msg',
  moderatorRun: 'run',
  outboundAction: 'oba',
  handoff: 'hdf',
  leadCandidate: 'lcd',
  knowledgeEntry: 'kne',
  knowledgeGap: 'kng',
  accountPackVersion: 'apv',
  job: 'job',
  deadLetter: 'dlq',
  domainEvent: 'evt',
  auditEvent: 'aud',
  trace: 'trc',
} as const;
