import type { GetListParams, GetListResult, Identifier } from "ra-core";
import { describe, expect, it } from "vitest";

import {
  fetchAllPages,
  getManyInChunks,
  isTruncatedFirstPage,
} from "./fetchAllPages";

// THE SERVER DECIDES HOW MANY ROWS ONE RESPONSE HOLDS.
//
// Production's PostgREST returned 100 rows to a request for 1000, and the
// Pipeline showed "100 of 105". The earlier board test ran against a clean
// room capped at 1000, so it could never see that. This fake behaves like
// PostgREST does: it honours offset = (page - 1) * perPage, returns at most
// min(perPage, cap) rows, and reports the full count — exactly the contract
// ra-data-postgrest builds on.

type Row = { id: number; stage_entered_at: string };

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    // Ties on purpose: the 2026-09-17 imports share timestamps, and offset
    // paging over a non-unique key is how a row gets skipped or repeated.
    stage_entered_at: `2026-09-17T19:${String(Math.floor(i / 10)).padStart(2, "0")}:00Z`,
  }));

const cappedServer = (table: Row[], cap: number) => {
  const calls: Array<{ page: number; perPage: number; sort?: string }> = [];
  const getPage = async (
    params: GetListParams,
  ): Promise<GetListResult<Row>> => {
    const { page, perPage } = params.pagination!;
    calls.push({ page, perPage, sort: params.sort?.field });
    const sorted = [...table].sort((a, b) =>
      params.sort?.field === "id"
        ? a.id - b.id
        : a.stage_entered_at.localeCompare(b.stage_entered_at),
    );
    const offset = (page - 1) * perPage;
    return {
      data: sorted.slice(offset, offset + Math.min(perPage, cap)),
      total: table.length,
    };
  };
  return { getPage, calls };
};

const ask = (perPage = 1000): GetListParams => ({
  pagination: { page: 1, perPage },
  sort: { field: "stage_entered_at", order: "ASC" },
  filter: {},
});

const ids = (result: GetListResult<Row>) => result.data.map((r) => r.id);

describe("every row, whatever the server's cap", () => {
  it("A: 105 rows behind a 100-row cap come back as 105", async () => {
    const { getPage, calls } = cappedServer(rows(105), 100);
    const result = await fetchAllPages(getPage, ask());
    expect(result.total).toBe(105);
    expect(new Set(ids(result)).size).toBe(105);
    expect(calls).toHaveLength(2);
  });

  it("B: 205 rows take three pages, each row exactly once", async () => {
    const { getPage, calls } = cappedServer(rows(205), 100);
    const result = await fetchAllPages(getPage, ask());
    expect(ids(result)).toEqual(rows(205).map((r) => r.id));
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3]);
  });

  it("H: the final partial page is read and nothing past it", async () => {
    const { getPage, calls } = cappedServer(rows(201), 100);
    const result = await fetchAllPages(getPage, ask());
    expect(result.data).toHaveLength(201);
    expect(calls).toHaveLength(3);
  });

  it("learns the cap rather than assuming it, so offsets line up", async () => {
    // Asked for 1000, served 37 at a time.
    const { getPage, calls } = cappedServer(rows(105), 37);
    const result = await fetchAllPages(getPage, ask(1000));
    expect(ids(result)).toEqual(rows(105).map((r) => r.id));
    expect(calls.slice(1).every((c) => c.perPage === 37)).toBe(true);
  });

  it("I: pages are ordered by the primary key, never the tied display key", async () => {
    const { getPage, calls } = cappedServer(rows(205), 100);
    await fetchAllPages(getPage, ask());
    expect(calls.every((c) => c.sort === "id")).toBe(true);
  });

  it("I: a row that appears on two pages is kept once", async () => {
    const table = rows(150);
    let shifted = false;
    const getPage = async (
      params: GetListParams,
    ): Promise<GetListResult<Row>> => {
      const { page, perPage } = params.pagination!;
      const size = Math.min(perPage, 100);
      // A row inserted before page 2 was read shifts it back by one.
      const offset = (page - 1) * size - (page > 1 && !shifted ? 1 : 0);
      if (page > 1) shifted = true;
      return {
        data: table.slice(offset, offset + size),
        total: table.length,
      };
    };
    const result = await fetchAllPages(getPage, ask());
    expect(result.data).toHaveLength(150);
    expect(new Set(ids(result)).size).toBe(150);
  });

  it("no more than the server holds is ever requested", async () => {
    const { getPage, calls } = cappedServer(rows(100), 100);
    const result = await fetchAllPages(getPage, ask());
    expect(result.data).toHaveLength(100);
    expect(calls).toHaveLength(1);
  });

  it("an empty table is one request and no rows", async () => {
    const { getPage, calls } = cappedServer([], 100);
    const result = await fetchAllPages(getPage, ask());
    expect(result).toEqual({ data: [], total: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a server that stops answering cannot loop forever", async () => {
    // Claims 10,000 rows, then returns nothing after the first page.
    let n = 0;
    const getPage = async (): Promise<GetListResult<Row>> => {
      n += 1;
      return { data: n === 1 ? rows(100) : [], total: 10_000 };
    };
    const result = await fetchAllPages(getPage, ask());
    expect(result.data).toHaveLength(100);
    expect(result.total).toBe(10_000);
    expect(n).toBe(2);
  });

  it("a server that repeats the same page cannot loop forever", async () => {
    let n = 0;
    const getPage = async (): Promise<GetListResult<Row>> => {
      n += 1;
      return { data: rows(100), total: 10_000 };
    };
    const result = await fetchAllPages(getPage, ask());
    // Short of the count, and reported as such so the board can warn.
    expect(result.data.length).toBeLessThan(result.total!);
    expect(n).toBe(2);
  });

  it("keeps the caller's order when given a stable sort", async () => {
    const table = rows(205);
    const { getPage } = cappedServer(table, 100);
    // The fake orders by stage_entered_at unless asked for id; a stable
    // sort that is not "id" keeps that order across all three pages.
    const result = await fetchAllPages(getPage, ask(), (sort) => sort!);
    const entered = result.data.map((r) => r.stage_entered_at);
    expect(entered).toEqual([...entered].sort());
    expect(new Set(ids(result)).size).toBe(205);
  });
});

describe("getMany answers every id, whatever the server's cap", () => {
  // react-admin batches every card's ReferenceField into one getMany. A
  // 105-card board asks for 105 Contacts at once; a 100-row cap used to
  // leave five cards nameless.
  const cappedGetMany = (table: Row[], cap: number) => {
    const calls: number[] = [];
    const getMany = async (asked: Identifier[]) => {
      calls.push(asked.length);
      const wanted = new Set(asked.map(String));
      return {
        data: table.filter((r) => wanted.has(String(r.id))).slice(0, cap),
      };
    };
    return { getMany, calls };
  };

  it("105 ids behind a 100-row cap all come back", async () => {
    const table = rows(105);
    const { getMany } = cappedGetMany(table, 100);
    const { data } = await getManyInChunks(
      getMany,
      table.map((r) => r.id),
      500,
    );
    expect(data.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      table.map((r) => r.id),
    );
  });

  it("205 ids behind a 37-row cap all come back, once each", async () => {
    const table = rows(205);
    const { getMany } = cappedGetMany(table, 37);
    const { data } = await getManyInChunks(getMany, [
      ...table.map((r) => r.id),
      ...table.map((r) => r.id),
    ]);
    expect(new Set(data.map((r) => r.id)).size).toBe(205);
    expect(data).toHaveLength(205);
  });

  it("an id that does not exist is absent, and asked for a bounded number of times", async () => {
    const table = rows(10);
    const { getMany, calls } = cappedGetMany(table, 100);
    const { data } = await getManyInChunks(getMany, [1, 2, 999]);
    expect(data.map((r) => r.id)).toEqual([1, 2]);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("no ids is no request", async () => {
    const { getMany, calls } = cappedGetMany(rows(5), 100);
    expect(await getManyInChunks(getMany, [])).toEqual({ data: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("which reads the provider completes", () => {
  const result = (n: number, total: number) => ({
    data: rows(n),
    total,
  });

  it("a first page the cap cut short", () => {
    expect(isTruncatedFirstPage(ask(1000), result(100, 105))).toBe(true);
  });

  it("not a table smaller than the request", () => {
    expect(isTruncatedFirstPage(ask(1000), result(42, 42))).toBe(false);
  });

  it("not a full page of a larger table, which is ordinary paging", () => {
    expect(isTruncatedFirstPage(ask(25), result(25, 105))).toBe(false);
  });

  it("not a later page, which a paginated list asked for itself", () => {
    expect(
      isTruncatedFirstPage(
        { ...ask(1000), pagination: { page: 2, perPage: 1000 } },
        result(5, 1005),
      ),
    ).toBe(false);
  });

  it("not a reply that says nothing about its total", () => {
    expect(isTruncatedFirstPage(ask(1000), { data: rows(100) } as never)).toBe(
      false,
    );
  });
});
