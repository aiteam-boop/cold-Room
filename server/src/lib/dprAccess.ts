// Who may see the room-wise DPR.
//
// It is the owner's personal cockpit, not a grant-based page — access is limited
// to a specific list of accounts, NOT to every admin. The list is configurable
// so it never has to be a code change: set DPR_OWNER_EMAILS in the server env to
// a comma-separated list. Defaults to the single owner account.

const DEFAULT_OWNERS = ['admin@crmcts.dev'];

function ownerEmails(): string[] {
  const raw = process.env.DPR_OWNER_EMAILS;
  const list = raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_OWNERS;
  return list.length ? list : DEFAULT_OWNERS;
}

/** Is this account allowed to see the DPR? Matched on email, case-insensitive. */
export function isDprOwner(email: string | null | undefined): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}
