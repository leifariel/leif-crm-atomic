import { describe, expect, it, vi } from "vitest";
import type { DataProvider } from "ra-core";

import { nameSimilarity, nameTokens } from "./contactNameSimilarity";
import {
  addExistingContactToWaitlist,
  addNewPersonToWaitlist,
  lookUpWaitlistEmail,
  splitPersonName,
} from "./waitlistQuickCreate";
import type { Contact } from "../types";

const contact = (overrides: Partial<Contact> = {}): Contact =>
  ({
    id: 7,
    first_name: "Terra",
    last_name: "Israd",
    email_jsonb: [{ email: "terra.israd@example.com", type: "Work" }],
    sales_eligibility: "normal",
    ...overrides,
  }) as Contact;

// A provider that answers only what each test needs, so a test failing
// means the rule broke rather than an unrelated resource moved.
const providerFor = ({
  contacts = [],
  entries = [],
  onCreate,
}: {
  contacts?: Contact[];
  entries?: unknown[];
  onCreate?: (resource: string, params: { data: unknown }) => unknown;
} = {}): DataProvider =>
  ({
    getList: vi.fn(async (resource: string) =>
      resource === "contacts"
        ? { data: contacts, total: contacts.length }
        : { data: entries, total: entries.length },
    ),
    getOne: vi.fn(async (_resource: string, { id }: { id: unknown }) => ({
      data: contacts.find((c) => String(c.id) === String(id)) ?? contact(),
    })),
    create: vi.fn(async (resource: string, params: { data: unknown }) => ({
      data: onCreate
        ? onCreate(resource, params)
        : { id: 99, ...(params.data as object) },
    })),
  }) as unknown as DataProvider;

describe("splitPersonName", () => {
  it("keeps a single word as the first name rather than guessing a surname", () => {
    expect(splitPersonName("Madonna")).toEqual({
      firstName: "Madonna",
      lastName: "",
    });
  });

  it("treats everything after the first word as the last name", () => {
    expect(splitPersonName("  Mary Jane  Watson ")).toEqual({
      firstName: "Mary",
      lastName: "Jane Watson",
    });
  });

  it("returns empty parts for an empty string instead of inventing one", () => {
    expect(splitPersonName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("lookUpWaitlistEmail", () => {
  it("says nothing about anybody until the address is usable", async () => {
    const dataProvider = providerFor({ contacts: [contact()] });

    const result = await lookUpWaitlistEmail(dataProvider, {
      email: "terra.israd@",
      offerId: 1,
      cohortId: null,
    });

    expect(result).toEqual({ kind: "unusable" });
    // No read at all — an incomplete address is not a question.
    expect(dataProvider.getList).not.toHaveBeenCalled();
  });

  it("reports a free address when nobody owns it", async () => {
    const result = await lookUpWaitlistEmail(
      providerFor({ contacts: [contact()] }),
      { email: "someone.else@example.com", offerId: 1, cohortId: null },
    );

    expect(result.kind).toBe("free");
  });

  it("matches on the normalized address, so case and spacing are not identity", async () => {
    const result = await lookUpWaitlistEmail(
      providerFor({ contacts: [contact()] }),
      { email: "  Terra.Israd@Example.COM  ", offerId: 1, cohortId: null },
    );

    expect(result.kind).toBe("existing");
    if (result.kind !== "existing") return;
    expect(result.contact.id).toBe(7);
    expect(result.doNotEngage).toBe(false);
    expect(result.activeEntry).toBeNull();
  });

  it("reports Do Not Engage and an existing place together, not one at a time", async () => {
    const dne = contact({ sales_eligibility: "do_not_engage" });
    const dataProvider = providerFor({
      contacts: [dne],
      entries: [
        {
          id: 3,
          contact_id: 7,
          offer_id: 1,
          cohort_id: null,
          status: "waiting",
        },
      ],
    });
    // getOne is what the Do Not Engage authority reads.
    (dataProvider.getOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ...dne, sales_eligibility: "do_not_engage" },
    });

    const result = await lookUpWaitlistEmail(dataProvider, {
      email: "terra.israd@example.com",
      offerId: 1,
      cohortId: null,
    });

    expect(result.kind).toBe("existing");
    if (result.kind !== "existing") return;
    expect(result.doNotEngage).toBe(true);
    expect(result.activeEntry).not.toBeNull();
  });
});

describe("addNewPersonToWaitlist", () => {
  it("creates the Contact carrying its email, then the entry", async () => {
    const created: Array<{ resource: string; data: unknown }> = [];
    const dataProvider = providerFor({
      onCreate: (resource, params) => {
        created.push({ resource, data: params.data });
        return {
          id: resource === "contacts" ? 42 : 101,
          ...(params.data as object),
        };
      },
    });

    const result = await addNewPersonToWaitlist(dataProvider, {
      email: " brand.new@example.com ",
      name: "Brand New Person",
      offerId: 1,
      cohortId: null,
      salesId: 5,
    });

    expect(result.kind).toBe("added");
    expect(created.map((c) => c.resource)).toEqual([
      "contacts",
      "waitlist_entries",
    ]);
    // Never the empty email_jsonb the previous flow produced.
    expect(
      (created[0]!.data as { email_jsonb: { email: string }[] }).email_jsonb,
    ).toEqual([{ email: "brand.new@example.com", type: "Other" }]);
    const entry = created[1]!.data as Record<string, unknown>;
    expect(entry.contact_id).toBe(42);
    expect(entry.source).toBe("manual");
    expect(entry.status).toBe("waiting");
  });

  it("refuses rather than creating a second record for an address somebody owns", async () => {
    const dataProvider = providerFor({ contacts: [contact()] });

    const result = await addNewPersonToWaitlist(dataProvider, {
      email: "terra.israd@example.com",
      name: "Terra Israd",
      offerId: 1,
      cohortId: null,
    });

    expect(result.kind).toBe("email-taken");
    expect(dataProvider.create).not.toHaveBeenCalled();
  });

  it("reports a created Contact whose entry failed, instead of claiming nothing happened", async () => {
    const dataProvider = providerFor({
      onCreate: (resource, params) => {
        if (resource === "waitlist_entries") throw new Error("constraint");
        return { id: 42, ...(params.data as object) };
      },
    });

    const result = await addNewPersonToWaitlist(dataProvider, {
      email: "half.done@example.com",
      name: "Half Done",
      offerId: 1,
      cohortId: null,
    });

    // The person IS in the CRM. Saying otherwise would send Leif to
    // create them a second time.
    expect(result.kind).toBe("contact-created-entry-failed");
    if (result.kind !== "contact-created-entry-failed") return;
    expect(result.contact.id).toBe(42);
  });
});

describe("addExistingContactToWaitlist", () => {
  it("adds the person without touching their name", async () => {
    const dataProvider = providerFor({ contacts: [contact()] });

    const result = await addExistingContactToWaitlist(dataProvider, {
      contact: contact(),
      offerId: 1,
      cohortId: null,
    });

    expect(result.kind).toBe("added");
    // Exactly one write, and it is the entry — never an update to the
    // person. Choosing "Use this contact" means use them, not rename them
    // from whatever was typed in the Name field.
    expect(dataProvider.create).toHaveBeenCalledTimes(1);
    expect(dataProvider.create).toHaveBeenCalledWith(
      "waitlist_entries",
      expect.anything(),
    );
  });

  it("refuses a Do Not Engage person even though the card offered the button", async () => {
    const dataProvider = providerFor({ contacts: [contact()] });
    (dataProvider.getOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: contact({ sales_eligibility: "do_not_engage" }),
    });

    const result = await addExistingContactToWaitlist(dataProvider, {
      contact: contact(),
      offerId: 1,
      cohortId: null,
    });

    expect(result.kind).toBe("do-not-engage");
    expect(dataProvider.create).not.toHaveBeenCalled();
  });

  it("refuses a second active place for the same programme", async () => {
    const dataProvider = providerFor({
      contacts: [contact()],
      entries: [
        {
          id: 3,
          contact_id: 7,
          offer_id: 1,
          cohort_id: null,
          status: "waiting",
        },
      ],
    });

    const result = await addExistingContactToWaitlist(dataProvider, {
      contact: contact(),
      offerId: 1,
      cohortId: null,
    });

    expect(result.kind).toBe("already-waiting");
    expect(dataProvider.create).not.toHaveBeenCalled();
  });
});

describe("nameSimilarity", () => {
  it("ignores word order, because order is not evidence about identity", () => {
    expect(nameSimilarity("John Smith", "Smith John")).toBe(1);
  });

  it("stays high for a dropped middle name", () => {
    expect(nameSimilarity("John Smith", "John Robert Smith")).toBe(1);
  });

  it("stays high for a one-letter typo", () => {
    expect(nameSimilarity("Jon Smith", "John Smith")).toBeGreaterThan(0.8);
  });

  it("is low for two genuinely different people", () => {
    expect(nameSimilarity("John Smith", "Mariam Okonkwo")).toBeLessThan(0.5);
  });

  it("treats accents as the same letters", () => {
    expect(nameSimilarity("Renee Dupont", "Renée Dupont")).toBe(1);
  });

  it("scores nothing against an empty name rather than throwing", () => {
    expect(nameSimilarity("", "John Smith")).toBe(0);
  });
});

describe("nameTokens", () => {
  it("splits on anything that is not a letter or digit", () => {
    expect(nameTokens("Mary-Jane O'Brien")).toEqual([
      "mary",
      "jane",
      "o",
      "brien",
    ]);
  });
});
