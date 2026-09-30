import { useKitWorkQueue } from "./useKitWorkQueue";

// Whether Kit has anything to contribute to Needs Attention, and how many
// people are behind it.
//
// Two numbers that must never be added together: the heading counts ROWS of
// work, and Kit contributes exactly one however long its queue is. The row
// itself states the PEOPLE. Four applicants needing a tag is one thing on
// Leif's list, not four — that is the whole reason this is an aggregate
// rather than a Task each.
export const useKitNeedsAttentionCount = () => {
  const { isPending, count } = useKitWorkQueue();
  return { isPending, people: count, rows: count > 0 ? 1 : 0 };
};
