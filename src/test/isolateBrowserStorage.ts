import { beforeEach } from "vitest";

// Every browser test starts with empty storage.
//
// Vitest browser mode runs every test file in ONE browser context, on one
// origin, so localStorage is shared by all of them — and the app writes to
// it from three places (CRM.tsx's persisted query cache, and both
// authProviders). Nothing cleared it between files.
//
// That is the whole mechanism behind the capacity page's once-a-fortnight CI
// failure, and it was not a race. On a mobile-width viewport CRM.tsx renders
// MobileAdmin, which wraps Admin in a PersistQueryClientProvider backed by
// localStorage, with gcTime 24h and networkMode "offlineFirst". A file that
// mounted earlier persisted ITS fixture under REACT_QUERY_OFFLINE_CACHE;
// IndividualProgramPage.capacity then restored that cache, and "offlineFirst"
// answered useGetOne("offers", { id: 1 }) from it without asking the
// dataProvider at all.
//
// So the page rendered instantly — isPending false, no error, nothing
// missing — showing a DIFFERENT file's Offer 1, which is a group programme
// called "Growing Yourself Up" and has no max_active_clients. Hence
// "12 active" with no "/ 12", no availability line, and openings that
// "can't calculate": three failed assertions, one wrong record, and a page
// that from the outside looked like it had simply loaded slowly.
//
// Caught by adding the rendered text to that file's diagnostics: the
// programme's own name was the fingerprint.
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // A browser that refuses storage access is not a reason to fail every
    // test; the isolation simply cannot be worse than not having it.
  }
});
