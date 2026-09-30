// ── API realms & scopes ───────────────────────────────────────────────────────
// Two independent layers control exposure:
//   • REALMS decide WHICH endpoints a key may call (requireRealm, a hard 403).
//   • SCOPES decide WHICH fields come back, by FIELD NAME (applyScopes, silent
//     omission). The field name IS the security boundary: any field whose name
//     is not classified below will SHIP under read:core — so when you add a field
//     to a response you must classify it, and the leak test (see
//     unclassifiedSensitiveKeys) fails if a sensitive-looking name is unclassified.

export type RealmKey = 'projects' | 'procurement' | 'timeline' | 'finance' | 'vendors' | 'approvals' | 'travel';
export type ScopeKey = 'read:core' | 'read:money' | 'read:parties' | 'read:people' | 'read:files' | 'write:tasks';

export const REALMS: { key: RealmKey; label: string; desc: string; requiresScope?: ScopeKey }[] = [
  { key: 'projects',    label: 'Projects',    desc: 'Projects, team, rooms/zones, milestones, drawings, change orders.' },
  { key: 'procurement', label: 'Procurement', desc: 'Purchase & work orders, GRNs, BOQ, quotations, documents, payment milestones.' },
  { key: 'timeline',    label: 'Timeline',    desc: 'Gantt activities, BOQ progress entries, daily progress (DPR). Task writes need write:tasks.' },
  { key: 'approvals',   label: 'Approvals',   desc: 'Who has to approve what, right now — per person. The pending queue for POs, WOs, GRNs, payments, travel & advances.' },
  { key: 'travel',      label: 'Travel & Advances', desc: 'Travel plans, day-wise expense claims + approval chain, ticket requests, and New-Advance disbursements + FMS status.' },
  { key: 'finance',     label: 'Finance',     desc: 'Vendor payments (FMS), deposits — amounts, status, paid dates.', requiresScope: 'read:money' },
  { key: 'vendors',     label: 'Vendors',     desc: 'The vendor master — names, GSTIN/PAN, contacts.', requiresScope: 'read:parties' },
];

export const SCOPES: { key: ScopeKey; label: string; desc: string; always?: boolean; write?: boolean }[] = [
  { key: 'read:core',    label: 'read:core',    desc: 'Identifiers, numbers, descriptions, quantities, statuses, dates.', always: true },
  { key: 'read:money',   label: 'read:money',   desc: 'Amounts, prices, budgets, invoice values, payment amounts, UTRs.' },
  { key: 'read:parties', label: 'read:parties', desc: 'Vendor / client names, contacts, addresses, GSTIN & PAN.' },
  { key: 'read:people',  label: 'read:people',  desc: 'Employee / responsible-person identities and personal fields.' },
  { key: 'read:files',   label: 'read:files',   desc: 'File URLs — drawings, invoices, photos, PDFs.' },
  { key: 'write:tasks',  label: 'write:tasks',  desc: 'Update Gantt tasks (start / progress / complete). Needs the timeline realm.', write: true },
];

export const REALM_KEYS = REALMS.map((r) => r.key);
export const SCOPE_KEYS = SCOPES.map((s) => s.key);

// ── Field-name classification (the redaction boundary) ────────────────────────
// Exact field names, matched case-insensitively. Anything here needs its scope;
// anything not here (and not sensitive-looking) ships as core.
const MONEY = new Set([
  'basicamount', 'finalamount', 'invoicevalue', 'amount', 'amounttopay', 'fullamount', 'balance',
  'unitprice', 'price', 'rate', 'tds', 'tdsamount', 'utr', 'utrnumber', 'paymentreference',
  'budget', 'budgetamount', 'budgetrate', 'budgetqty', 'pivalue', 'gstpct', 'gstamount', 'value', 'total',
  'costimpact', 'inramount', 'paymentterms',
  // Travel / advance / deposit money.
  'totaladvance', 'personadvance', 'effectiveadvance', 'ticketprice', 'sanctionedfare', 'sanctionedamount',
  'accountspayamount', 'advancesettledamount', 'actualspent', 'approvedamount', 'amountreceived',
  'vrno', 'vrnumber', 'dailycap', 'entitledperday', 'entitledtotal', 'perdaycap',
]);
const PARTY = new Set([
  'client', 'clientname', 'vendor', 'vendorname', 'contact', 'contactperson', 'phone', 'phones',
  'email', 'address', 'siteaddress', 'gstin', 'pan',
]);
const PEOPLE = new Set([
  'responsible', 'responsiblename', 'responsibleuserid', 'responsibleemail', 'responsibleemployeecode',
  'approver', 'approvername', 'approveruserid', 'approveremail', 'approveremployeecode',
  'submittedbyname', 'approvedbyname', 'uploadedbyname', 'handoverbyname', 'raisedbyname',
  'employeename', 'employeecode', 'filledbyname', 'labourteam',
  'perdiem', 'allowance', 'slab', 'drivername',
  // Travel / advance people identities.
  'technician', 'personname', 'reviewername', 'finalname', 'stage3name', 'techapprovedby',
  'advancesettledby', 'recordedbyname', 'settledby',
  // Resolved-person block (matchPerson): the identity is people; `matching`/`ambiguous` are core labels.
  'personuserid', 'personemail',
]);
const FILES = new Set([
  'pdfurl', 'invoicepdfurl', 'taxinvoicepdfurl', 'pipdfurl', 'kycpdfurl', 'tdsurl', 'drawingurl',
  'photourl', 'fileurl', 'url', 'paymentproofurl', 'packinglisturl',
  'quotationpdfurl', 'handovercerturl',
]);
// Always stripped, under every scope — never exposed via the public API.
const HARD_DENY = new Set([
  'aadhaar', 'aadhar', 'aadharno', 'aadharnumber', 'aadharfileurl', 'nationalid', 'dob', 'dateofbirth', 'password', 'passwordhash',
  'keyhash', 'secret', 'token', 'apikey', 'embedding', 'vector', 'ip', 'ipaddress', 'before', 'after', 'sig',
]);

const CLASS_SCOPE: [Set<string>, ScopeKey][] = [
  [MONEY, 'read:money'], [PARTY, 'read:parties'], [PEOPLE, 'read:people'], [FILES, 'read:files'],
];

// Returns the scope a field NAME needs, 'deny' if hard-denied, or null for core.
export function classifyField(name: string): ScopeKey | 'deny' | null {
  const n = name.toLowerCase();
  if (HARD_DENY.has(n)) return 'deny';
  for (const [set, scope] of CLASS_SCOPE) if (set.has(n)) return scope;
  return null;
}

/** Recursively strip every field the key's scopes don't cover (and every
 *  hard-denied field, always). Mutates a copy; returns it plus the set of
 *  withheld field names for `_meta.withheld`. Omit-don't-error: a narrower key
 *  gets a thinner object, never a 403. */
export function applyScopes<T>(payload: T, scopes: string[]): { data: T; withheld: string[] } {
  const withheld = new Set<string>();
  const walk = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object' && !(val instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const cls = classifyField(k);
        if (cls === 'deny') { withheld.add(k); continue; }
        if (cls && !scopes.includes(cls)) { withheld.add(k); continue; }
        out[k] = walk(v);
      }
      return out;
    }
    return val;
  };
  return { data: walk(payload) as T, withheld: [...withheld] };
}

// ── Leak test support ─────────────────────────────────────────────────────────
// A name that "looks sensitive" but is classified by NO rule is a leak: it would
// ship under read:core. The leak test walks real responses and fails if any such
// key exists, forcing every new field to be classified.
const SENSITIVE_LOOKING = /(amount|price|rate|cost|salary|wage|gst|pan|aadhaar|aadhar|dob|email|phone|mobile|password|passwd|token|secret|utr|ifsc|account|balance|budget|allowance|perdiem|address)/i;
export function unclassifiedSensitiveKeys(payload: unknown, found = new Set<string>()): string[] {
  const walk = (val: unknown) => {
    if (Array.isArray(val)) { val.forEach(walk); return; }
    if (val && typeof val === 'object' && !(val instanceof Date)) {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (SENSITIVE_LOOKING.test(k) && classifyField(k) === null) found.add(k);
        walk(v);
      }
    }
  };
  walk(payload);
  return [...found];
}
