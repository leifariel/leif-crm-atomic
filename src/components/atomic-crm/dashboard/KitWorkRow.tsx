import type { ReactNode } from "react";

// One entry in the Kit work list, whatever kind of work it is.
//
// Every row in this modal used to lay itself out independently: a flex
// container with `flex-wrap` and `justify-between`, which puts the button on
// the right when the text beside it is short and drops it to the left under
// the text when it is not. So Ruth's button sat right, Kseniya's and Kara's
// fell to the left because "Growing Yourself Up · January 2027 · Pending" is
// longer, and Carey's went back to the right. Nothing was wrong with any of
// it individually; it just looked like an accident, because it was one.
//
// A fixed two-column grid decides the layout once, for every row, from the
// container rather than from the text: detail on the left, action on the
// right, `minmax(0, 1fr) auto`. Below the small breakpoint every row stacks
// the same way with the action underneath — again for all rows at once, so
// they cannot disagree.
export const KitWorkRow = ({
  name,
  detail,
  tags,
  action,
}: {
  name: string;
  detail: ReactNode;
  // Required tags with their ✓ / ○ state. Absent for rows that are not about
  // a set of tags, such as a sync that failed.
  tags?: ReactNode;
  action: ReactNode;
}) => (
  <li
    data-kit-work-row=""
    className="grid grid-cols-1 items-start gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]"
  >
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm">{name}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
      {tags}
    </div>
    <div className="justify-self-start sm:justify-self-end">{action}</div>
  </li>
);

// The ✓ / ○ list, so "what is still owed" reads identically everywhere it
// appears — here and on the Application's own Kit strip.
export const KitWorkTags = ({
  tags,
}: {
  tags: ReadonlyArray<{ kitTagId: number; kitTagName: string; done: boolean }>;
}) => (
  <ul className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
    {tags.map((tag) => (
      <li key={tag.kitTagId}>
        {tag.done ? "✓" : "○"} {tag.kitTagName}
      </li>
    ))}
  </ul>
);
