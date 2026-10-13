import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// THE APPLICATION OUTREACH AUTHORITY, AGAINST REAL POSTGRES.
//
// §4b Phase 2A. One invitation-to-apply episode per Opportunity, many
// historical attempts, at most one running — and an active attempt can never
// be without a future moment, which is what stops an Opportunity sitting in
// Interested forever.
//
// Every rule here is a database rule. The point of these tests is that the
// database refuses, not that some caller remembers to.
//
// Who may touch the table (K and L) is proved in securityPosture.spec.ts,
// beside every other "a client cannot reach this" guarantee, using that
// file's own signed-in harness rather than a second one here.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 981000;
const SOON = "2026-12-01T09:00:00.000Z";

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

/** A Contact and an Opportunity to hang episodes off. */
const seedOpportunity = async (n: number, offerId = LE) => {
  const client = db();
  const contactId = BASE + n;
  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Outreach",
      last_name: `Case${n}`,
      email_jsonb: [{ email: `case${n}@outreach.test`, type: "Work" }],
    }),
  );
  const { data, error } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      cohort_id: null,
      stage: "interested",
      outcome: null,
      amount: 4000,
      entry_path: "other",
      description: "",
    })
    .select("id")
    .single();
  ok(`deal ${n}`, { error });
  return { contactId, opportunityId: data!.id as number };
};

/** The shape every active attempt has, minus whatever a test is varying. */
const activeAttempt = (
  opportunityId: number,
  over: Record<string, unknown> = {},
) => ({
  opportunity_id: opportunityId,
  source: "waitlist",
  channel: "email",
  executor: "gmail",
  status: "active",
  step: 0,
  next_action_at: SOON,
  ...over,
});

const insert = async (row: Record<string, unknown>) =>
  await db().from("application_outreach_attempts").insert(row);

test.describe("one running episode per Opportunity, unlimited history", () => {
  test("A. an Opportunity can have one active attempt", async () => {
    const { opportunityId } = await seedOpportunity(1);

    ok("the first attempt", await insert(activeAttempt(opportunityId)));

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("id, status, source, channel, executor, step")
      .eq("opportunity_id", opportunityId);
    expect(data).toHaveLength(1);
    expect(data![0]!.status).toBe("active");
  });

  test("B. a second simultaneous active attempt is refused by the database", async () => {
    const { opportunityId } = await seedOpportunity(2);
    ok("the first attempt", await insert(activeAttempt(opportunityId)));

    const { error } = await insert(activeAttempt(opportunityId));

    expect(error?.message ?? "").toContain("duplicate key value");
  });

  test("C. a second attempt is allowed once the first has closed", async () => {
    const { opportunityId } = await seedOpportunity(3);
    ok("the first attempt", await insert(activeAttempt(opportunityId)));

    ok(
      "closing it",
      await db()
        .from("application_outreach_attempts")
        .update({
          status: "closed",
          ended_at: "2026-11-01T09:00:00.000Z",
          end_reason: "sequence_exhausted",
          next_action_at: null,
        })
        .eq("opportunity_id", opportunityId),
    );

    ok(
      "the second attempt",
      await insert(activeAttempt(opportunityId, { step: 0 })),
    );

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("status")
      .eq("opportunity_id", opportunityId);
    expect(data).toHaveLength(2);
    expect(data!.filter((r) => r.status === "active")).toHaveLength(1);
  });

  test("D. the closed attempt is untouched by the new one", async () => {
    const { opportunityId } = await seedOpportunity(4);
    ok("first", await insert(activeAttempt(opportunityId)));
    ok(
      "closing it",
      await db()
        .from("application_outreach_attempts")
        .update({
          status: "closed",
          ended_at: "2026-11-01T09:00:00.000Z",
          end_reason: "not_now",
          next_action_at: null,
        })
        .eq("opportunity_id", opportunityId),
    );
    const { data: before } = await db()
      .from("application_outreach_attempts")
      .select("id, ended_at, end_reason, started_at")
      .eq("opportunity_id", opportunityId)
      .single();

    ok("second", await insert(activeAttempt(opportunityId)));

    const { data: after } = await db()
      .from("application_outreach_attempts")
      .select("id, ended_at, end_reason, started_at")
      .eq("id", before!.id)
      .single();
    expect(after).toEqual(before);
  });

  test("F. different Opportunities may each have an active attempt", async () => {
    const first = await seedOpportunity(5);
    const second = await seedOpportunity(6);

    ok("first", await insert(activeAttempt(first.opportunityId)));
    ok("second", await insert(activeAttempt(second.opportunityId)));

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("opportunity_id")
      .in("opportunity_id", [first.opportunityId, second.opportunityId]);
    expect(data).toHaveLength(2);
  });

  test("G. one Contact's LE and GYU journeys each run their own episode", async () => {
    // HANDOFF §4b: separate journeys, so an invitation to one says nothing
    // about the other.
    const client = db();
    const contactId = BASE + 7;
    ok(
      "contact",
      await client.from("contacts").insert({
        id: contactId,
        first_name: "Cross",
        last_name: "Offer",
        email_jsonb: [{ email: "cross@outreach.test", type: "Work" }],
      }),
    );
    const ids: number[] = [];
    for (const offerId of [LE, GYU]) {
      const { data, error } = await client
        .from("deals")
        .insert({
          contact_id: contactId,
          offer_id: offerId,
          cohort_id: null,
          stage: "interested",
          outcome: null,
          amount: 4000,
          entry_path: "other",
          description: "",
        })
        .select("id")
        .single();
      ok(`deal for offer ${offerId}`, { error });
      ids.push(data!.id as number);
    }

    for (const id of ids)
      ok(`attempt for ${id}`, await insert(activeAttempt(id)));

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("opportunity_id")
      .in("opportunity_id", ids);
    expect(data).toHaveLength(2);
  });
});

test.describe("an episode cannot contradict itself", () => {
  test("H. a closed attempt must say when and why", async () => {
    const { opportunityId } = await seedOpportunity(8);

    const noEnd = await insert({
      ...activeAttempt(opportunityId),
      status: "closed",
      next_action_at: null,
      end_reason: "sequence_exhausted",
    });
    expect(noEnd.error?.message ?? "").toContain("closed_shape_check");

    const noReason = await insert({
      ...activeAttempt(opportunityId),
      status: "closed",
      next_action_at: null,
      ended_at: "2026-11-01T09:00:00.000Z",
    });
    expect(noReason.error?.message ?? "").toContain("closed_shape_check");
  });

  test("I. an active attempt cannot already be finished", async () => {
    const { opportunityId } = await seedOpportunity(9);

    const withEnd = await insert({
      ...activeAttempt(opportunityId),
      ended_at: "2026-11-01T09:00:00.000Z",
    });
    expect(withEnd.error?.message ?? "").toContain("active_shape_check");

    const withReason = await insert({
      ...activeAttempt(opportunityId),
      end_reason: "not_now",
    });
    expect(withReason.error?.message ?? "").toContain("active_shape_check");
  });

  test("M. an active attempt must have a future moment, and a Kit one must say when Kit stops", async () => {
    const { opportunityId } = await seedOpportunity(10);

    // Nothing driving it from either side: refused, because this is exactly
    // the row that would hold an Opportunity in Interested forever.
    const nowhere = await insert({
      ...activeAttempt(opportunityId),
      next_action_at: null,
    });
    expect(nowhere.error?.message ?? "").toContain("active_has_a_future_check");

    // Kit drives its own sequence, so next_action_at alone is not enough —
    // the CRM must know when Kit's window ends.
    const kitWithoutBoundary = await insert({
      ...activeAttempt(opportunityId),
      executor: "kit",
      next_action_at: SOON,
    });
    expect(kitWithoutBoundary.error?.message ?? "").toContain(
      "kit_boundary_check",
    );

    // With the boundary stated, it is allowed.
    ok(
      "kit with a stated end",
      await insert({
        ...activeAttempt(opportunityId),
        executor: "kit",
        next_action_at: null,
        externally_managed_until: "2027-01-15T09:00:00.000Z",
      }),
    );
  });

  test("the vocabulary is held to real distinctions", async () => {
    const { opportunityId } = await seedOpportunity(11);

    for (const [column, value, constraint] of [
      ["source", "carrier_pigeon", "source_check"],
      ["channel", "telepathy", "channel_check"],
      ["executor", "mailchimp", "executor_check"],
      ["status", "paused", "status_check"],
    ] as const) {
      const { error } = await insert({
        ...activeAttempt(opportunityId),
        [column]: value,
      });
      expect(error?.message ?? "", column).toContain(constraint);
    }

    // "Didn't answer" is not "said no" is not "unsubscribed" is not
    // "applied" — and a word nobody has reasoned about is not any of them.
    const { error } = await insert({
      ...activeAttempt(opportunityId),
      status: "closed",
      next_action_at: null,
      ended_at: "2026-11-01T09:00:00.000Z",
      end_reason: "gave_up",
    });
    expect(error?.message ?? "").toContain("end_reason_check");
  });
});

test.describe("provenance", () => {
  test("E. one delivered invitation can originate only one episode", async () => {
    // What will make the 11 Oct backfill idempotent.
    const { contactId, opportunityId } = await seedOpportunity(12);
    const client = db();
    const { data: batch, error: batchError } = await client
      .from("waitlist_invitation_batches")
      .insert({ offer_id: LE, cohort_id: null, status: "prepared" })
      .select("id")
      .single();
    ok("the batch", { error: batchError });
    const { data: entry, error: entryError } = await client
      .from("waitlist_entries")
      .insert({
        contact_id: contactId,
        offer_id: LE,
        cohort_id: null,
        status: "invited",
        joined_at: "2026-02-01T09:00:00.000Z",
      })
      .select("id")
      .single();
    ok("the entry", { error: entryError });
    const { data: invitation, error: invError } = await client
      .from("waitlist_invitations")
      .insert({
        batch_id: batch!.id,
        waitlist_entry_id: entry!.id,
        contact_id: contactId,
        status: "prepared",
      })
      .select("id")
      .single();
    ok("the invitation", { error: invError });

    ok(
      "the episode it started",
      await insert(
        activeAttempt(opportunityId, {
          waitlist_invitation_id: invitation!.id,
        }),
      ),
    );

    // A replayed backfill reaches the same row rather than inviting twice.
    const { opportunityId: other } = await seedOpportunity(13);
    const { error } = await insert(
      activeAttempt(other, { waitlist_invitation_id: invitation!.id }),
    );
    expect(error?.message ?? "").toContain("duplicate key value");
  });

  test("J. every provenance pointer is checked by the database", async () => {
    const { opportunityId } = await seedOpportunity(14);

    const noDeal = await insert(activeAttempt(999000001));
    expect(noDeal.error?.message ?? "").toContain("opportunity_id_fkey");

    const noInvitation = await insert(
      activeAttempt(opportunityId, { waitlist_invitation_id: 999000002 }),
    );
    expect(noInvitation.error?.message ?? "").toContain(
      "waitlist_invitation_id_fkey",
    );

    const noApplication = await insert(
      activeAttempt(opportunityId, { resulting_application_id: 999000003 }),
    );
    expect(noApplication.error?.message ?? "").toContain(
      "resulting_application_id_fkey",
    );
  });
});

// AN EPISODE IS HISTORY, AND HISTORY DOES NOT CHANGE ITS MIND.
//
// The CHECK constraints above are row-local: they see NEW and nothing else,
// so they cannot say "this column may not change" or "closed may not become
// active again". Those are OLD-versus-NEW questions, and a BEFORE UPDATE
// trigger answers them — guard_outreach_attempt_mutation(), in the shape
// reject_application_response_mutation() already uses.
//
// Without it, a future service-role writer could quietly rewrite which
// Opportunity an episode belonged to, or reopen a closed attempt so that a
// second outreach cycle overwrote the first instead of standing beside it.
test.describe("an attempt's identity and history cannot be rewritten", () => {
  const attemptFor = async (n: number) => {
    const { opportunityId } = await seedOpportunity(n);
    const { data, error } = await db()
      .from("application_outreach_attempts")
      .insert(activeAttempt(opportunityId))
      .select("id, created_at, updated_at, started_at")
      .single();
    ok("the attempt", { error });
    return { opportunityId, attempt: data! };
  };

  const update = async (id: number, patch: Record<string, unknown>) =>
    await db().from("application_outreach_attempts").update(patch).eq("id", id);

  test("N1. ordinary progress succeeds, advances updated_at and leaves created_at alone", async () => {
    const { attempt } = await attemptFor(20);

    ok(
      "advancing the step",
      await update(attempt.id, {
        step: 1,
        next_action_at: "2026-12-08T09:00:00.000Z",
      }),
    );

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("step, next_action_at, created_at, updated_at")
      .eq("id", attempt.id)
      .single();
    expect(data!.step).toBe(1);
    expect(data!.created_at).toBe(attempt.created_at);
    expect(
      new Date(data!.updated_at).getTime(),
      "updated_at must actually advance, not merely exist",
    ).toBeGreaterThan(new Date(attempt.updated_at).getTime());
  });

  test("N2. the Opportunity it belongs to cannot be changed", async () => {
    const { attempt } = await attemptFor(21);
    const { opportunityId: elsewhere } = await seedOpportunity(22);

    const { error } = await update(attempt.id, { opportunity_id: elsewhere });

    expect(error?.message ?? "").toContain(
      "identity and provenance are immutable",
    );
  });

  test("N3. source cannot be rewritten", async () => {
    const { attempt } = await attemptFor(23);

    const { error } = await update(attempt.id, { source: "instagram" });

    expect(error?.message ?? "").toContain(
      "identity and provenance are immutable",
    );
  });

  test("N4. the originating invitation cannot be rewritten", async () => {
    // It needs a real invitation to rewrite. The first version of this test
    // nulled a column that was already null, which is not a change at all,
    // so nothing was ever going to refuse it.
    const client = db();
    const { contactId, opportunityId } = await seedOpportunity(24);
    const { data: batch, error: batchError } = await client
      .from("waitlist_invitation_batches")
      .insert({ offer_id: LE, cohort_id: null, status: "prepared" })
      .select("id")
      .single();
    ok("the batch", { error: batchError });
    const { data: entry, error: entryError } = await client
      .from("waitlist_entries")
      .insert({
        contact_id: contactId,
        offer_id: LE,
        cohort_id: null,
        status: "invited",
        joined_at: "2026-02-01T09:00:00.000Z",
      })
      .select("id")
      .single();
    ok("the entry", { error: entryError });
    const { data: invitation, error: invitationError } = await client
      .from("waitlist_invitations")
      .insert({
        batch_id: batch!.id,
        waitlist_entry_id: entry!.id,
        contact_id: contactId,
        status: "prepared",
      })
      .select("id")
      .single();
    ok("the invitation", { error: invitationError });

    const { data: attempt, error: attemptError } = await client
      .from("application_outreach_attempts")
      .insert(
        activeAttempt(opportunityId, {
          waitlist_invitation_id: invitation!.id,
        }),
      )
      .select("id")
      .single();
    ok("the attempt", { error: attemptError });

    const { error } = await update(attempt!.id, {
      waitlist_invitation_id: null,
    });
    expect(error?.message ?? "").toContain(
      "identity and provenance are immutable",
    );

    const { data: after } = await client
      .from("application_outreach_attempts")
      .select("waitlist_invitation_id")
      .eq("id", attempt!.id)
      .single();
    expect(after!.waitlist_invitation_id).toBe(invitation!.id);
  });

  test("N5. started_at cannot be rewritten", async () => {
    const { attempt } = await attemptFor(25);

    const { error } = await update(attempt.id, {
      started_at: "2020-01-01T00:00:00.000Z",
    });

    expect(error?.message ?? "").toContain(
      "identity and provenance are immutable",
    );
  });

  test("N6. closing an active attempt succeeds", async () => {
    const { attempt } = await attemptFor(26);

    ok(
      "closing it",
      await update(attempt.id, {
        status: "closed",
        ended_at: "2026-12-20T09:00:00.000Z",
        end_reason: "sequence_exhausted",
        next_action_at: null,
      }),
    );

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("status, end_reason")
      .eq("id", attempt.id)
      .single();
    expect(data!.status).toBe("closed");
    expect(data!.end_reason).toBe("sequence_exhausted");
  });

  test("N7. a closed attempt cannot be brought back to life", async () => {
    const { attempt } = await attemptFor(27);
    ok(
      "closing it",
      await update(attempt.id, {
        status: "closed",
        ended_at: "2026-12-20T09:00:00.000Z",
        end_reason: "not_now",
        next_action_at: null,
      }),
    );

    // Otherwise perfectly valid active fields — the row shape would pass
    // every CHECK. Only the trigger knows this row has already ended.
    const { error } = await update(attempt.id, {
      status: "active",
      ended_at: null,
      end_reason: null,
      next_action_at: SOON,
    });

    expect(error?.message ?? "").toContain("a closed attempt is history");
  });

  test("N8. a closed attempt cannot be rewritten at all", async () => {
    const { attempt } = await attemptFor(28);
    ok(
      "closing it",
      await update(attempt.id, {
        status: "closed",
        ended_at: "2026-12-20T09:00:00.000Z",
        end_reason: "explicit_no",
        next_action_at: null,
      }),
    );
    const { data: closed } = await db()
      .from("application_outreach_attempts")
      .select("*")
      .eq("id", attempt.id)
      .single();

    for (const patch of [
      { end_reason: "application_submitted" },
      { ended_at: "2027-01-01T00:00:00.000Z" },
      { step: 9 },
      { executor: "kit" },
    ]) {
      const { error } = await update(attempt.id, patch);
      expect(
        error?.message ?? "",
        `rewriting ${Object.keys(patch)[0]} on a closed attempt`,
      ).toContain("a closed attempt is history");
    }

    const { data: after } = await db()
      .from("application_outreach_attempts")
      .select("*")
      .eq("id", attempt.id)
      .single();
    expect(after).toEqual(closed);
  });

  test("N9. re-inviting starts a new attempt beside the old one", async () => {
    const { opportunityId, attempt } = await attemptFor(29);
    ok(
      "closing the first",
      await update(attempt.id, {
        status: "closed",
        ended_at: "2026-12-20T09:00:00.000Z",
        end_reason: "sequence_exhausted",
        next_action_at: null,
      }),
    );

    ok("a second cycle", await insert(activeAttempt(opportunityId)));

    const { data } = await db()
      .from("application_outreach_attempts")
      .select("id, status, end_reason")
      .eq("opportunity_id", opportunityId)
      .order("id", { ascending: true });
    expect(data).toHaveLength(2);
    // The first still says what happened to it.
    expect(data![0]!.status).toBe("closed");
    expect(data![0]!.end_reason).toBe("sequence_exhausted");
    expect(data![1]!.status).toBe("active");
  });
});
