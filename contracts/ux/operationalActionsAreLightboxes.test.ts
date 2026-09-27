import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// AGENTS.md -> Operational UX conventions, held to by the files that implement
// it. A bounded operational action asked from a page opens over that page; the
// route that exists for direct links is a thin wrapper around the same
// component, never a second implementation; and the copy in front of a decision
// says what will happen rather than how it is stored.

const read = (path: string) => readFileSync(path, "utf8");

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)(--|\/\/).*$/, ""))
    .join("\n");

const AGENTS = read("AGENTS.md");
const TASK_ROW = read("src/components/atomic-crm/tasks/Task.tsx");
const SALES_MODAL = read(
  "src/components/atomic-crm/sales-calls/SalesCallResolutionModal.tsx",
);
const SALES_ROUTE = read(
  "src/components/atomic-crm/sales-calls/ResolveSalesCallPage.tsx",
);
const REPAIR = read(
  "src/components/atomic-crm/enrollments/RepairOnboardingAction.tsx",
);
const TRIGGERS = read("supabase/schemas/04_triggers.sql");
const FUNCTIONS = read("supabase/schemas/02_functions.sql");

describe("the rule is written down", () => {
  test("AGENTS.md states it, with both examples", () => {
    expect(AGENTS).toMatch(/### Operational UX conventions/);
    expect(AGENTS).toMatch(/Answer first, mechanism second/);
    expect(AGENTS).toMatch(/thin wrapper around the same modal component/);
    expect(AGENTS).toMatch(/SalesCallResolutionModal\.tsx/);
    expect(AGENTS).toMatch(/CadenceResolutionModal\.tsx/);
  });
});

describe("matching a booking opens over the page it was asked from", () => {
  test("the Task row opens the modal instead of linking away", () => {
    const row = code(TASK_ROW);
    expect(row).toMatch(/SalesCallResolutionModal/);
    expect(row).toMatch(/destination\?\.kind === "sales-call-needs-matching"/);

    // It is handled BEFORE the branch that renders a Link, so a matching Task
    // can never fall through to navigation.
    const modalBranch = row.indexOf(
      'destination?.kind === "sales-call-needs-matching"',
    );
    const linkBranch = row.indexOf(
      'if (destination && destination.kind !== "task-detail")',
    );
    expect(modalBranch).toBeGreaterThan(-1);
    expect(linkBranch).toBeGreaterThan(-1);
    expect(modalBranch).toBeLessThan(linkBranch);

    // And the ⋮ menu's Edit opens the same modal rather than navigating: the
    // navigate() branch is for the two kinds that are genuinely their own
    // destination, and this one is not among them.
    const navigateAt = row.indexOf("navigate(destination.to)");
    const menuNavigate = row.slice(
      row.lastIndexOf("if (", navigateAt),
      navigateAt,
    );
    expect(menuNavigate).toMatch(/resolve-sales-call/);
    expect(menuNavigate).toMatch(/resolve-client-session-cadence/);
    expect(menuNavigate).not.toMatch(/sales-call-needs-matching/);
    expect(row).toMatch(
      /sales-call-needs-matching"\) \{\s*setResolvingSalesCall\(destination\.salesCallId\)/,
    );
  });

  test("the route is a thin wrapper around that same component", () => {
    expect(code(SALES_ROUTE)).toMatch(/SalesCallResolutionModal/);
    expect(code(SALES_ROUTE)).toMatch(/navigate\(-1\)/);
    expect(code(SALES_ROUTE)).toMatch(
      /ResolveSalesCallPage\.path = "\/sales-calls\/:id\/resolve"/,
    );
    // One implementation: the workflow's own logic lives in the modal, and the
    // route file is short enough that it cannot be holding a copy of it.
    expect(SALES_ROUTE.split("\n").length).toBeLessThan(40);
    expect(code(SALES_ROUTE)).not.toMatch(/attachSalesCallToOpportunity/);
    expect(code(SALES_MODAL)).toMatch(/attachSalesCallToOpportunity/);
  });

  test("the modal is a Dialog, closing through the primitive's own handler", () => {
    expect(code(SALES_MODAL)).toMatch(/<Dialog open onOpenChange=/);
    expect(code(SALES_MODAL)).toMatch(/DialogTitle/);
  });
});

describe("a stale onboarding says so in a card, and asks in a modal", () => {
  test("the warning is a card with an action, not a naked link", () => {
    const repair = code(REPAIR);
    expect(repair).toMatch(/<Card>/);
    expect(repair).toMatch(/Onboarding needs repair/);
    expect(repair).toMatch(/<Dialog/);
    // The action is a real button, never a link styled as text.
    expect(repair).not.toMatch(/variant="link"/);
  });

  test("it renders nothing at all for an aligned or finished client", () => {
    const repair = code(REPAIR);
    expect(repair).toMatch(
      /if \(onboardingMatchesOffer\([\s\S]{0,60}\)\) return null;/,
    );
    expect(repair).toMatch(
      /TERMINAL\.includes\(enrollment\.status\)\) return null;/,
    );
  });

  test("the copy says what will happen, not how it is stored", () => {
    const repair = REPAIR;
    // The operator-facing strings, as they are written.
    expect(repair).toMatch(/Onboarding repaired/);
    expect(repair).toMatch(/Suggested from the current onboarding setup\./);
    expect(repair).toMatch(/from current onboarding/);
    // And none of the mechanism that used to be on the page.
    for (const forbidden of [
      "leave the programme on the Opportunity exactly as it is",
      "projection",
      "Proposed because its setup is the one on file",
      "this is recorded as their history",
    ]) {
      expect(repair).not.toContain(forbidden);
    }
  });
});

describe("the matching Task lifecycle invariant", () => {
  test("attaching a booking closes its matching Task, in the database", () => {
    expect(TRIGGERS).toMatch(
      /CREATE TRIGGER complete_sales_call_matching_task_trigger AFTER UPDATE OF opportunity_id ON public\.sales_calls/,
    );
    const fn = FUNCTIONS.slice(
      FUNCTIONS.indexOf("FUNCTION public.complete_sales_call_matching_task()"),
    ).slice(0, 1200);
    // Only the NULL -> attached transition, and only the still-open Tasks.
    expect(fn).toMatch(
      /old\.opportunity_id is not null or new\.opportunity_id is null/,
    );
    expect(fn).toMatch(/type = 'sales_call_needs_matching'/);
    expect(fn).toMatch(/done_date is null/);
    expect(fn).toMatch(/status\s*= 'completed'/);
  });
});
