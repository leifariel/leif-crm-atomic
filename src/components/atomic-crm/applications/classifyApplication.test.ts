import { describe, expect, it } from "vitest";

import {
  classifyApplication,
  hasLiveSalesProcess,
} from "./classifyApplication";

// The rules that decide where an Application appears, written from the
// production audit rather than from the shape of the old UI.
//
// The page used to ask `source` first: public_form meant review work,
// historical_import meant history. That put six January 2027 applications
// Leif needed to read into a Historical section. These pin the facts that
// actually decide it.

const app = (over: Parameters<typeof classifyApplication>[0]) => over;

const openCohort = { status: "applications_open" as const };
const closedCohort = { status: "applications_closed" as const };
const liveDeal = { stage: "decision", outcome: null, archived_at: null };
const wonDeal = { stage: "won", outcome: null, archived_at: null };
const lostDeal = {
  stage: "decision",
  outcome: "lost" as const,
  archived_at: null,
};

describe("what counts as a live sales process", () => {
  it("is live while it is still running", () => {
    expect(hasLiveSalesProcess(liveDeal)).toBe(true);
  });

  it("is not live once it is won — that conversation finished, in the best way", () => {
    expect(hasLiveSalesProcess(wonDeal)).toBe(false);
  });

  it("is not live once any outcome was recorded", () => {
    expect(hasLiveSalesProcess(lostDeal)).toBe(false);
  });

  it("is not live once it was archived", () => {
    expect(
      hasLiveSalesProcess({
        stage: "decision",
        outcome: null,
        archived_at: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("is not live when there is no Opportunity at all", () => {
    expect(hasLiveSalesProcess(null)).toBe(false);
    expect(hasLiveSalesProcess(undefined)).toBe(false);
  });
});

describe("January 2027 — the six that were buried", () => {
  it("counts an imported pending application to an OPEN cohort as review work", () => {
    // The audit case. Six of these sat in Historical because they arrived
    // by import; the cohort is still taking applications, so they are
    // live work whatever their provenance says.
    expect(
      classifyApplication(
        app({
          status: "pending",
          source: "historical_import",
          reviewed_at: null,
        }),
        { cohort: openCohort, deal: null },
      ),
    ).toBe("needs-review");
  });

  it("counts a public_form pending application as review work too", () => {
    expect(
      classifyApplication(
        app({ status: "pending", source: "public_form", reviewed_at: null }),
        { cohort: openCohort },
      ),
    ).toBe("needs-review");
  });

  it("does not promote an imported pending application to a CLOSED cohort", () => {
    // Same provenance, same status — the cohort is what differs, and a
    // closed cohort is not work waiting to be done.
    expect(
      classifyApplication(
        app({
          status: "pending",
          source: "historical_import",
          reviewed_at: null,
        }),
        { cohort: closedCohort, deal: null },
      ),
    ).toBe("historical");
  });
});

describe("what Reviewed means", () => {
  it("is reviewed_at, and only reviewed_at", () => {
    expect(
      classifyApplication(
        app({
          status: "approved",
          source: "public_form",
          reviewed_at: "2026-09-01T10:00:00.000Z",
        }),
      ),
    ).toBe("reviewed");
  });

  it("does NOT read an imported 'approved' with no reviewed_at as a modern review", () => {
    // 58 production rows look like this. The decision was real — made
    // outside this CRM, at an unknown moment — so it stays history rather
    // than joining a list that implies Leif worked through it here.
    expect(
      classifyApplication(
        app({
          status: "approved",
          source: "historical_import",
          reviewed_at: null,
        }),
        { deal: lostDeal },
      ),
    ).toBe("historical");
  });

  it("outranks everything else once a real review exists", () => {
    // Even with an open cohort and a live sale, a recorded decision wins.
    expect(
      classifyApplication(
        app({
          status: "pending",
          source: "historical_import",
          reviewed_at: "2026-09-01T10:00:00.000Z",
        }),
        { cohort: openCohort, deal: liveDeal },
      ),
    ).toBe("reviewed");
  });
});

describe("Pre-CRM — Active Sales", () => {
  it("holds an old questionnaire whose sales conversation is still open", () => {
    // The eleven Living Example records. Not review work — the old funnel
    // had no review step, so no decision is owed — and not history,
    // because the person is still in play.
    expect(
      classifyApplication(
        app({
          status: "pending",
          source: "historical_import",
          reviewed_at: null,
        }),
        { cohort: null, deal: liveDeal },
      ),
    ).toBe("pre-crm-active-sales");
  });

  it("holds an imported 'approved' whose sale is still running", () => {
    expect(
      classifyApplication(
        app({
          status: "approved",
          source: "historical_import",
          reviewed_at: null,
        }),
        { deal: liveDeal },
      ),
    ).toBe("pre-crm-active-sales");
  });

  it("becomes Historical once that sale concludes", () => {
    expect(
      classifyApplication(
        app({
          status: "pending",
          source: "historical_import",
          reviewed_at: null,
        }),
        { deal: wonDeal },
      ),
    ).toBe("historical");
  });

  it("never claims a live public_form application is pre-CRM", () => {
    expect(
      classifyApplication(
        app({ status: "pending", source: "public_form", reviewed_at: null }),
        { deal: liveDeal },
      ),
    ).toBe("needs-review");
  });
});

describe("Historical", () => {
  it("holds the old funnel, finished", () => {
    expect(
      classifyApplication(
        app({
          status: "denied",
          source: "historical_import",
          reviewed_at: null,
        }),
        { deal: null },
      ),
    ).toBe("historical");
  });

  it("holds an imported record with no Opportunity and no open cohort", () => {
    expect(
      classifyApplication(
        app({
          status: "waitlist",
          source: "historical_import",
          reviewed_at: null,
        }),
        { cohort: closedCohort, deal: null },
      ),
    ).toBe("historical");
  });
});

describe("manual — an Application Leif entered herself", () => {
  it("waits for her in the 1:1 programme, which has no cohort to be open", () => {
    // The rolling programme never has an open cohort to lean on, so a
    // manual record there has to stand on its own source. If it did not,
    // every Living Example application she typed in would land in
    // Historical the moment she saved it.
    expect(
      classifyApplication(
        app({ status: "pending", source: "manual", reviewed_at: null }),
        { cohort: null, deal: null },
      ),
    ).toBe("needs-review");
  });

  it("waits for her in a cohort still taking applications", () => {
    expect(
      classifyApplication(
        app({ status: "pending", source: "manual", reviewed_at: null }),
        { cohort: openCohort, deal: null },
      ),
    ).toBe("needs-review");
  });

  it("still waits for her when the cohort has closed", () => {
    // She created it just now. A closed cohort is a reason an IMPORTED
    // record is not work; it is not a reason to discard something she
    // deliberately entered — if the cohort is wrong, Correct Application
    // is how she says so.
    expect(
      classifyApplication(
        app({ status: "pending", source: "manual", reviewed_at: null }),
        { cohort: closedCohort, deal: null },
      ),
    ).toBe("needs-review");
  });

  it("needs no Opportunity to be review work", () => {
    // A manual Application creates no sales process, so the Deal-shaped
    // questions the old funnel needed do not apply to it at all. Neither
    // a missing Deal nor a live one changes where it belongs.
    expect(
      classifyApplication(
        app({ status: "pending", source: "manual", reviewed_at: null }),
        {},
      ),
    ).toBe("needs-review");
    expect(
      classifyApplication(
        app({ status: "pending", source: "manual", reviewed_at: null }),
        { deal: liveDeal },
      ),
    ).toBe("needs-review");
  });

  it("is never Pre-CRM, whatever the sale is doing", () => {
    // Pre-CRM means the record predates this CRM. A record she typed into
    // it cannot, so a decided manual application is plain history.
    expect(
      classifyApplication(
        app({ status: "denied", source: "manual", reviewed_at: null }),
        { deal: liveDeal },
      ),
    ).toBe("historical");
  });

  it("moves to Reviewed once she decides on it here", () => {
    expect(
      classifyApplication(
        app({
          status: "approved",
          source: "manual",
          reviewed_at: "2026-09-24T10:00:00.000Z",
        }),
        { cohort: openCohort },
      ),
    ).toBe("reviewed");
  });
});
