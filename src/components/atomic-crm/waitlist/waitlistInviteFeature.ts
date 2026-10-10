// The batch invitation UI, and why it is on.
//
// It shipped hidden. The invitation DOMAIN model was real and deployed —
// batches, per-person invitations, history, booking attribution — but there
// was no way to deliver one, so the UI would have read "these 37 people have
// been invited" while nothing reached anybody. That ambiguity was
// unacceptable in production and the action stayed behind this flag.
//
// A delivery mechanism now exists: the programme's own Kit tag, applied
// through the same durable outbox, with the same evidence, as every other
// tag this CRM sends. Nobody stops being Waiting until Kit confirms theirs.
// The condition this flag was written to wait for has been met, so it
// defaults to ON.
//
// It stays a flag rather than being deleted: a programme with no
// `waitlist_invited` mapping still cannot invite anybody, and setting
// VITE_ENABLE_WAITLIST_INVITE_DELIVERY=false is the one-line way to take the
// control off every waitlist at once if something about Kit goes wrong.
//
// The individual "Mark Invited" action is deliberately NOT gated: it means
// "Leif invited this person herself, outside the CRM", which records a real
// invitation with delivery_method 'manual'.
export const isBulkInviteDeliveryEnabled = (): boolean =>
  import.meta.env.VITE_ENABLE_WAITLIST_INVITE_DELIVERY !== "false";
