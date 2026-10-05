import type { DataProvider, Identifier } from "ra-core";

import type { Contact } from "../types";

// Name similarity is ADVISORY. It exists so Leif can notice "this might be
// the Terra Israd I already have" — never to block a save and never to
// merge anybody. Exact normalized email stays the only identity guard
// (waitlistContactEmail.ts): a handle or a name is not identity, and two
// real people genuinely share names.
//
// Why this is not a database query: there is no similarity index here, and
// adding one for an advisory hint would be the wrong trade. Instead the
// candidate set is narrowed SERVER side by the existing `q` full-text
// filter (one ILIKE per name token, see the contacts beforeGetList in the
// Supabase provider), and only those few rows are scored locally. So a
// batch of additions costs a small filtered read each, not a full-table
// scan per keystroke.

const MIN_TOKEN_LENGTH = 3;
const MAX_SUGGESTIONS = 3;
/** Below this, a "suggestion" is just noise with a number attached. */
const MIN_SCORE = 0.7;

export const nameTokens = (name: string): string[] =>
  name
    .toLowerCase()
    .normalize("NFD")
    // Strip diacritics so "Renée" and "Renee" are the same token.
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");

/** Levenshtein distance, iterative with a single row of state. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a === "") return b.length;
  if (b === "") return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }

  return previous[b.length];
};

/** 1 for identical, 0 for nothing in common. */
const tokenCloseness = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - editDistance(a, b) / longest;
};

/**
 * How much two names look like the same person, between 0 and 1.
 *
 * Every token of the shorter name is matched against its closest token in
 * the other, so "John Smith" and "Smith, John" score the same as "John
 * Smith" — word order is not evidence about identity. A name that is a
 * subset of a longer one ("John Smith" against "John Robert Smith") scores
 * high rather than being penalised for the words it does not have, because
 * people drop middle names constantly.
 */
export const nameSimilarity = (left: string, right: string): number => {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length === 0 || b.length === 0) return 0;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const total = shorter.reduce(
    (sum, token) =>
      sum + Math.max(...longer.map((other) => tokenCloseness(token, other))),
    0,
  );
  return total / shorter.length;
};

/**
 * Contacts whose name resembles this one, most alike first.
 *
 * Returns [] rather than throwing when the lookup fails: an advisory hint
 * that cannot load must never stop Leif adding somebody to a waitlist.
 */
export const findSimilarlyNamedContacts = async (
  dataProvider: DataProvider,
  {
    name,
    excludeContactId,
  }: { name: string; excludeContactId?: Identifier | null },
): Promise<Contact[]> => {
  const tokens = nameTokens(name).filter(
    (token) => token.length >= MIN_TOKEN_LENGTH,
  );
  if (tokens.length === 0) return [];

  try {
    const results = await Promise.all(
      tokens.map((token) =>
        dataProvider.getList<Contact>("contacts", {
          filter: { q: token },
          pagination: { page: 1, perPage: 20 },
          sort: { field: "last_name", order: "ASC" },
        }),
      ),
    );

    const candidates = new Map<string, Contact>();
    for (const result of results) {
      for (const contact of result.data) {
        if (
          excludeContactId != null &&
          String(contact.id) === String(excludeContactId)
        ) {
          continue;
        }
        candidates.set(String(contact.id), contact);
      }
    }

    return [...candidates.values()]
      .map((contact) => ({
        contact,
        score: nameSimilarity(
          name,
          `${contact.first_name ?? ""} ${contact.last_name ?? ""}`,
        ),
      }))
      .filter((scored) => scored.score >= MIN_SCORE)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_SUGGESTIONS)
      .map((scored) => scored.contact);
  } catch {
    return [];
  }
};
