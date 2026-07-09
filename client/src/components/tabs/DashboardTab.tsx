import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid, Legend } from 'recharts';
import { api, downloadFile } from '../../lib/api';
import { Gauge, KPI, RiskBadge, Spinner } from '../ui';
import { COLOR_HEX, colorFor, fmtDate, fmtNum, riskPill, titleize } from '../../lib/format';
import DashboardExtras from './DashboardExtras';

export default function DashboardTab({ projectId, onOpenGantt }: { projectId: string; onOpenGantt?: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/dashboard`)).data,
  });
  if (isLoading || !data) return <Spinner label="Computing analytics…" />;

  const { overall, risk, categories, categoryRisk, materials, recentActivity, project } = data;
  const chartData = categories.map((c: any) => ({ name: c.category, pct: c.completionPct }));

  return (
    <div className="space-y-5">
      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPI label="Items Completed" value={overall.itemsCompleted} sub={`of ${overall.totalItems} line items`} accent={COLOR_HEX.GREEN} />
        <KPI label="In Progress" value={overall.itemsInProgress} accent={COLOR_HEX.YELLOW} />
        <KPI label="Not Started" value={overall.itemsNotStarted} accent={COLOR_HEX.RED} />
        <KPI label="Days Remaining" value={project.daysRemaining ?? '—'} sub={`Target ${fmtDate(project.targetCompletionDate)}`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Gauge */}
        <div className="card flex flex-col items-center justify-center p-6">
          <div className="mb-2 text-sm font-medium text-slate-500">Overall Completion</div>
          <Gauge pct={overall.completionPct} />
          <div className="mt-3 text-center text-xs text-slate-500">
            {fmtNum(overall.installedQty)} done · {fmtNum(overall.remainingQty)} remaining
          </div>
        </div>

        {/* Category bar chart */}
        <div className="card p-5 lg:col-span-2">
          <div className="mb-3 text-sm font-medium text-slate-600">Category-wise Completion %</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ left: -10, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} tick={{ fontSize: 11 }} height={70} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => `${v}%`} />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                {chartData.map((d: any, i: number) => (
                  <Cell key={i} fill={COLOR_HEX[colorFor(d.pct)]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Risk + Estimated completion */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-600">Delay Risk Analysis</div>
            <div className="mt-1 flex items-center gap-2">
              <RiskBadge level={risk.level} />
              <span className="text-sm text-slate-600">{risk.message}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-slate-400">Estimated Completion</div>
            <div className="text-lg font-semibold text-navy">{fmtDate(overall.estimatedCompletionDate)}</div>
          </div>
        </div>

        {/* Category risk table (FR-DB-06) */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                <th className="py-2">Category</th>
                <th>Completion</th>
                <th>Remaining</th>
                <th>Est. Completion</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {categoryRisk.map((c: any) => (
                <tr key={c.category} className="border-b border-slate-100">
                  <td className="py-2 font-medium text-slate-700">{c.category}</td>
                  <td>{c.completionPct}%</td>
                  <td>{fmtNum(c.remainingQty)}</td>
                  <td>{fmtDate(c.estimatedCompletionDate)}</td>
                  <td><span className={`badge ${riskPill(c.risk.level)}`}>{titleize(c.risk.level)}</span>{c.risk.projectedOverrunDays > 0 && <span className="ml-1 text-xs text-red-600">+{c.risk.projectedOverrunDays}d</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Material consumption (FR-DB-04) */}
        <div className="card p-5">
          <div className="mb-3 text-sm font-medium text-slate-600">Material Consumption (actual vs planned)</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={materials} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="category" width={110} tick={{ fontSize: 10 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="plannedQty" name="Planned" fill="#cbd5e1" radius={[0, 4, 4, 0]} />
              <Bar dataKey="installedQty" name="Installed" fill="#0f2942" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Recent activity (FR-DB-01) */}
        <div className="card p-5">
          <div className="mb-3 text-sm font-medium text-slate-600">Last 7-day Activity</div>
          {recentActivity.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">No approved activity in the last 7 days.</div>
          ) : (
            <ul className="space-y-2">
              {recentActivity.slice(0, 8).map((a: any) => (
                <li key={a.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-700">{a.item}</div>
                    <div className="text-xs text-slate-400">{a.by} · {fmtDate(a.date)}</div>
                  </div>
                  <div className="ml-2 whitespace-nowrap font-semibold text-navy">+{fmtNum(a.quantity)} {a.unit}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Export (FR-DB-03/07) */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="text-sm font-medium text-slate-600">Export Report</div>
        <div className="flex gap-2">
          <button className="btn-outline" onClick={() => downloadFile(`/projects/${projectId}/reports/excel`, 'report.xlsx')}>Excel (.xlsx)</button>
          <button className="btn-outline" onClick={() => downloadFile(`/projects/${projectId}/reports/pdf?type=full`, 'report.pdf')}>Full PDF</button>
          <button className="btn-primary" onClick={() => downloadFile(`/projects/${projectId}/reports/pdf?type=client`, 'client-report.pdf')}>Client PDF</button>
        </div>
      </div>

      {/* NEW cards: Room-wise progress, Gantt summary, Change Orders (additive) */}
      <DashboardExtras projectId={projectId} onOpenGantt={onOpenGantt} />
    </div>
  );
}
