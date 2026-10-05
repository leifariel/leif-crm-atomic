import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  useDataProvider,
  useGetIdentity,
  useNotify,
  useRefresh,
  useTranslate,
  type Identifier,
} from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { Contact } from "../types";
import { contactDisplayNameOr } from "../contacts/contactDisplayName";
import { findSimilarlyNamedContacts } from "./contactNameSimilarity";
import { isPlausibleEmail, primaryEmail } from "./waitlistContactEmail";
import {
  addExistingContactToWaitlist,
  addNewPersonToWaitlist,
  lookUpWaitlistEmail,
  type WaitlistAddResult,
  type WaitlistEmailLookup,
} from "./waitlistQuickCreate";

// "+ Add to Waitlist" — email first, because the email IS the identity.
//
// The flow Leif actually performs: paste an address out of Instagram, Tab,
// type the name, add. Two fields, both required, nothing to search and
// nothing buried in a dropdown. The Offer (and the Cohort, when there is
// one) come from the page that opened this and are never asked again.
//
// An ACTIVE waitlist entry requires a contactable email — a place opening
// up is only worth holding for somebody who can be told. There is
// deliberately no "skip email" path: a person Leif has only a name for can
// exist as a Contact, which is a different act on a different page.
//
// Timing and notes are not asked here. They are still Waitlist Entry
// fields and still editable on the entry itself; asking for them in the
// quick-add would slow down the one thing this modal exists to make fast.
const nameOf = (contact: Contact): string =>
  contactDisplayNameOr(contact, primaryEmail(contact) || String(contact.id));

export const AddToWaitlistModal = ({
  open,
  onOpenChange,
  offerId,
  cohortId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offerId: Identifier;
  cohortId: Identifier | null;
}) => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const { identity } = useGetIdentity();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [lookup, setLookup] = useState<WaitlistEmailLookup | null>(null);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening starts clean, so a batch of people can go in one after
  // another without the previous one's details bleeding into the next.
  useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setLookup(null);
      setSuggestions([]);
      setSaving(false);
      setError(null);
    }
  }, [open]);

  // Which address the current lookup describes. Without this, editing the
  // email after a match would leave the previous person's card on screen
  // next to a different address.
  const lookedUp = useRef("");

  const runLookup = useCallback(
    async (value: string) => {
      const candidate = value.trim();
      if (!isPlausibleEmail(candidate)) {
        lookedUp.current = "";
        setLookup(null);
        return;
      }
      if (lookedUp.current === candidate) return;
      lookedUp.current = candidate;
      try {
        const result = await lookUpWaitlistEmail(dataProvider, {
          email: candidate,
          offerId,
          cohortId,
        });
        // Only apply it if the field still holds the address we asked
        // about — an answer about a previous value is worse than none.
        if (lookedUp.current === candidate) setLookup(result);
      } catch {
        lookedUp.current = "";
        setLookup(null);
      }
    },
    [dataProvider, offerId, cohortId],
  );

  // Advisory only, and only worth running when this address is nobody's
  // yet: once an exact email match exists, identity is already settled and
  // a list of similar names would just be noise.
  const runNameAdvisory = useCallback(
    async (value: string) => {
      if (lookup?.kind === "existing" || value.trim() === "") {
        setSuggestions([]);
        return;
      }
      setSuggestions(
        await findSimilarlyNamedContacts(dataProvider, { name: value }),
      );
    },
    [dataProvider, lookup],
  );

  const report = (result: WaitlistAddResult) => {
    switch (result.kind) {
      case "added":
        notify(
          translate("resources.waitlist_entries.quick_add.added", {
            _: "%{name} is on the waitlist.",
            name: nameOf(result.contact),
          }),
          { type: "info" },
        );
        refresh();
        onOpenChange(false);
        return;
      case "already-waiting":
        setError(
          translate("resources.waitlist_entries.quick_add.already_waiting", {
            _: "%{name} is already waiting for this one — nothing was added.",
            name: nameOf(result.contact),
          }),
        );
        return;
      case "do-not-engage":
        setError(
          translate("resources.waitlist_entries.quick_add.do_not_engage", {
            _: "%{name} is marked Do Not Engage, so they can't be added to a waitlist.",
            name: nameOf(result.contact),
          }),
        );
        return;
      case "email-taken":
        // Not an error so much as an answer: it is the same "existing
        // contact found" card, arrived at a moment later.
        setLookup({
          kind: "existing",
          contact: result.contact,
          doNotEngage: false,
          activeEntry: null,
        });
        lookedUp.current = email.trim();
        setSuggestions([]);
        setError(
          translate("resources.waitlist_entries.quick_add.email_taken", {
            _: "%{name} already has that email. Use their contact, or use a different address.",
            name: nameOf(result.contact),
          }),
        );
        return;
      case "contact-created-entry-failed":
        // The person IS in the CRM now. Saying "nothing happened" would
        // send Leif to create them a second time.
        setError(
          translate("resources.waitlist_entries.quick_add.half_done", {
            _: "%{name} was created as a contact, but adding them to the waitlist failed. They are not waiting yet.",
            name: nameOf(result.contact),
          }),
        );
        refresh();
        return;
    }
  };

  const guardedSave = async (run: () => Promise<WaitlistAddResult>) => {
    setSaving(true);
    setError(null);
    try {
      report(await run());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : translate("resources.waitlist_entries.quick_add.failed", {
              _: "That could not be saved just now. Nothing was changed.",
            }),
      );
    } finally {
      setSaving(false);
    }
  };

  const addTheExistingContact = (contact: Contact) =>
    guardedSave(() =>
      addExistingContactToWaitlist(dataProvider, {
        contact,
        offerId,
        cohortId,
      }),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;

    const trimmedEmail = email.trim();
    if (trimmedEmail === "") {
      setError(
        translate("resources.waitlist_entries.email.required", {
          _: "An email is needed so you can reach them about an opening.",
        }),
      );
      return;
    }
    if (!isPlausibleEmail(trimmedEmail)) {
      setError(
        translate("resources.waitlist_entries.email.invalid", {
          _: "That does not look like an email address.",
        }),
      );
      return;
    }

    // Make sure we are not about to create a second record for somebody
    // the CRM already has, in case the field was never blurred.
    await runLookup(trimmedEmail);

    if (name.trim() === "") {
      setError(
        translate("resources.waitlist_entries.quick_add.name_required", {
          _: "A name is needed — this is who you will be writing to.",
        }),
      );
      return;
    }

    await guardedSave(() =>
      addNewPersonToWaitlist(dataProvider, {
        email: trimmedEmail,
        name,
        offerId,
        cohortId,
        salesId: identity?.id,
      }),
    );
  };

  const existing = lookup?.kind === "existing" ? lookup : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate("resources.waitlist_entries.sheet.add", {
              _: "Add to Waitlist",
            })}
          </DialogTitle>
          <DialogDescription>
            {translate("resources.waitlist_entries.quick_add.help", {
              _: "An email is required so you can tell them when a place opens.",
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="waitlist-email">
              {translate("resources.waitlist_entries.email.label", {
                _: "Email",
              })}
            </Label>
            <Input
              id="waitlist-email"
              type="email"
              // The first thing the modal is for: a pasted address.
              autoFocus
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              onBlur={(event) => void runLookup(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="waitlist-name">
              {translate("resources.waitlist_entries.quick_add.name_label", {
                _: "Name",
              })}
            </Label>
            <Input
              id="waitlist-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              onBlur={(event) => void runNameAdvisory(event.target.value)}
            />
          </div>

          {existing && (
            <div className="rounded-md border px-3 py-2 flex flex-col gap-2">
              <p className="text-sm font-medium">
                {translate("resources.waitlist_entries.quick_add.found", {
                  _: "Existing contact found",
                })}
              </p>
              <div className="text-sm">
                <p>{nameOf(existing.contact)}</p>
                <p className="text-muted-foreground">
                  {primaryEmail(existing.contact)}
                </p>
              </div>
              {existing.doNotEngage ? (
                <p className="text-sm text-muted-foreground">
                  {translate(
                    "resources.waitlist_entries.quick_add.do_not_engage",
                    {
                      _: "%{name} is marked Do Not Engage, so they can't be added to a waitlist.",
                      name: nameOf(existing.contact),
                    },
                  )}
                </p>
              ) : existing.activeEntry ? (
                <p className="text-sm text-muted-foreground">
                  {translate(
                    "resources.waitlist_entries.quick_add.already_waiting",
                    {
                      _: "%{name} is already waiting for this one — nothing was added.",
                      name: nameOf(existing.contact),
                    },
                  )}
                </p>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="self-start"
                  disabled={saving}
                  onClick={() => void addTheExistingContact(existing.contact)}
                >
                  {translate("resources.waitlist_entries.quick_add.use", {
                    _: "Use this contact",
                  })}
                </Button>
              )}
            </div>
          )}

          {/* Advisory, never a gate. A shared name is not identity, and two
              people really are called the same thing. */}
          {!existing && suggestions.length > 0 && (
            <div className="text-sm text-muted-foreground flex flex-col gap-1">
              <p>
                {translate("resources.waitlist_entries.quick_add.similar", {
                  _: "Similar names already in the CRM — a different email means a different person unless you know otherwise:",
                })}
              </p>
              <ul className="list-disc pl-5">
                {suggestions.map((contact) => (
                  <li key={contact.id}>
                    {nameOf(contact)}
                    {primaryEmail(contact) ? ` — ${primaryEmail(contact)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={saving || existing != null}>
              {translate("resources.waitlist_entries.quick_add.submit", {
                _: "Add to waitlist",
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
