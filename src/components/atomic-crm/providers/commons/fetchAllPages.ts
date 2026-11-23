import type {
  GetListParams,
  GetListResult,
  Identifier,
  RaRecord,
  SortPayload,
} from "ra-core";

// EVERY ROW, WHATEVER THE SERVER'S PAGE CAP.
//
// THE DEFECT THIS EXISTS FOR (production, 2026-11-23). The Pipeline asked
// PostgREST for 1000 rows in one request and got 100 back: the hosted
// project's API "Max rows" is 100, not the 1000 in supabase/config.toml. So
// the board showed "100 of 105" — the truncation the earlier fix was meant
// to end. Raising perPage cannot work: the server, not the client, decides
// how many rows one response holds. 148 other reads in the app make the same
// assumption.
//
// So the invariant is enforced where every read passes — the Supabase data
// provider — not at each call site: a FIRST page that comes back short of
// both what it asked for and the server's own total was cut by the cap, and
// is completed page by page (isTruncatedFirstPage, fetchAllPages). A real
// last page, or a table smaller than the request, is never short in that
// sense and costs nothing extra. FakeRest never truncates, so it never pages.
//
//   - The page size is LEARNED from the first response, not assumed. Every
//     later page uses it, so offsets line up exactly.
//   - The caller's order is kept, with the primary key added as a tiebreak
//     (`stableSort`). Offset paging over a non-unique key — stage_entered_at;
//     the 2026-09-17 imports share timestamps — could skip or repeat a row at
//     a page edge.
//   - Rows are de-duplicated by id, in case the table moves between pages.
//   - It stops on the count, on an empty page, on a page that adds nothing,
//     or at a hard ceiling — never loops forever — and reports the server's
//     total, so a list that still comes back short says so
//     (PipelineTruncationNotice) rather than pretending.

/** A generous ceiling: 200 pages at a 100-row cap is 20,000 rows. */
const MAX_PAGES = 200;

/** Did the server cut a first page short of what was asked and what exists? */
export const isTruncatedFirstPage = (
  params: GetListParams,
  result: GetListResult,
): boolean => {
  const page = params.pagination?.page ?? 1;
  const perPage = params.pagination?.perPage;
  return (
    page === 1 &&
    perPage != null &&
    result.total != null &&
    result.data.length < perPage &&
    result.data.length < result.total
  );
};

export const fetchAllPages = async <T extends RaRecord>(
  getPage: (params: GetListParams) => Promise<GetListResult<T>>,
  params: GetListParams,
  /** The caller's sort, made unique (a primary-key tiebreak added). */
  stableSort: (sort: SortPayload | undefined) => SortPayload = () => ({
    field: "id",
    order: "ASC",
  }),
): Promise<GetListResult<T>> => {
  const requested = Math.max(1, params.pagination?.perPage ?? 1000);
  const base: GetListParams = { ...params, sort: stableSort(params.sort) };

  const first = await getPage({
    ...base,
    pagination: { page: 1, perPage: requested },
  });
  const total = first.total ?? first.data.length;
  const pageSize = first.data.length;

  // Insertion order is the server's order, so the caller's sort survives.
  const byId = new Map<string, T>();
  for (const row of first.data) byId.set(String(row.id), row);

  if (pageSize === 0 || byId.size >= total) {
    return { data: [...byId.values()], total };
  }

  for (let page = 2; byId.size < total && page <= MAX_PAGES; page++) {
    const next = await getPage({
      ...base,
      pagination: { page, perPage: pageSize },
    });
    if (next.data.length === 0) break;
    const before = byId.size;
    for (const row of next.data) byId.set(String(row.id), row);
    // A page that adds nothing new will not be followed by one that does.
    if (byId.size === before || next.data.length < pageSize) break;
  }

  return { data: [...byId.values()], total };
};

/**
 * getMany for any number of ids, whatever the server's page cap.
 *
 * react-admin batches every ReferenceField on a screen into ONE getMany —
 * `id=in.(...)` — so a board of 105 cards asks for 105 Contacts at once, and
 * a 100-row cap silently leaves five cards with no name. Ids are asked for
 * in chunks, and the ids a reply left out are asked for again — so the
 * answer is complete for ANY cap. It ends because every retry is strictly
 * smaller than the request before it, and a reply with no rows at all means
 * the ids left are genuinely absent, not capped.
 */
export const getManyInChunks = async <T extends RaRecord>(
  getMany: (ids: Identifier[]) => Promise<{ data: T[] }>,
  ids: Identifier[],
  chunkSize = 100,
): Promise<{ data: T[] }> => {
  const unique = [...new Map(ids.map((id) => [String(id), id])).values()];
  const found = new Map<string, T>();
  for (let i = 0; i < unique.length; i += chunkSize) {
    let pending = unique.slice(i, i + chunkSize);
    while (pending.length > 0) {
      const { data } = await getMany(pending);
      let added = 0;
      for (const row of data) {
        if (!found.has(String(row.id))) added += 1;
        found.set(String(row.id), row);
      }
      if (added === 0) break;
      pending = pending.filter((id) => !found.has(String(id)));
    }
  }
  return { data: [...found.values()] };
};
