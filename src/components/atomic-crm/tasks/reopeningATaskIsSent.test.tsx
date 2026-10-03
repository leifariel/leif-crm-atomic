import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CoreAdminContext, useUpdate } from "ra-core";

import { Notification } from "@/components/admin/notification";
import { createDataProvider } from "../providers/fakerest";
import { buildContact, createCrmDb } from "@/test/StoryWrapper";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import type { Task } from "../types";

// An undoable mutation is not a write. It is a queue entry.
//
// ra-core's undoable mode pushes the mutation onto
// UndoableMutationsContextProvider's queue, which drains only when a
// notification is displayed and then dismissed, and then only
// `if (undoable)` (notification.tsx). Two ways to lose a write follow, and
// this app had both:
//
//   1. raise a plain notify() over a queued mutation — it is popped by a
//      toast that does not know it is holding one, and discarded. That was
//      ClientEditModal, and it is why Todd Jacobsen's start week vanished.
//   2. raise NO notification at all — the mutation stays queued and is
//      never sent. That was Task.tsx's reopen path, whose onSuccess
//      returned before notifying.
//
// The first test here pins the mechanism, so nobody has to rediscover it.
// The second pins the repair.

const TASK_ID = 1;
const completed: Task = {
  id: TASK_ID,
  contact_id: 1,
  type: "other",
  text: "Plain task, already ticked",
  due_date: "2026-09-08",
  done_date: "2026-09-09T10:00:00.000Z",
  status: "completed",
  sales_id: 0,
} as Task;

const Reopen = ({ mode }: { mode: "undoable" | "pessimistic" }) => {
  const [update] = useUpdate();
  return (
    <button
      type="button"
      onClick={() =>
        update(
          "tasks",
          {
            id: TASK_ID,
            data: { done_date: null, status: "pending" },
            previousData: completed,
          },
          // Exactly Task.tsx's shape: an onSuccess that notifies nothing
          // on the reopen path.
          { mutationMode: mode, onSuccess: () => {} },
        )
      }
    >
      Reopen
    </button>
  );
};

const reopen = async (mode: "undoable" | "pessimistic") => {
  const base = createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: 1 })],
      tasks: [completed],
    } as never),
    silent: true,
  });
  const asked: string[] = [];
  const dataProvider = {
    ...base,
    update: async (resource: string, params: never) => {
      asked.push(resource);
      return base.update(resource, params);
    },
  };

  const screen = await render(
    <CoreAdminContext
      dataProvider={dataProvider as never}
      i18nProvider={testI18nProvider}
    >
      <Reopen mode={mode} />
      <Notification />
    </CoreAdminContext>,
  );
  await screen.getByRole("button", { name: "Reopen" }).click();
  // Well past ra-core's five-second undo window.
  await new Promise((resolve) => setTimeout(resolve, 7000));
  const { data } = await base.getOne<Task>("tasks", { id: TASK_ID });
  return { asked, task: data };
};

describe("an undoable mutation nobody notifies about", () => {
  it("is never sent at all", async () => {
    // Not slow. Not retried later. Never sent — and the box looked
    // un-ticked the whole time, because the optimistic patch is local.
    const { asked, task } = await reopen("undoable");

    expect(asked).toEqual([]);
    expect(task.status).toBe("completed");
    expect(task.done_date).not.toBeNull();
  });
});

describe("reopening a task", () => {
  it("asks the database, so the tick actually comes off", async () => {
    const { asked, task } = await reopen("pessimistic");

    expect(asked).toEqual(["tasks"]);
    expect(task.status).toBe("pending");
    expect(task.done_date).toBeNull();
  });
});
