import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { Notification } from "@/components/admin/notification";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { computeExpectedEnd } from "../capacity/sessionWeeks";
import { formatISODateString } from "../deals/dealUtils";
import type { Deal, Enrollment, Offer } from "../types";

// What a start week MEANS, said while Leif is choosing it.
//
// The modal put Start week and End side by side, and at this dialog width
// the End column collapsed until its own "mm/dd/yyyy" placeholder clipped
// its border. Worse than the clipping: two date inputs sharing a row
// implied they were the same kind of thing. They are not. A start week is
// a plan; enrollments.end_date is a fact about something that already
// happened, it outranks the calendar arithmetic entirely, and nothing in
// the app invents one.
//
// So the form is one field per row, the projection is read-only, and the
// actual end keeps its editor and says what it is for.
//
// The projection is NOT start + 12 calendar weeks. Leif takes weeks off,
// and the fixture below contains a gap on purpose: counting calendar weeks
// and counting eligible `1:1s` weeks give different answers, and only one
// of them is right.

const OFFER_ID = 1;
const ENROLLMENT_ID = 7;

const livingExample = {
  id: OFFER_ID,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 12,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const monday = (iso: string, plusWeeks: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusWeeks * 7);
  return d.toISOString().slice(0, 10);
};

// Weekly `1:1s` weeks from 5 Jan 2026, with weeks 10-13 missing: four
// consecutive weeks off, which is what makes "+12 weeks" wrong.
const SKIPPED = [10, 11, 12, 13];
const buildCalendar = (count: number) =>
  Array.from({ length: count }, (_, i) => i)
    .filter((i) => !SKIPPED.includes(i))
    .map((i) => {
      const start = monday("2026-01-05", i);
      const end = monday("2026-01-05", i);
      const endDate = new Date(`${end}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() + 5);
      return {
        start,
        end: endDate.toISOString().slice(0, 10),
        title: "1:1s",
      };
    });

const buildCrm = ({
  startDate = null,
  endDate = null,
  calendarWeeks = 40,
}: {
  startDate?: string | null;
  endDate?: string | null;
  calendarWeeks?: number;
} = {}) => {
  const weeks = buildCalendar(calendarWeeks);
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Nadia", last_name: "Okoro" }),
      ],
      offers: [livingExample],
      deals: [
        {
          id: 5,
          contact_id: 3,
          offer_id: OFFER_ID,
          name: "Nadia Okoro",
          stage: "won",
          offer_name_snapshot: "The Living Example",
          offer_price_snapshot: 4000,
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
      enrollments: [
        {
          id: ENROLLMENT_ID,
          opportunity_id: 5,
          status: "active",
          onboarding_tracking: "tracked",
          start_date: startDate,
          start_date_source: startDate ? "owner" : null,
          end_date: endDate,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Enrollment,
      ],
      expected_session_windows: weeks.map((w, i) => ({
        id: i + 1,
        offer_id: OFFER_ID,
        external_calendar_id: "year-tracking",
        external_event_id: `week-${i + 1}`,
        raw_title: w.title,
        window_start: w.start,
        window_end: w.end,
        deleted_at: null,
        synced_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      })),
      client_session_cadence_issues: [],
      waitlist_entries: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return {
    weeks,
    dataProvider,
    element: (
      <MemoryRouter initialEntries={[`/enrollments/${ENROLLMENT_ID}/edit`]}>
        <CRM
          dataProvider={dataProvider}
          authProvider={createTestAuthProvider()}
          i18nProvider={testI18nProvider}
          store={memoryStore()}
          disableTelemetry
          layout={({ children }) => (
            <>
              {children}
              <Notification />
            </>
          )}
        />
      </MemoryRouter>
    ),
  };
};

const field = (label: RegExp) => page.getByLabelText(label);

describe("the edit client form's shape", () => {
  it("gives each field its own row, so nothing is squeezed", async () => {
    // STRUCTURE, not pixels, and deliberately.
    //
    // vitest.config.ts gives the "app" project plugins: [react()] — no
    // tailwindcss() — so `@import "tailwindcss"` in index.css is never
    // processed and every utility class is INERT here. Measured: with the
    // stylesheet imported, this dialog's chain still computes
    // display:block for `grid` and `flex`, max-w-lg has no effect, and
    // the date input is 143px because that is its intrinsic size with no
    // CSS. Any width assertion in this environment would be measuring the
    // user agent, not the layout.
    //
    // So the geometry is proved where the real stylesheet is built — the
    // Golden Journey, against the production bundle, on desktop and on a
    // Pixel 5. What is asserted HERE is the thing that actually changed:
    // the two date inputs no longer share a row wrapper.
    await page.viewport(1280, 1000);
    const { element } = buildCrm({ startDate: "2026-01-05" });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const dialog = screen.getByRole("dialog").element() as HTMLElement;
    const dates = [...dialog.querySelectorAll('input[type="date"]')];
    expect(dates).toHaveLength(2);

    // Neither date input sits inside a horizontal row container. This is
    // the exact wrapper that was removed: className="flex flex-col
    // sm:flex-row gap-4" around the pair.
    for (const input of dates) {
      let node: HTMLElement | null = input.parentElement;
      while (node && node !== dialog) {
        expect(node.className).not.toMatch(/sm:flex-row/);
        node = node.parentElement;
      }
    }

    // And they are siblings in the form's single column, with the
    // projection rendered between them rather than beside anything.
    const form = dialog.querySelector("form")!;
    const order = [...form.children].map((child) =>
      child.querySelector('input[type="date"]')
        ? "date"
        : child.textContent?.includes("Projected final session week")
          ? "projection"
          : "other",
    );
    expect(order.indexOf("date")).toBeLessThan(order.indexOf("projection"));
    expect(order.indexOf("projection")).toBeLessThan(order.lastIndexOf("date"));
  });

  it("says what the actual end date is for, so it is not read as a plan", async () => {
    await page.viewport(1280, 1000);
    const { element } = buildCrm({ startDate: "2026-01-05" });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    await expect
      .element(screen.getByText("Actual end date").first())
      .toBeVisible();
    // The copy must not imply the projection becomes the end date. It does
    // not: enrollments.end_date is operational truth and nothing writes the
    // projection into it, so "leave it empty to use the projection above" —
    // which this said first — was false about the database it describes.
    await expect
      .element(
        screen.getByText("intentionally ending the enrollment", {
          exact: false,
        }),
      )
      .toBeVisible();
    expect(screen.container.textContent).not.toContain(
      "use the projection above",
    );
  });
});

describe("the projected final session week", () => {
  it("is not available until a start week is set", async () => {
    await page.viewport(1280, 1000);
    const { element } = buildCrm({ startDate: null });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    await expect
      .element(screen.getByText("Projected final session week"))
      .toBeVisible();
    await expect
      .element(screen.getByText("Not available until a start week is set"))
      .toBeVisible();
  });

  it("counts eligible session weeks, not calendar weeks", async () => {
    // The fixture has four consecutive weeks off. Starting on the first
    // week of the calendar, the twelfth ELIGIBLE week is four weeks later
    // than the twelfth calendar week — so these two answers differ, and
    // the one on screen has to be the eligible one.
    await page.viewport(1280, 1000);
    const { weeks, element } = buildCrm({ startDate: "2026-01-05" });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const expected = computeExpectedEnd(weeks, "2026-01-05", 0);
    expect(expected?.status).toBe("known");
    const projected =
      expected?.status === "known" ? expected.finalWeek.start : "";
    const naive = monday("2026-01-05", 11);
    expect(projected).not.toBe(naive);

    await expect
      .element(screen.getByText(formatISODateString(projected)))
      .toBeVisible();
    expect(screen.container.textContent).not.toContain(
      formatISODateString(naive),
    );
  });

  it("follows the start week as Leif changes it", async () => {
    await page.viewport(1280, 1000);
    const { weeks, element } = buildCrm({ startDate: "2026-01-05" });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const first = computeExpectedEnd(weeks, "2026-01-05", 0);
    const firstWeek = first?.status === "known" ? first.finalWeek.start : "";
    await expect
      .element(screen.getByText(formatISODateString(firstWeek)))
      .toBeVisible();

    // Move the start a week later and the answer moves with it, without
    // saving anything.
    const later = monday("2026-01-05", 1);
    await field(/^Start week/).fill(later);
    const second = computeExpectedEnd(weeks, later, 0);
    const secondWeek = second?.status === "known" ? second.finalWeek.start : "";
    expect(secondWeek).not.toBe(firstWeek);
    await expect
      .element(screen.getByText(formatISODateString(secondWeek)))
      .toBeVisible();
  });

  it("refuses to invent a date when the calendar runs out", async () => {
    // Eight eligible weeks, twelve needed.
    await page.viewport(1280, 1000);
    const { element } = buildCrm({
      startDate: "2026-01-05",
      calendarWeeks: 8,
    });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    await expect
      .element(screen.getByText("Can't calculate yet", { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText("calendar reaches", { exact: false }).first())
      .toBeVisible();
    // No date anywhere in the projection row.
    const body = screen.container.textContent ?? "";
    expect(body).not.toMatch(/Projected final session week\s*[A-Z][a-z]{2} \d/);
  });
});

describe("saving", () => {
  it("writes the start week and never the projection", async () => {
    await page.viewport(1280, 1000);
    const { dataProvider, element } = buildCrm({ startDate: null });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    await field(/^Start week/).fill("2026-01-05");
    await screen.getByRole("button", { name: "Save" }).click();
    await expect.element(screen.getByText("Client updated")).toBeVisible();

    const { data } = await dataProvider.getOne<Enrollment>("enrollments", {
      id: ENROLLMENT_ID,
    });
    expect(data.start_date).toBe("2026-01-05");
    expect(data.start_date_source).toBe("owner");
    // The projection is arithmetic, not a decision. end_date is somebody's
    // decision and stays exactly as it was.
    expect(data.end_date ?? null).toBeNull();
  });

  it("leaves a recorded actual end alone", async () => {
    await page.viewport(1280, 1000);
    const { dataProvider, element } = buildCrm({
      startDate: "2026-01-05",
      endDate: "2026-03-02",
    });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    await field(/^Start week/).fill(monday("2026-01-05", 1));
    await screen.getByRole("button", { name: "Save" }).click();
    await expect.element(screen.getByText("Client updated")).toBeVisible();

    const { data } = await dataProvider.getOne<Enrollment>("enrollments", {
      id: ENROLLMENT_ID,
    });
    expect(data.end_date).toBe("2026-03-02");
  });
});

describe("on a phone", () => {
  it("renders both date fields and the projection, stacked", async () => {
    // Again structure, not width — see the note above. The phone-width
    // geometry is measured in the Golden Journey's Pixel 5 run.
    await page.viewport(390, 844);
    const { element } = buildCrm({ startDate: "2026-01-05" });
    const screen = await render(element);
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const dialog = screen.getByRole("dialog").element() as HTMLElement;
    expect(dialog.querySelectorAll('input[type="date"]')).toHaveLength(2);
    for (const input of dialog.querySelectorAll('input[type="date"]')) {
      let node: HTMLElement | null = input.parentElement;
      while (node && node !== dialog) {
        expect(node.className).not.toMatch(/sm:flex-row/);
        node = node.parentElement;
      }
    }
    await expect
      .element(screen.getByText("Projected final session week"))
      .toBeVisible();
  });
});
