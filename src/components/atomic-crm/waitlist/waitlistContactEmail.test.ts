import { describe, expect, it, vi } from "vitest";
import type { DataProvider } from "ra-core";

import type { Contact } from "../types";
import {
  attachEmailToContact,
  checkEmailOwnership,
  contactHasEmail,
  isPlausibleEmail,
} from "./waitlistContactEmail";

// Leif's rule: an ACTIVE waitlist entry only means something if she can
// actually reach the person, so the Contact behind one has to have an
// email. These cover the two halves of honoring that — knowing when an
// address is genuinely missing, and refusing to guess when one already
// belongs to somebody else.

const contact = (over: Partial<Contact> = {}): Contact =>
  ({
    id: 1,
    first_name: "Ada",
    last_name: "Lovelace",
    email_jsonb: [],
    phone_jsonb: [],
    tags: [],
    sales_id: 0,
    sales_eligibility: "normal",
    ...over,
  }) as Contact;

const providerWith = (contacts: Contact[]) => {
  const update = vi.fn(async (_resource: string, _params: unknown) => ({
    data: contacts[0],
  }));
  return {
    update,
    provider: {
      getList: async () => ({ data: contacts, total: contacts.length }),
      update,
    } as unknown as DataProvider,
  };
};

describe("whether a person can actually be reached", () => {
  it("says no for a Contact with no addresses at all", () => {
    expect(contactHasEmail(contact({ email_jsonb: [] }))).toBe(false);
  });

  it("says no for a blank address, which is the same as not having one", () => {
    // A Contact carrying [{ email: "" }] is not contactable. Counting it
    // as having an email would admit exactly the unreachable entry the
    // rule exists to prevent.
    expect(
      contactHasEmail(
        contact({ email_jsonb: [{ email: "  ", type: "Work" }] }),
      ),
    ).toBe(false);
  });

  it("says yes once there is a real address", () => {
    expect(
      contactHasEmail(
        contact({ email_jsonb: [{ email: "ada@example.com", type: "Work" }] }),
      ),
    ).toBe(true);
  });

  it("treats a missing Contact as unreachable rather than throwing", () => {
    expect(contactHasEmail(null)).toBe(false);
    expect(contactHasEmail(undefined)).toBe(false);
  });
});

describe("what counts as an email address", () => {
  it("accepts ordinary addresses, including ones with punctuation", () => {
    expect(isPlausibleEmail("leif@leifariel.com")).toBe(true);
    expect(isPlausibleEmail("first.last+waitlist@sub.example.co.uk")).toBe(
      true,
    );
  });

  it("accepts an address the person typed with spaces around it", () => {
    expect(isPlausibleEmail("  leif@leifariel.com  ")).toBe(true);
  });

  it("rejects what is plainly not an address", () => {
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail("leif")).toBe(false);
    expect(isPlausibleEmail("leif@localhost")).toBe(false);
    expect(isPlausibleEmail("a b@example.com")).toBe(false);
  });
});

describe("who owns an email address", () => {
  it("is free when nobody has it", async () => {
    const { provider } = providerWith([
      contact({
        id: 1,
        email_jsonb: [{ email: "ada@example.com", type: "Work" }],
      }),
    ]);

    await expect(
      checkEmailOwnership(provider, "new@example.com", 2),
    ).resolves.toEqual({ status: "free" });
  });

  it("is already theirs when the same person has it, so re-saving is not an error", async () => {
    const { provider } = providerWith([
      contact({
        id: 7,
        email_jsonb: [{ email: "ada@example.com", type: "Work" }],
      }),
    ]);

    await expect(
      checkEmailOwnership(provider, "ada@example.com", 7),
    ).resolves.toEqual({ status: "already-theirs" });
  });

  it("names the other person when somebody else has it, and never merges them", async () => {
    // One person under two records, a typo, or a shared family inbox —
    // the CRM cannot tell which, so it hands the question back with the
    // other person named rather than choosing one.
    const { provider, update } = providerWith([
      contact({
        id: 3,
        first_name: "Sarah",
        last_name: "Jones",
        email_jsonb: [{ email: "sarah.jones@example.com", type: "Work" }],
      }),
    ]);

    const result = await checkEmailOwnership(
      provider,
      "sarah.jones@example.com",
      99,
    );

    expect(result.status).toBe("belongs-to-another");
    if (result.status === "belongs-to-another") {
      expect(result.owner.first_name).toBe("Sarah");
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("matches regardless of case or surrounding spaces", async () => {
    const { provider } = providerWith([
      contact({
        id: 3,
        email_jsonb: [{ email: "Sarah.Jones@Example.com", type: "Work" }],
      }),
    ]);

    const result = await checkEmailOwnership(
      provider,
      "  sarah.jones@example.COM  ",
      99,
    );

    expect(result.status).toBe("belongs-to-another");
  });
});

describe("putting the address on the Contact", () => {
  it("writes it trimmed, keeping the type the rest of the CRM uses", async () => {
    const target = contact({ id: 5, email_jsonb: [] });
    const { provider, update } = providerWith([target]);

    await attachEmailToContact(provider, target, "  Wilhelmina@Example.com  ");

    expect(update).toHaveBeenCalledWith("contacts", {
      id: 5,
      data: {
        email_jsonb: [{ email: "Wilhelmina@Example.com", type: "Other" }],
      },
      previousData: target,
    });
  });

  it("appends rather than replacing, so an address already on file survives", async () => {
    const target = contact({
      id: 5,
      email_jsonb: [{ email: "work@example.com", type: "Work" }],
    });
    const { provider, update } = providerWith([target]);

    await attachEmailToContact(provider, target, "home@example.com");

    const written = update.mock.calls[0]![1] as unknown as {
      data: { email_jsonb: { email: string }[] };
    };
    expect(written.data.email_jsonb.map((e) => e.email)).toEqual([
      "work@example.com",
      "home@example.com",
    ]);
  });

  it("does nothing when they already have that address, so saving twice adds one copy", async () => {
    const target = contact({
      id: 5,
      email_jsonb: [{ email: "ada@example.com", type: "Work" }],
    });
    const { provider, update } = providerWith([target]);

    await attachEmailToContact(provider, target, "ADA@example.com");

    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing for a blank address rather than writing an empty one", async () => {
    const target = contact({ id: 5, email_jsonb: [] });
    const { provider, update } = providerWith([target]);

    await attachEmailToContact(provider, target, "   ");

    expect(update).not.toHaveBeenCalled();
  });
});
