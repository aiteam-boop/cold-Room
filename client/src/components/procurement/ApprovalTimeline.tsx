// Renders a document's sequential approval chain as a timeline: done / current /
// upcoming approvers with name, role, timestamp and remarks. Fed by the
// `approval` object returned from the doc/GRN detail endpoint.

interface Step {
  id: string; order: number; approverName: string; approverRole?: string | null;
  status: string; actedAt?: string | null; remarks?: string | null;
}
export interface ApprovalState {
  steps: Step[];
  approved: number;
  total: number;
  currentApproverId?: string | null;
}

// ON_HOLD = sent back to be corrected and resubmitted (orange, not a dead red).
// REJECTED is historical — kept so old chains still render.
const DOT: Record<string, string> = {
  APPROVED: 'bg-green-500', PENDING: 'bg-amber-500', ON_HOLD: 'bg-orange-500', REJECTED: 'bg-red-500', WAITING: 'bg-slate-300',
};

function fmt(ts?: string | null) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function ApprovalTimeline({ approval }: { approval?: ApprovalState | null }) {
  if (!approval || approval.total === 0) return null;
  const current = approval.steps.find((s) => s.status === 'PENDING');
  const held = approval.steps.find((s) => s.status === 'ON_HOLD' || s.status === 'REJECTED');
  const summary = held
    ? `On hold at ${held.approverName} — awaiting correction`
    : current
      ? `${approval.approved} of ${approval.total} approvals · pending ${current.approverName}`
      : `${approval.approved} of ${approval.total} approvals complete`;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">Approval chain</h3>
        <span className="text-xs text-slate-500">{summary}</span>
      </div>
      <ol className="space-y-3">
        {approval.steps.map((s) => (
          <li key={s.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`mt-1 h-2.5 w-2.5 rounded-full ${DOT[s.status] || 'bg-slate-300'}`} />
              <span className="my-0.5 w-px flex-1 bg-slate-200" />
            </div>
            <div className="pb-1">
              <div className="text-sm font-medium text-slate-700">
                {s.order}. {s.approverName}
                {s.approverRole && <span className="ml-1 text-xs font-normal text-slate-400">· {s.approverRole}</span>}
                <span className={`ml-2 badge ${s.status === 'APPROVED' ? 'bg-green-100 text-green-700' : s.status === 'PENDING' ? 'bg-amber-100 text-amber-700' : s.status === 'REJECTED' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>
                  {s.status === 'WAITING' ? 'Upcoming' : s.status === 'PENDING' ? 'Pending' : s.status.charAt(0) + s.status.slice(1).toLowerCase()}
                </span>
              </div>
              {s.actedAt && <div className="text-xs text-slate-400">{fmt(s.actedAt)}</div>}
              {s.remarks && <div className="text-xs text-slate-500">“{s.remarks}”</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
