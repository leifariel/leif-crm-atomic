import { createClient } from "@supabase/supabase-js";

import { nextApplicationOutreachAction } from "../src/components/atomic-crm/outreach/applicationOutreachSchedule";

import { expect, test } from "./fixtures";

// WHAT A DELIVERED DAY-0 INVITATION MEANS FOR THE PIPELINE, AGAINST REAL
// POSTGRES.
//
// §4b Phase 2C. `converge_delivered_invitation` is the single authority that
// turns a confirmed delivery into lifecycle truth. It is DORMANT — nothing in
// the app calls it — so these tests are the only thing exercising it, which is
// exactly why they have to cover the decisions rather than the happy path.
//
// Every refusal here is the database's, taken from business truth re-read
// inside the transaction. None of it depends on a caller remembering a rule.
//
// Who may EXECUTE it is proved in securityPosture.spec.ts (test T), beside
// every other "a client cannot reach this" guarantee, using that file's own
// signed-in harness rather than a second one here.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 974000;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

const DELIVERED_AT = "2026-03-01T09:00:00.000Z";

/**
 * The Day-3 moment, from the ONE calendar authority. The command refuses to
 * open an active episode without a future moment and will not compute one
 * itself, so this is how its intended caller behaves.
 */
const openingNextActionAt = (deliveredAt = DELIVERED_AT) => {
  const next = nextApplicationOutreachAction({
    schedule_key: "application_outreach_v1",
    started_at: deliveredAt,
    step: 0,
    status: "active",
  });
  if (next.kind !== "action") throw new Error("the calendar refused step 0");
  return next.dueAt.toISOString();
};

/** A Contact on a waitlist, with a genuinely DELIVERED invitation. */
const seedDelivered = async (
  n: number,
  over: {
    offerId?: number;
    entryStatus?: string;
    invitationStatus?: string;
    sentAt?: string | null;
    deliveryMethod?: string | null;
  } = {},
) => {
  const offerId = over.offerId ?? LE;
  const client = db();
  const contactId = BASE + n;

  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Converge",
      last_name: `Case${n}`,
      email_jsonb: [{ email: `converge${n}@outreach.test`, type: "Work" }],
    }),
  );

  const { data: entry, error: entryError } = await client
    .from("waitlist_entries")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      cohort_id: null,
      status: over.entryStatus ?? "invited",
      joined_at: "2026-01-05T09:00:00.000Z",
    })
    .select("id, status, converted_at")
    .single();
  ok(`entry ${n}`, { error: entryError });

  const { data: batch, error: batchError } = await client
    .from("waitlist_invitation_batches")
    .insert({ offer_id: offerId, cohort_id: null, status: "prepared" })
    .select("id")
    .single();
  ok(`batch ${n}`, { error: batchError });

  const sentAt = over.sentAt === undefined ? DELIVERED_AT : over.sentAt;
  const { data: invitation, error: invError } = await client
    .from("waitlist_invitations")
    .insert({
      batch_id: batch!.id,
      waitlist_entry_id: entry!.id,
      contact_id: contactId,
      status: over.invitationStatus ?? "sent",
      sent_at: sentAt,
      delivery_method:
        over.deliveryMethod === undefined ? "kit_tag" : over.deliveryMethod,
    })
    .select("id")
    .single();
  ok(`invitation ${n}`, { error: invError });

  return {
    contactId,
    entryId: entry!.id as number,
    invitationId: invitation!.id as number,
    offerId,
  };
};

const seedDeal = async (
  contactId: number,
  offerId: number,
  fields: Record<string, unknown>,
) => {
  const { data, error } = await db()
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      cohort_id: null,
      amount: 4000,
      entry_path: "other",
      description: "",
      ...fields,
    })
    .select("id, stage, outcome")
    .single();
  ok("the seeded Opportunity", { error });
  return data!;
};

const converge = async (invitationId: number, nextActionAt?: string | null) => {
  const { data, error } = await db().rpc("converge_delivered_invitation", {
    p_invitation_id: invitationId,
    p_next_action_at:
      nextActionAt === undefined ? openingNextActionAt() : nextActionAt,
  });
  ok("the convergence call itself", { error });
  return data as Record<string, unknown>;
};

const attemptsFor = async (opportunityId: number) => {
  const { data } = await db()
    .from("application_outreach_attempts")
    .select(
      "id, status, step, schedule_key, started_at, next_action_at, externally_managed_until, source, channel, executor, end_reason, resulting_application_id, waitlist_invitation_id",
    )
    .eq("opportunity_id", opportunityId);
  return data ?? [];
};

const entryRow = async (entryId: number) => {
  const { data } = await db()
    .from("waitlist_entries")
    .select("status, converted_at, converted_opportunity_id")
    .eq("id", entryId)
    .single();
  return data!;
};

const dealsFor = async (contactId: number, offerId: number) => {
  const { data } = await db()
    .from("deals")
    .select("id, stage, outcome, entry_path")
    .eq("contact_id", contactId)
    .eq("offer_id", offerId)
    .order("id", { ascending: true });
  return data ?? [];
};

test.describe("a delivered invitation opens exactly one sales cycle", () => {
  test("A. no Opportunity yet: Interested is created, with one active episode on the v1 calendar", async () => {
    const { contactId, entryId, invitationId, offerId } =
      await seedDelivered(1);

    const result = await converge(invitationId);

    expect(result.status).toBe("created");
    expect(result.reused_opportunity).toBe(false);
    expect(result.stage).toBe("interested");
    expect(result.invitation_id).toBe(invitationId);
    expect(result.outreach_status).toBe("active");
    expect(result.outreach_attempt_id).toBeTruthy();

    const deals = await dealsFor(contactId, offerId);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.stage).toBe("interested");
    expect(deals[0]!.outcome).toBeNull();
    // No public form produced this, and saying one did would be the lie
    // create_manual_application avoids for the same reason.
    expect(deals[0]!.entry_path).toBe("other");

    const attempts = await attemptsFor(deals[0]!.id as number);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.status).toBe("active");
    expect(attempt.step).toBe(0);
    expect(attempt.schedule_key).toBe("application_outreach_v1");
    expect(attempt.source).toBe("waitlist");
    expect(attempt.channel).toBe("email");
    // Gmail owns the FUTURE follow-up. It did not send Day 0.
    expect(attempt.executor).toBe("gmail");
    expect(attempt.waitlist_invitation_id).toBe(invitationId);
    expect(attempt.externally_managed_until).toBeNull();
    expect(attempt.end_reason).toBeNull();

    // Anchored to the real delivery, and due on Day 3 of that anchor.
    expect(new Date(attempt.started_at as string).toISOString()).toBe(
      DELIVERED_AT,
    );
    expect(new Date(attempt.next_action_at as string).toISOString()).toBe(
      new Date(
        new Date(DELIVERED_AT).getTime() + 3 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );

    // P. AND THE WAITLIST PLACE IS NOT SPENT. Being invited is not having
    // started: handle_deal_waitlist_sync converts only from
    // application_received onward (§8r), and nothing here converts it either.
    const entry = await entryRow(entryId);
    expect(entry.status).toBe("invited");
    expect(entry.converted_at).toBeNull();
    expect(entry.converted_opportunity_id).toBeNull();
  });

  test("B. replaying the same call converges to the same rows", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(2);

    const first = await converge(invitationId);
    const second = await converge(invitationId);
    const third = await converge(invitationId);

    expect(first.status).toBe("created");
    // A worker retry, a duplicate callback, a lost response, an operator
    // running reconciliation twice: all land on the same episode.
    expect(second.status).toBe("already-converged");
    expect(third.status).toBe("already-converged");
    expect(second.opportunity_id).toBe(first.opportunity_id);
    expect(second.outreach_attempt_id).toBe(first.outreach_attempt_id);
    expect(third.outreach_attempt_id).toBe(first.outreach_attempt_id);

    expect(await dealsFor(contactId, offerId)).toHaveLength(1);
    expect(await attemptsFor(first.opportunity_id as number)).toHaveLength(1);
  });

  test("C. two concurrent calls produce one Opportunity and one episode", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(3);

    // Fired together on purpose: the advisory lock serializes them, and the
    // per-invitation unique index is the database's own backstop.
    const results = await Promise.all([
      converge(invitationId),
      converge(invitationId),
      converge(invitationId),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([
      "already-converged",
      "already-converged",
      "created",
    ]);

    const deals = await dealsFor(contactId, offerId);
    expect(deals).toHaveLength(1);
    expect(await attemptsFor(deals[0]!.id as number)).toHaveLength(1);
  });

  test("D. an existing active Interested Opportunity is reused, not duplicated", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(4);
    const existing = await seedDeal(contactId, LE, {
      stage: "interested",
      outcome: null,
    });

    const result = await converge(invitationId);

    expect(result.status).toBe("reused");
    expect(result.reused_opportunity).toBe(true);
    expect(result.opportunity_id).toBe(existing.id);
    expect(result.outreach_status).toBe("active");

    expect(await dealsFor(contactId, offerId)).toHaveLength(1);
    expect(await attemptsFor(existing.id as number)).toHaveLength(1);
  });

  test("E. an Interested Opportunity that already has a running episode gets no second one", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(5);
    const existing = await seedDeal(contactId, LE, {
      stage: "interested",
      outcome: null,
    });
    ok(
      "a running episode from some earlier cycle",
      await db().from("application_outreach_attempts").insert({
        opportunity_id: existing.id,
        source: "instagram",
        channel: "instagram",
        executor: "none",
        schedule_key: "application_outreach_v1",
        status: "active",
        step: 0,
        next_action_at: "2026-12-01T09:00:00.000Z",
      }),
    );

    const result = await converge(invitationId);

    expect(result.status).toBe("already-converged");
    expect(result.opportunity_id).toBe(existing.id);
    // One running episode per Opportunity: the existing lifecycle is
    // returned rather than a constraint violation provoked.
    expect(await attemptsFor(existing.id as number)).toHaveLength(1);
    expect(await dealsFor(contactId, offerId)).toHaveLength(1);
  });
});

test.describe("later truth is never regressed", () => {
  for (const stage of [
    "application_received",
    "approved",
    "call_booked",
    "decision",
  ]) {
    test(`F/G. an active Opportunity at ${stage} is not dragged back to Interested`, async () => {
      const n =
        10 +
        ["application_received", "approved", "call_booked", "decision"].indexOf(
          stage,
        );
      const { contactId, invitationId, offerId } = await seedDelivered(n);
      const existing = await seedDeal(contactId, LE, {
        stage,
        outcome: null,
      });

      const result = await converge(invitationId);

      expect(result.status).toBe("already-later-stage");
      expect(result.opportunity_id).toBe(existing.id);
      expect(result.stage).toBe(stage);
      // No reminder episode for somebody already further along...
      expect(result.outreach_attempt_id).toBeUndefined();
      expect(await attemptsFor(existing.id as number)).toHaveLength(0);

      // ...and the Opportunity itself is untouched.
      const deals = await dealsFor(contactId, offerId);
      expect(deals).toHaveLength(1);
      expect(deals[0]!.stage).toBe(stage);
    });
  }

  test("H. a won Opportunity means already a client: no Interested, no episode", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(20);
    const won = await seedDeal(contactId, LE, { stage: "won", outcome: null });

    const result = await converge(invitationId);

    // deal_is_active() calls a won Opportunity INACTIVE, so without this
    // explicit check the command would open an Interested cycle beside a
    // sale that already closed.
    expect(result.status).toBe("already-client");
    expect(result.opportunity_id).toBe(won.id);
    expect(result.outreach_attempt_id).toBeUndefined();
    expect(await attemptsFor(won.id as number)).toHaveLength(0);
    expect(await dealsFor(contactId, offerId)).toHaveLength(1);
  });

  test("H. an enrollment means already a client even at an earlier stage", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(21);
    const deal = await seedDeal(contactId, LE, {
      stage: "decision",
      outcome: null,
    });
    ok(
      "the enrollment",
      await db()
        .from("enrollments")
        .insert({ opportunity_id: deal.id, status: "onboarding" }),
    );

    const result = await converge(invitationId);

    expect(result.status).toBe("already-client");
    expect(result.opportunity_id).toBe(deal.id);
    expect(await attemptsFor(deal.id as number)).toHaveLength(0);
    expect(await dealsFor(contactId, offerId)).toHaveLength(1);
  });
});

test.describe("a terminal cycle is never resurrected", () => {
  for (const outcome of ["nurture", "lost", "not_fit", "workshops_only"]) {
    test(`I/J. a concluded ${outcome} cycle gets a NEW Opportunity beside it, untouched`, async () => {
      const n =
        30 + ["nurture", "lost", "not_fit", "workshops_only"].indexOf(outcome);
      const { contactId, invitationId, offerId } = await seedDelivered(n);
      const concluded = await seedDeal(contactId, LE, {
        stage: "interested",
        outcome,
      });

      const result = await converge(invitationId);

      // "A terminal attempt is never silently reactivated. If the same
      // person starts a genuinely new cycle for the same Offer, that is a
      // new Opportunity beside the old one." (deals/dealActivity.ts)
      expect(result.status).toBe("created");
      expect(result.opportunity_id).not.toBe(concluded.id);
      expect(result.stage).toBe("interested");

      const deals = await dealsFor(contactId, offerId);
      expect(deals).toHaveLength(2);

      // The concluded row is exactly as it was.
      const old = deals.find((d) => d.id === concluded.id)!;
      expect(old.outcome).toBe(outcome);
      expect(old.stage).toBe("interested");
      expect(await attemptsFor(concluded.id as number)).toHaveLength(0);
      expect(await attemptsFor(result.opportunity_id as number)).toHaveLength(
        1,
      );
    });
  }
});

test.describe("the other programme's journey is its own", () => {
  test("K. an active GYU Opportunity does not block the LE cycle, and is untouched", async () => {
    const { contactId, invitationId } = await seedDelivered(40, {
      offerId: LE,
    });
    const otherOffer = await seedDeal(contactId, GYU, {
      stage: "call_booked",
      outcome: null,
    });

    const result = await converge(invitationId);

    // LE and GYU are separate Opportunity lifecycles.
    expect(result.status).toBe("created");
    expect(result.stage).toBe("interested");
    expect(result.opportunity_id).not.toBe(otherOffer.id);

    expect(await dealsFor(contactId, LE)).toHaveLength(1);
    const gyu = await dealsFor(contactId, GYU);
    expect(gyu).toHaveLength(1);
    expect(gyu[0]!.stage).toBe("call_booked");
    expect(await attemptsFor(otherOffer.id as number)).toHaveLength(0);
  });
});

test.describe("refusals before anything is written", () => {
  test("L. do-not-engage is refused, and creates no lifecycle at all", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(50);
    ok(
      "the global gate",
      await db()
        .from("contacts")
        .update({ sales_eligibility: "do_not_engage" })
        .eq("id", contactId),
    );

    const result = await converge(invitationId);

    expect(result.status).toBe("do-not-engage");
    expect(result.opportunity_id).toBeUndefined();
    expect(result.outreach_attempt_id).toBeUndefined();
    expect(await dealsFor(contactId, offerId)).toHaveLength(0);
  });

  test("R. an undelivered invitation is refused — a click is not a send", async () => {
    for (const [n, invitationStatus, sentAt] of [
      [60, "prepared", null],
      [61, "failed", null],
      [62, "cancelled", null],
    ] as const) {
      const { contactId, invitationId, offerId } = await seedDelivered(n, {
        invitationStatus,
        sentAt,
        deliveryMethod: null,
      });

      const result = await converge(invitationId);

      expect(result.status).toBe("invitation-not-delivered");
      expect(result.invitation_status).toBe(invitationStatus);
      expect(await dealsFor(contactId, offerId)).toHaveLength(0);
    }
  });

  test("R. a missing invitation is refused", async () => {
    const result = await converge(99999999);
    expect(result.status).toBe("invitation-missing");
  });

  test("S. provenance that disagrees with itself is refused", async () => {
    const { invitationId } = await seedDelivered(70);
    const other = await seedDelivered(71);

    // The invitation now points at a waitlist entry belonging to somebody
    // else. Nothing may be created from provenance that contradicts itself.
    ok(
      "the contradiction",
      await db()
        .from("waitlist_invitations")
        .update({ waitlist_entry_id: other.entryId })
        .eq("id", invitationId),
    );

    const result = await converge(invitationId);

    expect(result.status).toBe("invitation-invalid");
    expect(String(result.reason)).toContain("disagree about the contact");
  });

  test("an active episode without a future moment is refused", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(80);

    // The command will not invent a calendar it does not own, so a caller
    // that supplies no next action gets a refusal rather than a row that
    // breaks active_has_a_future_check.
    const missing = await converge(invitationId, null);
    expect(missing.status).toBe("invalid-next-action");

    // And a moment that is not actually in the episode's future.
    const backwards = await converge(invitationId, "2026-02-01T09:00:00.000Z");
    expect(backwards.status).toBe("invalid-next-action");

    expect(await dealsFor(contactId, offerId)).toHaveLength(0);
  });
});

test.describe("application truth wins, and is recorded truthfully", () => {
  test("M/O. an application already submitted produces CLOSED history, not a reminder", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(90);
    const deal = await seedDeal(contactId, LE, {
      stage: "application_received",
      outcome: null,
    });
    const appliedAt = "2026-03-02T15:00:00.000Z";
    const { data: application, error } = await db()
      .from("applications")
      .insert({
        contact_id: contactId,
        opportunity_id: deal.id,
        offer_id: LE,
        raw_answers: {},
        submitted_at: appliedAt,
        status: "pending",
        source: "manual",
      })
      .select("id")
      .single();
    ok("the application", { error });

    const result = await converge(invitationId);

    // Business truth chose this, not a caller flag.
    expect(result.status).toBe("application-already-submitted");
    expect(result.outreach_status).toBe("closed");
    expect(result.application_id).toBe(application!.id);
    expect(result.stage).toBe("application_received");

    const attempts = await attemptsFor(deal.id as number);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.status).toBe("closed");
    expect(attempt.end_reason).toBe("application_submitted");
    expect(attempt.resulting_application_id).toBe(application!.id);
    expect(attempt.waitlist_invitation_id).toBe(invitationId);
    expect(attempt.schedule_key).toBe("application_outreach_v1");
    // Day 0 is where it really happened; the end is the application's own
    // moment; and a concluded episode has no future, so no reminder can
    // ever be computed for it.
    expect(new Date(attempt.started_at as string).toISOString()).toBe(
      DELIVERED_AT,
    );
    expect(attempt.next_action_at).toBeNull();
    expect(attempt.externally_managed_until).toBeNull();

    // The Opportunity was not regressed.
    const deals = await dealsFor(contactId, offerId);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.stage).toBe("application_received");
  });

  test("an application that predates the delivery is surfaced, not invented", async () => {
    const { contactId, invitationId } = await seedDelivered(91);
    const deal = await seedDeal(contactId, LE, {
      stage: "application_received",
      outcome: null,
    });
    ok(
      "an application from before we asked",
      await db().from("applications").insert({
        contact_id: contactId,
        opportunity_id: deal.id,
        offer_id: LE,
        raw_answers: {},
        submitted_at: "2026-01-15T09:00:00.000Z",
        status: "pending",
        source: "manual",
      }),
    );

    const result = await converge(invitationId);

    // An episode ending before it began would be a lie, so this is reported
    // rather than reconstructed.
    expect(result.status).toBe("ambiguous");
    expect(String(result.reason)).toContain("predates");
    expect(await attemptsFor(deal.id as number)).toHaveLength(0);
  });

  test("Q. an already-converted waitlist entry does not have its history churned", async () => {
    const { contactId, entryId, invitationId } = await seedDelivered(92, {
      entryStatus: "invited",
    });
    const deal = await seedDeal(contactId, LE, {
      stage: "application_received",
      outcome: null,
    });
    const convertedAt = "2026-03-02T16:00:00.000Z";
    ok(
      "the conversion the application path already performed",
      await db()
        .from("waitlist_entries")
        .update({
          status: "converted",
          converted_at: convertedAt,
          converted_opportunity_id: deal.id,
        })
        .eq("id", entryId),
    );
    ok(
      "the application",
      await db().from("applications").insert({
        contact_id: contactId,
        opportunity_id: deal.id,
        offer_id: LE,
        raw_answers: {},
        submitted_at: "2026-03-02T15:00:00.000Z",
        status: "pending",
        source: "manual",
      }),
    );

    const result = await converge(invitationId);
    expect(result.status).toBe("application-already-submitted");

    // Convergence records history; it does not rewrite a valid conversion.
    const entry = await entryRow(entryId);
    expect(entry.status).toBe("converted");
    expect(new Date(entry.converted_at as string).toISOString()).toBe(
      convertedAt,
    );
    expect(entry.converted_opportunity_id).toBe(deal.id);
  });

  test("N. a client appearing after eligibility was judged still wins", async () => {
    const { contactId, invitationId, offerId } = await seedDelivered(93);

    // Eligibility was decided when the invitation was prepared. By the time
    // convergence runs they have become a client, and the command re-reads
    // that rather than trusting the earlier judgement.
    const won = await seedDeal(contactId, LE, { stage: "won", outcome: null });

    const result = await converge(invitationId);
    expect(result.status).toBe("already-client");
    expect(result.opportunity_id).toBe(won.id);
    expect(await attemptsFor(won.id as number)).toHaveLength(0);
    expect(await dealsFor(contactId, offerId)).toHaveLength(1);
  });
});
