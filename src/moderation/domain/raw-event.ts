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
  patch: Partial<Pick<RawInboundEvent, 'normalizedAt' | 'producedMessageIds' | 'error'>> = {},
): RawInboundEvent {
  if (!canTransitionRawEvent(event.state, to)) {
    throw new InvalidTransitionError('RawInboundEvent', event.state, to);
  }
  return { ...event, ...patch, state: to };
}
