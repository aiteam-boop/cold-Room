// ── Technician Cash in Hand — derived, read-only ledger ──────────────────────
// "Who is holding company money right now?" Answered without a new collection:
// derived live from the source documents (TravelPlan advances + tech-entry spend,
// and Petty Cash "Advance to Technician" + person-tagged top-ups), so it can never
// drift out of sync. Mirrors the Spares-AI cash-in-hand model.
//
//   IN HAND = Σ advances received  −  Σ spend accounted for
//     > 0  the technician still holds company cash (unreconciled float)
//     < 0  the company owes the technician (they overspent)
//
// IDENTITY: CRMCTS links both sides to a real User id — TravelPlan.employeeId and
// PettyCashEntry.personId — so we group by id (no name-matching needed). Legacy
// petty rows that pre-date the person dropdown carry only a typed name; those fall
// back to a name key so they still surface (the admin re-picks them to link).
import { prisma } from '../lib/prisma';

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round2 = (v: number): number => Math.round(v * 100) / 100;
const nameKey = (s: unknown): string => `name:${String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
const parse = <T,>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) as T : fb; } catch { return fb; } };
const PETTY_ADVANCE_CAT = 'Advance to Technician';

// Sum the numeric cost fields of a costs object / day row (ignores day/date/notes).
const SKIP = new Set(['day', 'date', 'notes', 'remark', 'jobordernos']);
const sumCosts = (obj: any): number => {
  if (!obj || typeof obj !== 'object') return 0;
  let t = 0;
  for (const [k, v] of Object.entries(obj)) { if (SKIP.has(k.toLowerCase())) continue; const x = Number(v); if (Number.isFinite(x)) t += x; }
  return t;
};
const sumDays = (days: any[]): number => (Array.isArray(days) ? days.reduce((s, d) => s + sumCosts(d), 0) : 0);

export type CashEventKind = 'advance' | 'expense' | 'settlement' | 'company_paid';
export interface CashEvent {
  at: string | null;
  kind: CashEventKind;
  delta: number;      // signed effect on in-hand (0 for informational rows)
  amount: number;     // absolute figure, for display
  title: string;
  detail: string;
  source: 'travel' | 'petty';
  refNo: string;
  settled: boolean;
  balance: number;    // running in-hand after this event
}

export interface CashSummary {
  personKey: string;      // User id, or name:<key> for unlinked legacy rows
  personId: string | null;
  name: string;
  received: number;       // Σ advances handed over
  spent: number;          // Σ spend accounted for
  inHand: number;         // received − spent
  pendingApproval: number;// claimed but not yet approved (in-hand provisional)
  unsettled: number;      // advance money not yet ticked off by accounts
  entries: number;        // source docs touching this person
  lastActivityAt: string | null;
  linked: boolean;        // false = legacy name-only row (no email / no weekly-mail target)
}

interface Loaded { plans: any[]; petty: any[]; nameById: Map<string, string>; }

async function load(): Promise<Loaded> {
  const [plans, petty, users] = await Promise.all([
    prisma.travelPlan.findMany({}),
    prisma.pettyCashEntry.findMany({}),
    prisma.user.findMany({ select: { id: true, name: true } }),
  ]);
  const nameById = new Map<string, string>(users.map((u) => [u.id, u.name]));
  return { plans, petty, nameById };
}

// Build the signed events for one person's group, given the docs already filtered.
function eventsFor(plans: any[], petty: any[]): CashEvent[] {
  const events: CashEvent[] = [];

  for (const p of plans) {
    const adv = num(p.totalAdvance) || parse<any[]>(p.advances, []).reduce((s, a) => s + num(a?.amount), 0);
    if (adv > 0) {
      events.push({
        at: iso(p.fromDate) || iso(p.createdAt), kind: 'advance', delta: adv, amount: adv,
        title: `Travel advance — ${p.planNumber || 'plan'}`,
        detail: p.advanceSettled ? 'Advance settled by accounts' : 'Advance disbursed for the trip',
        source: 'travel', refNo: p.planNumber || '', settled: !!p.advanceSettled, balance: 0,
      });
    }
    // The trip's approved figure (once signed off) or the claimed figure (pending).
    const approved = p.techEntryStatus === 'APPROVED' ? sumCosts(parse(p.techApproved, {})) : 0;
    const claimed = sumDays(parse<any[]>(p.actualDayCosts, []));
    const spend = approved || (p.techEntryStatus === 'SUBMITTED' ? claimed : 0);
    // How much of the advance Accounts has SETTLED/consumed for this trip. The
    // deduction from in-hand happens at SETTLEMENT (step 5), NOT at approval:
    //   • new model      → the amount Accounts settled so far (advanceSettledAmount, partial ok)
    //   • legacy settled  → the approved spend (was settled the old way)
    //   • not settled yet → 0 (advance still fully in the technician's hand)
    const consumed = p.advanceSettledAmount != null
      ? num(p.advanceSettledAmount)
      : (p.advanceSettled ? approved : 0);
    const fullySettled = spend > 0 ? consumed >= spend - 0.5 : !!p.advanceSettled;
    if (spend > 0) {
      const isApproved = p.techEntryStatus === 'APPROVED';
      events.push({
        // Informational — the trip cost. Does NOT move in-hand until Accounts settles it.
        at: iso(p.techApprovedAt) || iso(p.techEntrySubmittedAt) || iso(p.toDate) || iso(p.createdAt),
        kind: 'expense', delta: 0, amount: spend,
        title: isApproved ? `Trip expenses approved — ${p.planNumber || ''}` : `Trip expenses claimed (pending) — ${p.planNumber || ''}`,
        detail: !isApproved ? 'Awaiting sign-off — figure may change' : fullySettled ? 'Settled against the advance' : 'Approved — awaiting Accounts settlement',
        source: 'travel', refNo: p.planNumber || '', settled: fullySettled, balance: 0,
      });
    }
    if (consumed > 0) {
      // Accounts settling the trip against the advance is what reduces in-hand.
      events.push({
        at: iso(p.advanceSettledAt) || iso(p.techApprovedAt), kind: 'settlement', delta: -consumed, amount: consumed,
        title: `Advance settled — ${p.planNumber || ''}`,
        detail: `₹${Math.round(consumed)} settled against the advance by Accounts`,
        source: 'travel', refNo: p.advanceSettledBy || '', settled: true, balance: 0,
      });
    }
  }

  for (const e of petty) {
    // A raised advance only counts once it is APPROVED (active) — a pending-approval,
    // rejected or voided entry is not cash in the person's hand yet.
    if (['VOID', 'REJECTED', 'PENDING_APPROVAL'].includes(e.status)) continue;
    const amount = num(e.sanctionedAmount ?? e.amount);
    if (amount <= 0) continue;
    const isAdvance = e.type === 'TOPUP' || e.category === PETTY_ADVANCE_CAT;
    events.push({
      at: iso(e.date) || iso(e.createdAt),
      kind: isAdvance ? 'advance' : 'company_paid',
      delta: isAdvance ? amount : 0, amount,
      title: e.type === 'TOPUP' ? `Cash top-up — ${e.entryNumber}` : isAdvance ? `Cash advance — ${e.entryNumber}` : `Petty spend — ${e.entryNumber}`,
      detail: isAdvance ? (e.description || e.reason || 'Handed over at the counter') : `${e.category || 'expense'} — paid on the company's behalf, not counted as cash in hand`,
      source: 'petty', refNo: e.entryNumber || '', settled: false, balance: 0,
    });
  }

  events.sort((a, b) => (a.at || '9999').localeCompare(b.at || '9999'));
  let running = 0;
  for (const ev of events) { running += ev.delta; ev.balance = round2(running); }
  return events;
}

function summarise(personKey: string, personId: string | null, name: string, linked: boolean, events: CashEvent[]): CashSummary {
  let received = 0, settled = 0, pendingApproval = 0, awaiting = 0, lastActivityAt: string | null = null;
  for (const ev of events) {
    if (ev.at && (!lastActivityAt || ev.at > lastActivityAt)) lastActivityAt = ev.at;
    if (ev.kind === 'advance') received += ev.amount;
    else if (ev.kind === 'settlement') settled += ev.amount;                 // consumed against the advance by Accounts
    else if (ev.kind === 'expense') {
      if (ev.title.includes('pending')) pendingApproval += ev.amount;        // claimed, not yet approved
      else if (!ev.settled) awaiting += ev.amount;                           // approved, awaiting Accounts settlement
    }
  }
  return {
    personKey, personId, name,
    // "Accounted for" = what Accounts has settled; In hand = advances − settled.
    received: round2(received), spent: round2(settled), inHand: round2(received - settled),
    pendingApproval: round2(pendingApproval), unsettled: round2(awaiting),
    entries: events.length, lastActivityAt, linked,
  };
}

// Assign each source doc a group key + display name.
function groupOf(plans: any[], petty: any[], nameById: Map<string, string>) {
  const groups = new Map<string, { personId: string | null; name: string; linked: boolean; plans: any[]; petty: any[] }>();
  const ensure = (key: string, personId: string | null, fallbackName: string) => {
    let g = groups.get(key);
    if (!g) { g = { personId, name: nameById.get(personId || '') || fallbackName || '—', linked: !!personId, plans: [], petty: [] }; groups.set(key, g); }
    return g;
  };
  for (const p of plans) {
    if (!p.employeeId && !p.employeeName) continue;
    const key = p.employeeId || nameKey(p.employeeName);
    ensure(key, p.employeeId || null, p.employeeName || '').plans.push(p);
  }
  for (const e of petty) {
    if (!e.personId && !e.technician) continue;   // not tied to a person
    if (e.type !== 'TOPUP' && e.category !== PETTY_ADVANCE_CAT && !e.personId) continue; // legacy non-advance name-only: skip
    const key = e.personId || nameKey(e.technician);
    ensure(key, e.personId || null, e.technician || '').petty.push(e);
  }
  return groups;
}

// Every person's balance, biggest outstanding float first.
export async function buildAllCashInHand(): Promise<{ rows: CashSummary[]; totals: { received: number; spent: number; inHand: number; unsettled: number; holding: number; owed: number } }> {
  const { plans, petty, nameById } = await load();
  const groups = groupOf(plans, petty, nameById);
  const rows: CashSummary[] = [];
  for (const [key, g] of groups) {
    const events = eventsFor(g.plans, g.petty);
    const s = summarise(key, g.personId, g.name, g.linked, events);
    if (s.received === 0 && s.spent === 0) continue;   // no money history
    rows.push(s);
  }
  rows.sort((a, b) => Math.abs(b.inHand) - Math.abs(a.inHand) || a.name.localeCompare(b.name));
  const totals = rows.reduce((t, r) => ({
    received: t.received + r.received, spent: t.spent + r.spent, inHand: t.inHand + r.inHand,
    unsettled: t.unsettled + r.unsettled,
    holding: t.holding + (r.inHand > 0 ? 1 : 0), owed: t.owed + (r.inHand < 0 ? 1 : 0),
  }), { received: 0, spent: 0, inHand: 0, unsettled: 0, holding: 0, owed: 0 });
  totals.received = round2(totals.received); totals.spent = round2(totals.spent);
  totals.inHand = round2(totals.inHand); totals.unsettled = round2(totals.unsettled);
  return { rows, totals };
}

// One person's full statement (chronological events + summary).
export async function buildPersonStatement(personKey: string): Promise<{ summary: CashSummary; events: CashEvent[] } | null> {
  const { plans, petty, nameById } = await load();
  const groups = groupOf(plans, petty, nameById);
  const g = groups.get(personKey);
  if (!g) return null;
  const events = eventsFor(g.plans, g.petty);
  const summary = summarise(personKey, g.personId, g.name, g.linked, events);
  return { summary, events };
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
