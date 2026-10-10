import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CoreAdminContext } from "ra-core";
import { WaitlistSection } from "./WaitlistSection";
import { createDataProvider } from "../providers/fakerest/dataProvider";
import {
  createCrmDb,
  buildContact,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import type { WaitlistEntryRow } from "./useWaitlistEntries";

// Pre-Gmail safety: the bulk action prepares invitations but sends nothing.
// Until delivery exists, production must not offer an action whose plain
// meaning is "these people have been invited".

// Six people, so the list is collapsed to its three-row preview — which is
// the state Leif actually works in, and the state a selection has to
// survive.
const NAMES = [
  "Wren Halloway",
  "Rowan Vance",
  "Juno Albright",
  "Esme Carrow",
  "Fen Darrow",
  "Marlo Quist",
];
const rows: WaitlistEntryRow[] = NAMES.map(
  (name, index) =>
    ({
      entryId: index + 1,
      contactId: index + 1,
      name,
      email: `person${index + 1}@example.invalid`,
      status: "waiting",
      joinedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      cohortId: null,
    }) as WaitlistEntryRow,
);

const renderSection = async (enableBulkInvite?: boolean) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: NAMES.map((_, index) => buildContact({ id: index + 1 })),
      offers: [
        {
          id: 1,
          name: "The Living Example",
          type: "individual",
          duration: "4m",
          current_price: 4000,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      waitlist_entries: [],
      waitlist_invitation_batches: [],
      waitlist_invitations: [],
    } as any),
    silent: true,
    latency: 0,
  });

  await page.viewport(1280, 900);
  return render(
    <MemoryRouter>
      <CoreAdminContext
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
      >
        <WaitlistSection
          entries={rows}
          offerId={1}
          offerName="The Living Example"
          cohortId={null}
          {...(enableBulkInvite === undefined ? {} : { enableBulkInvite })}
        />
      </CoreAdminContext>
    </MemoryRouter>,
  );
};

// The flag now defaults ON, because the thing it was waiting for exists:
// a programme's Kit tag, delivered through the same outbox as every other
// tag. What the flag still buys is a way to take the control off every
// waitlist at once, which these tests hold it to.
describe("bulk invite gating", () => {
  it("offers no bulk invite action when delivery is switched off", async () => {
    const screen = await renderSection(false);

    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("Invite to apply");
    expect(text).not.toContain("Select all");
    // No selection affordance at all.
    expect(
      screen.container.ownerDocument.querySelectorAll('[role="checkbox"]')
        .length,
    ).toBe(0);
    // The waitlist itself still renders normally.
    expect(text).toContain("Wren Halloway");
  });

  it("offers the oldest-N batch, and says what will actually happen", async () => {
    const screen = await renderSection(true);

    // The ordinary batch: a number, and the server works out who.
    await expect
      .element(screen.getByLabelText("Invite oldest"))
      .toHaveValue(25);
    await screen
      .getByRole("button", { name: "Invite to apply" })
      .first()
      .click();

    const dialog =
      screen.container.ownerDocument.querySelector('[role="dialog"]')
        ?.textContent ?? "";
    // It names the tag that actually reaches the person, and it does not
    // claim anybody has stopped waiting.
    expect(dialog).toContain("Kit tag");
    expect(dialog).toContain("Nobody stops being Waiting until Kit confirms");
  });

  it("can invite a hand-picked selection instead", async () => {
    const screen = await renderSection(true);

    await screen.getByText("Select all").click();
    await expect
      .element(screen.getByRole("button", { name: /Invite selected to apply/ }))
      .toBeInTheDocument();
  });

  it("keeps a selection that the collapsed list cannot show", async () => {
    // THE TRAP THIS EXISTS FOR. The list shows three of six, and a
    // selection held by position — or rebuilt from the rendered rows —
    // would quietly shrink to whatever happened to be on screen. Leif
    // would then invite three people believing she had invited six.
    const screen = await renderSection(true);

    // Collapsed: three rows and a disclosure for the rest.
    await expect
      .element(screen.getByRole("button", { name: "3 more" }))
      .toBeInTheDocument();

    await screen.getByText("Select all").click();

    // All six are selected, while only three are rendered.
    await expect
      .element(
        screen.getByRole("button", { name: /Invite selected to apply · 6/ }),
      )
      .toBeInTheDocument();
    expect(
      screen.container.ownerDocument.querySelectorAll('[role="checkbox"]')
        .length,
    ).toBe(3);
  });
});
