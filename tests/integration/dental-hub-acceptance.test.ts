import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { asId } from '../../src/platform/ids.ts';
import type { UserId } from '../../src/platform/ids.ts';
import { LIVE_OUTBOUND_STATES } from '../../src/moderation/domain/outbound-action.ts';
import { loadKnowledgeFile, loadPackFile } from '../../src/runtime/admin/pack-authoring.ts';
import { traceRawEvent } from '../../src/runtime/admin/shadow-trace.ts';
import type { Harness, SeededAccount } from '../support/harness.ts';
import { createHarness, decisionJson, metaCommentEnvelope } from '../support/harness.ts';

/**
 * Phase 02C acceptance, on the real client artefacts.
 *
 *   Meta inbound-shaped event
 *     -> signature verified -> raw event persisted -> normalised
 *     -> moderator run -> retrieval against the published Dental Hub pack
 *     -> structured decision contract -> grounded draft
 *     -> human review -> APPROVED_FOR_MANUAL_SEND
 *     -> **zero outbound dispatch**.
 *
 * Every other suite exercises a synthetic pack. This one publishes the actual files an operator
 * will publish, from `knowledge/dental-hub/pack/`, so that "it works" means "it works on this
 * client's configuration" rather than "it works on a fixture we wrote to make it work".
 *
 * The model is still the mock — the real adapter is exercised in `tests/unit/anthropic-provider`
 * with an injected transport, because a suite that made paid calls would be both a cost and a
 * source of flakes. What is real here is the pack, the knowledge, the retrieval, the gate, the
 * review workflow, and the absence of a transport.
 */

const PACK_DIR = resolve(import.meta.dirname, '..', '..', 'knowledge', 'dental-hub', 'pack');
const PUBLISHER = asId<UserId>('usr_publisher');
const REVIEWER = asId<UserId>('usr_reviewer');

/** Seeds an account, then publishes the real pack and imports the real approved knowledge. */
async function onboard(): Promise<{ h: Harness; seeded: SeededAccount }> {
  const h = createHarness();
  const seeded = await h.seedAccount({ slug: 'client-a', withPack: false });
  // Arabic, because the customers write in Arabic and retrieval is locale-scoped.
  await h.container.accounts.save({
    ...seeded.account,
    defaultLocale: 'ar',
    timezone: 'Africa/Cairo',
  });

  const pack = loadPackFile(join(PACK_DIR, 'pack.json'), {
    accountId: seeded.account.id,
    version: 1,
    publishedBy: PUBLISHER,
    now: h.clock.now(),
  });
  await h.container.packs.save(seeded.scope, pack);

  const approved = loadKnowledgeFile(join(PACK_DIR, 'knowledge.approved.json'), {
    accountId: seeded.account.id,
    now: h.clock.now(),
    approve: { approver: PUBLISHER },
  });
  for (const entry of approved.entries) await h.container.knowledge.save(seeded.scope, entry);

  // The draft file is imported too, and imported as DRAFT — which is the point: it is tracked,
  // reviewable, and invisible to the model.
  const draft = loadKnowledgeFile(join(PACK_DIR, 'knowledge.draft.json'), {
    accountId: seeded.account.id,
    now: h.clock.now(),
  });
  for (const entry of draft.entries) await h.container.knowledge.save(seeded.scope, entry);

  return { h, seeded };
}

async function comment(h: Harness, seeded: SeededAccount, id: string, text: string): Promise<void> {
  await h.postWebhook(
    seeded,
    metaCommentEnvelope(seeded.connection.externalId, {
      commentId: `c_${id}`,
      postId: `p_${id}`,
      fromId: `u_${id}`,
      text,
    }),
  );
  await h.drain();
  h.clock.advanceMs(3_000);
  await h.drain();
}

/** The claim the whole phase makes, asserted from persisted state. */
function assertZeroDispatch(h: Harness): void {
  for (const action of h.container.db.tables.outbound.values()) {
    assert.notEqual(action.deliveryMode, 'AUTONOMOUS', `${action.id} was autonomous`);
    assert.ok(!LIVE_OUTBOUND_STATES.has(action.state), `${action.id} reached ${action.state}`);
    assert.equal(action.providerMessageId, null, `${action.id} has a provider message id`);
    assert.equal(action.deliveredAt, null, `${action.id} recorded a delivery`);
  }
}

describe('Phase 02C acceptance on the published client pack', () => {
  it('carries a Meta comment through to a reply a named person may send by hand', async () => {
    const { h, seeded } = await onboard();

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'CONTACT_REQUEST',
        action: 'PUBLIC_REPLY',
        replyText: 'تقدر تتواصل معانا على واتساب على 01111772865.',
        knowledgeRefs: ['kne_contact-whatsapp'],
        confidence: 0.88,
      }),
    });

    await comment(h, seeded, '1', 'ممكن رقم واتساب للتواصل؟');

    // 1. The delivery is on the ledger, verified, normalised.
    const rawEvents = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(rawEvents.length, 1);
    assert.equal(rawEvents[0]!.signatureValid, true);
    assert.equal(rawEvents[0]!.state, 'NORMALIZED');

    // 2. The moderator ran against the published pack.
    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id))[0]!;
    assert.equal(run.state, 'COMPLETED');
    assert.equal(run.decision?.policyOutcome, 'REQUIRES_APPROVAL');
    assert.equal(run.decision?.finalAction, 'PUBLIC_REPLY');
    assert.deepEqual(run.decision?.knowledgeRefsUsed, ['kne_contact-whatsapp']);

    // 3. Retrieval reached the Arabic entry from Arabic customer wording — asserted on what the
    //    model was actually shown, which is the only thing it could have grounded a reply in.
    const shown = h.provider.calls[0]!.request.turns.map((turn) => turn.content).join('\n');
    assert.ok(
      shown.includes('kne_contact-whatsapp'),
      'the approved contact entry must be retrievable from a contact question',
    );

    // 4. A draft is waiting for a person, with everything they need to judge it.
    const queue = await h.container.review.list(seeded.scope);
    assert.equal(queue.length, 1);
    const detail = await h.container.review.show(seeded.scope, queue[0]!.action.id);
    assert.equal(detail.action.deliveryMode, 'SUGGESTED');
    assert.equal(detail.action.state, 'SUPPRESSED');
    assert.equal(detail.action.payload.text, 'تقدر تتواصل معانا على واتساب على 01111772865.');
    assert.equal(detail.action.payload.review?.intentCode, 'CONTACT_REQUEST');
    assert.equal(detail.action.payload.review?.packVersionId, run.packVersionId);
    assert.equal(detail.citedKnowledge.length, 1);
    assert.deepEqual(detail.unresolvedCitations, []);
    assert.equal(detail.transcript[0]!.text, 'ممكن رقم واتساب للتواصل؟');

    // 5. A person approves it. Nothing is sent.
    const decided = await h.container.review.decide(seeded.scope, {
      actionId: queue[0]!.action.id,
      decision: 'APPROVED',
      reviewerUserId: REVIEWER,
    });
    assert.equal(decided.action.state, 'APPROVED_FOR_MANUAL_SEND');
    assert.equal(decided.textForManualSend, 'تقدر تتواصل معانا على واتساب على 01111772865.');
    assertZeroDispatch(h);

    // 6. Draining again does nothing: there is no dispatch job to run.
    assert.equal(await h.drain(), 0);
    assertZeroDispatch(h);

    // 7. And the shadow trace agrees, end to end, from persisted state alone.
    const trace = await traceRawEvent(h.container, seeded.scope, rawEvents[0]!.id);
    assert.deepEqual(trace!.failures, []);
    assert.equal(trace!.ok, true);
    assert.equal(trace!.receiveOnly, true);
    assert.equal(trace!.conversations[0]!.outboundActions[0]!.awaitingHuman, true);
  });

  it('refuses to answer the price question the audit found unanswered', async () => {
    const { h, seeded } = await onboard();

    // There is no approved price in this pack — deliberately, because the client never confirmed
    // one. The model tries anyway, citing the draft offer it was never shown.
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'PUBLIC_REPLY',
        replyText: 'سعره 20,000 جنيه بعد الخصم.',
        knowledgeRefs: ['kne_offer-fomos-discount'],
        confidence: 0.91,
      }),
    });

    await comment(h, seeded, '2', 'الأوتوكلاف ده بكام؟');

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id))[0]!;
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');
    assert.deepEqual(run.decision?.knowledgeRefsUsed, []);
    assert.equal(
      (await h.container.review.list(seeded.scope)).length,
      0,
      'no draft: a reviewer must not be handed an invented price to approve',
    );
    assertZeroDispatch(h);

    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1, 'the customer reaches a person instead');
  });

  it('keeps every draft fact out of the model’s reach', async () => {
    const { h, seeded } = await onboard();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ intentCode: 'GENERAL_ENGAGEMENT', action: 'NO_ACTION' }),
    });

    await comment(h, seeded, '3', 'فيه تقسيط وضمان على الجهاز؟');

    // The instalment and warranty entries exist, are tagged, match the question — and are DRAFT,
    // so the model was never shown them. This is the whole mechanism behind the invariant, and it
    // is asserted against the prompt the model actually received.
    const shown = h.provider.calls[0]!.request.turns.map((turn) => turn.content).join('\n');
    const draftIds = [...h.container.db.tables.knowledge.values()]
      .filter((entry) => entry.accountId === seeded.account.id && entry.status !== 'APPROVED')
      .map((entry) => entry.id as string);
    assert.ok(draftIds.includes('kne_instalments'), 'the fixture must actually hold draft facts');
    assert.ok(draftIds.includes('kne_warranty'));
    for (const id of draftIds) {
      assert.ok(!shown.includes(id), `${id} is DRAFT and must never reach the model`);
    }
    assertZeroDispatch(h);
  });

  it('an edited approval keeps the model’s original words on the record', async () => {
    const { h, seeded } = await onboard();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'CONTACT_REQUEST',
        action: 'PUBLIC_REPLY',
        replyText: 'واتساب: 01111772865',
        knowledgeRefs: ['kne_contact-whatsapp'],
      }),
    });

    await comment(h, seeded, '4', 'ازاي اتواصل معاكم؟');
    const queue = await h.container.review.list(seeded.scope);
    assert.equal(queue.length, 1);

    const edited = 'أهلاً بحضرتك 🙏 تقدر تتواصل معانا على واتساب: 01111772865';
    const decided = await h.container.review.decide(seeded.scope, {
      actionId: queue[0]!.action.id,
      decision: 'EDITED',
      reviewerUserId: REVIEWER,
      editedText: edited,
    });

    assert.equal(decided.review.originalText, 'واتساب: 01111772865');
    assert.equal(decided.review.editedText, edited);
    assert.equal(decided.action.payload.text, 'واتساب: 01111772865');
    assert.equal(decided.action.state, 'APPROVED_FOR_MANUAL_SEND');
    assert.equal(
      (await h.container.review.show(seeded.scope, decided.action.id)).finalText,
      edited,
    );
    assertZeroDispatch(h);
  });

  it('a human takeover invalidates the stale draft rather than leaving it approvable', async () => {
    const { h, seeded } = await onboard();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'CONTACT_REQUEST',
        action: 'PUBLIC_REPLY',
        replyText: 'واتساب: 01111772865',
        knowledgeRefs: ['kne_contact-whatsapp'],
      }),
    });

    await comment(h, seeded, '5', 'عايز رقم التواصل');
    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const queued = (await h.container.review.list(seeded.scope))[0]!;

    await h.container.takeover.takeOver(
      seeded.scope,
      conversation.id,
      REVIEWER,
      'handling this one in the inbox',
    );

    const action = await h.container.outboundActions.findById(seeded.scope, queued.action.id);
    assert.equal(action!.state, 'CANCELLED');
    assert.equal(action!.cancelledReason, 'HUMAN_TOOK_OVER');
    assert.equal((await h.container.review.list(seeded.scope)).length, 0);
    assertZeroDispatch(h);
  });

  it('two accounts on the same process cannot see each other’s drafts', async () => {
    const { h, seeded } = await onboard();
    const other = await h.seedAccount({ slug: 'client-b' });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'CONTACT_REQUEST',
        action: 'PUBLIC_REPLY',
        replyText: 'واتساب: 01111772865',
        knowledgeRefs: ['kne_contact-whatsapp'],
      }),
    });
    await comment(h, seeded, '6', 'رقم واتساب من فضلك');

    assert.equal((await h.container.review.list(seeded.scope)).length, 1);
    assert.equal((await h.container.review.list(other.scope)).length, 0);
    // And the other account's model never saw this account's knowledge either.
    const entries = await h.container.knowledge.findByIds(other.scope, [
      asId('kne_contact-whatsapp'),
    ]);
    assert.deepEqual(entries, []);
  });
});
