import { expect } from "vitest";
import type { Locator } from "@vitest/browser/context";

// Typing into a dialog that has only just opened.
//
// THE BUG THESE EXIST FOR. A Radix dialog moves focus into itself after it
// mounts — the quick-add modal's Email field carries `autoFocus`, and the
// edit dialog's content takes focus itself. A locator resolves as soon as
// its element EXISTS, which is earlier than that, so a `fill()` issued in
// between could have its keystrokes delivered to whatever held focus a
// moment before. The controlled input's `onChange` never fired, React
// state stayed empty, and the save had nothing to save: the dialog sat
// there with both fields blank and the test reported "no waitlist entry
// was created".
//
// It showed up as order-dependent flakiness — the race is won or lost on
// timing, so the same test passed inside a long suite and failed on its
// own. Five tests across two files, failing as far back as the commit
// already accepted in production.
//
// The repair is to wait for the thing that actually has to be true rather
// than for a length of time: focus has arrived inside the dialog, and the
// field really holds what was typed into it.

/**
 * The open dialog, once focus has actually moved inside it.
 *
 * `expect.poll` retries the condition, so this is a wait on real state —
 * never a sleep, and never a retry of the interaction itself.
 */
export const dialogReadyForTyping = async (screen: {
  getByRole: (role: string) => Locator;
}) => {
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .poll(() => {
      const element = dialog.query();
      return element != null && element.contains(document.activeElement);
    })
    .toBe(true);
  return dialog;
};

/**
 * Type into a field and confirm it took.
 *
 * The value assertion is the point: it fails loudly at the moment the
 * keystrokes go missing, instead of letting the test run on and blame
 * whatever did not get saved three steps later.
 *
 * `expected` is for the two fields whose own input type normalises what
 * was typed — an `email` input strips surrounding whitespace, a `number`
 * input holds a number — where asserting the raw string would be
 * asserting something untrue about the browser rather than about the app.
 */
export const typeInto = async (
  field: Locator,
  value: string,
  expected: string | number = value,
) => {
  await field.click();
  await field.fill(value);
  await expect.element(field).toHaveValue(expected);
};
