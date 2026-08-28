import type {
  AccountId,
  ChannelConnectionId,
  MessageId,
  RawInboundEventId,
  TraceId,
} from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';

/**
 * The immutable inbound ledger (ADR-006).
 *
 * This is the only reconstructible truth in the system: everything downstream can, in principle,
 * be rebuilt by replaying these rows. Nothing about a stored event is ever mutated except its
 * lifecycle state and the ids it produced.
 */
export const RAW_EVENT_STATES = [
  'RECEIVED',
  'NORMALIZING',
  'NORMALIZED',
  'IGNORED',
  'REJECTED',
  'DEAD_LETTERED',
] as const;
export type RawEventState = (typeof RAW_EVENT_STATES)[number];

/**
 * What normalisation made of an event, recorded on the ledger row itself.
 *
 * Objective 7 asks that unsupported or unknown payload variants be durably recorded and
 * classified explicitly. The payload was always durable; what was missing was the *verdict*. A
 * raw event with `state: 'IGNORED'` tells an operator nothing about whether we ignored an echo, a
 * delivery receipt, or a message type nobody has taught the parser yet — and those need three
 * different people.
 *
 * Counts and classification names only. No text, no identifiers, no customer content: this
 * summary is read by dashboards and pasted into tickets.
 */
export interface NormalizationSummary {
  readonly parsedItems: number;
  readonly createdMessages: number;
  readonly duplicateItems: number;
  /** Items whose routing identity no connection on this row owns. Fail-closed, never actioned. */
  readonly unroutableItems: number;
  /** Items on a surface this connection has not enabled. */
  readonly surfaceDisabledItems: number;
  readonly byClassification: Readonly<Record<string, number>>;
  /** Envelope-level parse problems, capped. Structural complaints, never payload contents. */
  readonly issues: readonly string[];
}

export interface RawInboundEvent {
  readonly id: RawInboundEventId;
  readonly accountId: AccountId;
  readonly channelConnectionId: ChannelConnectionId;
  /** sha256 of the verbatim body; unique per connection (delivery-level dedupe). */
  readonly deliveryKey: string;
  readonly payload: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly signatureValid: boolean;
  readonly state: RawEventState;
  readonly receivedAt: Date;
  readonly normalizedAt: Date | null;
  readonly producedMessageIds: readonly MessageId[];
  readonly error: { readonly code: string; readonly message: string } | null;
  /** Null until normalisation runs. Never cleared afterwards. */
  readonly normalization: NormalizationSummary | null;
  readonly traceId: TraceId;
}

const TRANSITIONS: Readonly<Record<RawEventState, readonly RawEventState[]>> = {
  RECEIVED: ['NORMALIZING', 'REJECTED'],
  // NORMALIZING -> RECEIVED is the reaper path after a lease expiry (F-11).
  NORMALIZING: ['NORMALIZED', 'IGNORED', 'DEAD_LETTERED', 'RECEIVED'],
  NORMALIZED: [],
  IGNORED: [],
  REJECTED: [],
  DEAD_LETTERED: [],
};

export function isTerminalRawEventState(state: RawEventState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransitionRawEvent(from: RawEventState, to: RawEventState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Transitions throw rather than no-op. A silent no-op on an illegal transition is precisely the
 * "silent failure" this platform exists to eliminate — the row would sit in a state nobody
 * expects, and no alert would fire.
 */
export function transitionRawEvent(
  event: RawInboundEvent,
  to: RawEventState,
  patch: Partial<
    Pick<RawInboundEvent, 'normalizedAt' | 'producedMessageIds' | 'error' | 'normalization'>
  > = {},
): RawInboundEvent {
  if (!canTransitionRawEvent(event.state, to)) {
    throw new InvalidTransitionError('RawInboundEvent', event.state, to);
  }
  return { ...event, ...patch, state: to };
}
