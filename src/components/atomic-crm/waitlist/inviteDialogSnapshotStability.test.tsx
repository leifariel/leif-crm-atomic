import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { CoreAdminContext, memoryStore, type DataProvider } from "ra-core";
import { MemoryRouter } from "react-router";

import { InviteToApplyDialog } from "./InviteToApplyDialog";
import { createTestAuthProvider } from "@/test/StoryWrapper";
import { testI18nProvider } from "../providers/commons/i18nProvider";

// THE PREFLIGHT LEIF APPROVES MUST BE THE PREFLIGHT THAT IS SENT.
//
// THE BUG THIS EXISTS FOR, from the first real batch. Leif opened Invite to
// apply on The Living Example at 13:02:07 and preflight 8 was created. She
// and ChatGPT audited preflight 8 — 25 people, every one of them checked.
// While the dialog sat open, the UI silently ran the whole preflight again
// at 13:04:55, creating preflight 9 and replacing the approved snapshot in
// state. At 13:04:57 she clicked Invite 25 and the dialog consumed
// preflight 9.
//
// 8 and 9 held the same 25 people in the same ranks, so the send itself was
// right and the batch is accepted. It was right by luck: nobody joined the
// waitlist and nobody's Kit state changed in those three minutes. Had either
// happened, Leif would have approved one list and sent another, and nothing
// in the UI would have said so.
//
// WHY IT COULD HAPPEN. The effect that runs the preflight listed
// `dataProvider` and `mode` among its dependencies. Both are reference
// types the dialog does not own: ra-core memoizes the dataProvider proxy on
// [dataProvider, logoutIfAccessDenied, queryClient], and logoutIfAccessDenied
// is itself a useCallback over [authProvider, logout, notify, handleRedirect]
// -> [navigate]. None of that is stable by contract. Any one of them taking
// a new identity re-ran a full preflight — a fresh walk that asks Kit about
// everybody again — and swapped the answer underneath the open dialog.
//
// So the fix cannot be "make that one dependency stable". The snapshot has
// to be immutable for the life of one dialog instance, whatever re-renders
// around it. This file holds it to that by changing the dataProvider's
// identity, which is the real documented instability.

type Call = { preflightId: number; label: string | null };

const buildProvider = (log: {
  preflights: number[];
  invites: Call[];
  expiresAt: string;
  nextId: () => number;
}) =>
  ({
    getList: async () => ({
      data: [
        {
          id: 1,
          offer_id: 1,
          event: "waitlist_invited",
          kit_tag_id: 24462485,
          kit_tag_name: "LE_Waitlist_Invited",
        },
      ],
      total: 1,
    }),
    getOne: async () => ({ data: { id: 1 } }),
    getMany: async () => ({ data: [] }),
    getManyReference: async () => ({ data: [], total: 0 }),
    create: async () => ({ data: { id: 1 } }),
    update: async () => ({ data: { id: 1 } }),
    updateMany: async () => ({ data: [] }),
    delete: async () => ({ data: { id: 1 } }),
    deleteMany: async () => ({ data: [] }),
    // The two calls this test is about.
    waitlistPreflight: async () => {
      const preflightId = log.nextId();
      log.preflights.push(preflightId);
      return {
        preflightId,
        expiresAt: log.expiresAt,
        requested: 2,
        resolved: 2,
        shortBy: 0,
        rows: [
          {
            waitlist_entry_id: 1,
            contact_id: 1,
            contact_name: "Katherine Piralyan",
            email: "k@example.invalid",
            joined_at: "2026-08-20T17:49:18.000Z",
            db_eligible: true,
            kit_state: "active",
            final_eligible: true,
            exclusion_reason: null,
            final_rank: 1,
          },
          {
            waitlist_entry_id: 2,
            contact_id: 2,
            contact_name: "Summer Macon",
            email: "s@example.invalid",
            joined_at: "2026-08-20T17:49:18.000Z",
            db_eligible: true,
            kit_state: "active",
            final_eligible: true,
            exclusion_reason: null,
            final_rank: 2,
          },
        ],
      };
    },
    inviteFromPreflight: async (input: Record<string, unknown>) => {
      log.invites.push({
        preflightId: Number(input.preflightId),
        label: (input.label as string) ?? null,
      });
      return {
        status: "queued",
        batch_id: 1,
        kit_tag_id: 24462485,
        kit_tag_name: "LE_Waitlist_Invited",
        requested: 2,
        queued: 2,
        invited: [],
        skipped: [],
      };
    },
  }) as unknown as DataProvider;

const renderDialog = async (
  overrides: { expiresAt?: string; count?: number } = {},
) => {
  const log = {
    preflights: [] as number[],
    invites: [] as Call[],
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    next: 7,
    nextId() {
      this.next += 1;
      return this.next;
    },
  };
  // Each call builds a NEW provider object, exactly as ra-core's memo does
  // when one of its own dependencies takes a new identity.
  const tree = (dataProvider: DataProvider, count = overrides.count ?? 2) => (
    <MemoryRouter>
      <CoreAdminContext
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
      >
        {/* Deliberately a fresh object each render: an unstable mode
            identity must not re-run the preflight either. */}
        <InviteToApplyDialog
          open
          onOpenChange={() => {}}
          offerId={1}
          offerName="The Living Example"
          cohortId={null}
          mode={{ kind: "oldest", count }}
          onConfirmed={() => {}}
        />
      </CoreAdminContext>
    </MemoryRouter>
  );

  if (overrides.expiresAt != null) log.expiresAt = overrides.expiresAt;
  await page.viewport(1280, 900);
  const screen = await render(tree(buildProvider(log)));
  return {
    log,
    screen,
    /** A re-render carrying a fresh dataProvider identity, nothing else. */
    reRenderWithNewProviderIdentity: () =>
      screen.rerender(tree(buildProvider(log))),
    /** Leif asks for a different number while the preview is on screen. */
    reRenderAskingFor: (count: number) =>
      screen.rerender(tree(buildProvider(log), count)),
  };
};

const confirmButton = (
  screen: Awaited<ReturnType<typeof renderDialog>>["screen"],
) => screen.getByRole("button", { name: "Invite 2" });

describe("the approved snapshot is the one that is sent", () => {
  it("opening the dialog runs exactly one preflight", async () => {
    const { log, screen } = await renderDialog();
    await expect.element(confirmButton(screen)).toBeInTheDocument();

    expect(log.preflights).toEqual([8]);
  });

  it("a new dataProvider identity does NOT replace the approved snapshot", async () => {
    // THE PRODUCTION FAILURE. Before the repair this produced preflight 9
    // and Confirm consumed it.
    const { log, screen, reRenderWithNewProviderIdentity } =
      await renderDialog();
    await expect.element(confirmButton(screen)).toBeInTheDocument();

    await reRenderWithNewProviderIdentity();
    await reRenderWithNewProviderIdentity();
    await expect.element(confirmButton(screen)).toBeInTheDocument();

    expect(log.preflights).toEqual([8]);
  });

  it("Confirm consumes exactly the snapshot that was displayed", async () => {
    const { log, screen, reRenderWithNewProviderIdentity } =
      await renderDialog();
    await expect.element(confirmButton(screen)).toBeInTheDocument();
    await reRenderWithNewProviderIdentity();

    await confirmButton(screen).click();

    expect(log.invites).toHaveLength(1);
    // 8, not 9 — the id Leif was looking at.
    expect(log.invites[0]!.preflightId).toBe(8);
    expect(log.preflights).toEqual([8]);
  });

  it("Cancel consumes nothing, however many times it re-rendered", async () => {
    const { log, screen, reRenderWithNewProviderIdentity } =
      await renderDialog();
    await expect.element(confirmButton(screen)).toBeInTheDocument();
    await reRenderWithNewProviderIdentity();

    await screen.getByRole("button", { name: "Cancel" }).click();

    expect(log.invites).toEqual([]);
    expect(log.preflights).toEqual([8]);
  });
});

describe("a preview that can no longer be trusted blocks Confirm", () => {
  it("an expired snapshot is refused rather than silently replaced", async () => {
    const { log, screen } = await renderDialog({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect
      .element(screen.getByText(/This preview is out of date/))
      .toBeInTheDocument();
    await expect.element(confirmButton(screen)).toBeDisabled();
    // Refused, not refreshed: still exactly one preflight, nothing sent.
    expect(log.preflights).toEqual([8]);
    expect(log.invites).toEqual([]);
  });

  it("a preview for a different number is refused rather than silently replaced", async () => {
    const { log, screen, reRenderAskingFor } = await renderDialog({ count: 2 });
    await expect.element(confirmButton(screen)).toBeInTheDocument();

    await reRenderAskingFor(5);

    // It says which number it is for, and refuses — it does not quietly
    // run a preflight for 5 and present that as the approved list.
    await expect
      .element(screen.getByText(/This preview is for 2, not 5/))
      .toBeInTheDocument();
    await expect.element(confirmButton(screen)).toBeDisabled();
    expect(log.preflights).toEqual([8]);
    expect(log.invites).toEqual([]);
  });
});
