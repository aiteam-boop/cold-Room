// Horizontal progress timeline for a payment's journey through Accounts (Option B).
// Mirrors the Spares-IMS "Progress" stepper the user referenced:
//   Payment raised → Approved (in-app) → Processed by AP (Shivani)
//     → Approved by Alok Ji → Paid by Finance (Taraji)
// The first two steps come from the in-app payment flow; the last three are READ
// from the external FMS sheet (fmsStages), each stamped with its Actual time. A step
// is green(✓) once done, amber(●) when it's the current stage, grey when still ahead.
// Read-only display — nothing here writes to the sheet.

export interface FmsStagesData {
  acStatus: string;
  ap: { actual: string; status: string } | null;      // BILL PROCESSED BY AP (Shivani)
  alok: { actual: string } | null;                     // Bills Approved By Alok Ji
  finance: { actual: string; status: string } | null;  // BILL PAID BY FINANCE (Taraji)
  vrNo: string; utr: string;
}

interface Step { label: string; sub?: string; at?: string | null; done: boolean }

export default function FmsTimeline({
  fmsStages, approved, approvedAt, requestedAt, paid, vrNo, utr, showMeta = true,
}: {
  fmsStages: FmsStagesData | null | undefined;
  approved?: boolean;          // in-app payment sign-off done
  approvedAt?: string | null;  // when it was approved in-app (optional)
  requestedAt?: string | null; // when the approval mail went out (optional)
  paid?: boolean;              // payment is settled (a UTR / VR exists) — force all
                               // Accounts stages complete even if the sheet row for
                               // the exact timestamps wasn't matched.
  vrNo?: string | null;        // VR No. fallback when fmsStages didn't match
  utr?: string | null;         // UTR fallback when fmsStages didn't match
  showMeta?: boolean;          // show the A/C status + VR + UTR footer
}) {
  const s = fmsStages ?? null;
  // A UTR or VR number is proof Finance has paid — so the whole Accounts journey is
  // complete, whether or not we matched the row that carries the per-stage timestamps.
  const isPaid = Boolean(paid) || Boolean(s?.finance?.actual) || Boolean(s?.vrNo) || Boolean(vrNo) || Boolean(s?.utr) || Boolean(utr);
  const steps: Step[] = [
    { label: 'Payment raised', sub: 'Mail sent', at: requestedAt, done: true },
    { label: 'Approved', sub: 'in-app', at: approvedAt, done: Boolean(approved) || isPaid },
    { label: 'Processed by AP', sub: 'Shivani', at: s?.ap?.actual, done: Boolean(s?.ap?.actual) || isPaid },
    { label: 'Approved by Alok Ji', at: s?.alok?.actual, done: Boolean(s?.alok?.actual) || isPaid },
    { label: 'Paid by Finance', sub: 'Taraji', at: s?.finance?.actual, done: Boolean(s?.finance?.actual) || isPaid },
  ];
  return (
    <div>
      <div className="flex items-start overflow-x-auto pb-1">
        {steps.map((st, i) => {
          const done = st.done;
          // The current (in-progress) step is the first not-done step whose
          // predecessors are all done — it gets the amber ring.
          const current = !done && steps.slice(0, i).every((p) => p.done);
          return (
            <div key={i} className="flex min-w-[104px] flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <div className={`h-0.5 flex-1 ${i === 0 ? 'invisible' : steps[i - 1].done ? 'bg-green-500' : 'bg-slate-200'}`} />
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[12px] font-bold ${done ? 'border-green-500 bg-green-500 text-white' : current ? 'border-amber-400 bg-amber-50 text-amber-500' : 'border-slate-300 bg-white text-slate-300'}`}>
                  {done ? '✓' : current ? '●' : ''}
                </div>
                <div className={`h-0.5 flex-1 ${i === steps.length - 1 ? 'invisible' : done ? 'bg-green-500' : 'bg-slate-200'}`} />
              </div>
              <div className="mt-1 px-1 text-center">
                <div className={`text-[11px] font-medium leading-tight ${done ? 'text-slate-700' : current ? 'text-amber-600' : 'text-slate-400'}`}>{st.label}</div>
                {st.sub && <div className="text-[10px] leading-tight text-slate-400">{st.sub}</div>}
                <div className="mt-0.5 text-[10px] leading-tight text-slate-400">{st.at || (done ? '' : current ? 'in progress' : 'pending')}</div>
              </div>
            </div>
          );
        })}
      </div>
      {(() => {
        const acStatus = s?.acStatus || (isPaid ? 'BILL PAID BY FINANCE' : '');
        const showVr = s?.vrNo || vrNo || '';
        const showUtr = s?.utr || utr || '';
        return showMeta && (acStatus || showVr || showUtr) ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-1.5 text-[11px] text-slate-600">
            {acStatus && <span>A/C: <span className="font-medium text-slate-700">{acStatus}</span></span>}
            {showVr && <span>VR: <span className="font-semibold text-slate-700">{showVr}</span></span>}
            {showUtr && <span>UTR: <span className="font-mono text-slate-700">{showUtr}</span></span>}
          </div>
        ) : null;
      })()}
    </div>
  );
}
