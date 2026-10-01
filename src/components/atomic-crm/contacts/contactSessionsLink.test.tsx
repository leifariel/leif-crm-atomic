import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import type { ClientSession, Offer } from "../types";

// "Sessions · N" on the History card sent Leif to Not Found.
//
// It linked to /client-sessions?filter=… — a resource this app has never
// registered. The link was dead the day it was written (c84f19bf) and nothing
// tested it, which is why it survived to production: Denise Cormier has ten
// sessions, and clicking the count lost the page.
//
// ClientShow owns the real session workspace, but it is per-ENROLLMENT, and
// every production contact who has sessions has none — their appointments
// carry a null enrollment_id. So there is no client page to send anybody to,
// and the count opens a lightbox over the Contact instead.

const CONTACT_ID = 106;
const OFFER_ID = 1;

const OFFER: Offer = {
  id: OFFER_ID,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

// Denise's shape: booked sessions, and no enrollment at all.
const session = (
  id: number,
  over: Partial<ClientSession> = {},
): ClientSession =>
  ({
    id,
    contact_id: CONTACT_ID,
    enrollment_id: null,
    offer_id: OFFER_ID,
    status: "booked",
    scheduled_at: `2026-0${1 + (id % 9)}-15T17:00:00.000Z`,
    reschedule_count: 0,
    cancelled_at: null,
    no_show_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as unknown as ClientSession;

const build = (sessions: ClientSession[]) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({
          id: CONTACT_ID,
          first_name: "Denise",
          last_name: "Cormier",
        }),
      ],
      offers: [OFFER],
      deals: [],
      applications: [],
      enrollments: [],
      client_sessions: sessions,
      tasks: [],
      enrollment_onboarding_items: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return (
    <MemoryRouter initialEntries={[`/contacts/${CONTACT_ID}/show`]}>
      <CRM
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
        disableTelemetry
      />
    </MemoryRouter>
  );
};

const tenSessions = () => Array.from({ length: 10 }, (_, i) => session(i + 1));

describe("Sessions · N on the History card", () => {
  it("never navigates away, and never reaches Not Found", async () => {
    await page.viewport(1280, 1200);
    const screen = await render(build(tenSessions()));

    const control = screen.getByRole("button", { name: /Sessions · 10/ });
    await expect.element(control).toBeVisible();
    await control.click();

    const body = document.body.textContent ?? "";
    // The defect, named: this used to be a Link to a route that does not
    // exist, and the app answered with its Not Found page.
    expect(body).not.toMatch(/Not Found|not found/i);
    // Still on the Contact — a lightbox opened over it, nothing navigated.
    expect(body).toContain("Denise");
    await expect.element(screen.getByRole("dialog")).toBeVisible();
  });

  it("shows exactly the sessions the count counted", async () => {
    await page.viewport(1280, 1200);
    const screen = await render(build(tenSessions()));

    await screen.getByRole("button", { name: /Sessions · 10/ }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const rows = document
      .querySelector("[role='dialog']")
      ?.querySelectorAll("[data-session-row]");
    // The header's number and the list behind it come from one derivation,
    // so they cannot disagree.
    expect(rows?.length).toBe(10);
  });

  it("closes back to the Contact on Escape, with nothing navigated", async () => {
    await page.viewport(1280, 1200);
    const screen = await render(build(tenSessions()));

    await screen.getByRole("button", { name: /Sessions · 10/ }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    // Escape, the same way every other operational lightbox closes.
    await userEvent.keyboard("{Escape}");

    expect(document.body.textContent ?? "").toContain("Denise");
    expect(document.body.textContent ?? "").not.toMatch(/Not Found/i);
  });

  it("says what happened, not merely what was scheduled", async () => {
    await page.viewport(1280, 1200);
    const screen = await render(
      build([
        session(1),
        session(2, { no_show_at: "2026-03-15T18:00:00.000Z" }),
        session(3, { cancelled_at: "2026-04-15T18:00:00.000Z" }),
      ]),
    );

    await screen.getByRole("button", { name: /Sessions · 3/ }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const text = document.querySelector("[role='dialog']")?.textContent ?? "";
    expect(text).toContain("No-show");
    expect(text).toContain("Cancelled");
  });

  it("offers nothing to click when there are no sessions", async () => {
    await page.viewport(1280, 1200);
    const screen = await render(build([]));

    await expect.element(screen.getByText("History")).toBeVisible();
    const buttons = Array.from(document.body.querySelectorAll("button")).map(
      (node) => node.textContent?.trim(),
    );
    expect(buttons.some((label) => label?.startsWith("Sessions ·"))).toBe(
      false,
    );
  });

  it("no longer links to the route that never existed", async () => {
    await page.viewport(1280, 1200);
    await render(build(tenSessions()));

    const hrefs = Array.from(document.body.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs.some((href) => href?.includes("client-sessions"))).toBe(false);
  });
});
