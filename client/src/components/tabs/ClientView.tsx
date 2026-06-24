import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from '../../lib/api';
import { Gauge, Spinner } from '../ui';
import { COLOR_HEX, colorFor, fmtDate } from '../../lib/format';
import FloorPlan2D from '../FloorPlan2D';

// Simplified client dashboard (PRD §10.7): high-level only, no BOQ detail.
export default function ClientView({ projectId }: { projectId: string }) {
  const dash = useQuery({ queryKey: ['dashboard', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/dashboard`)).data });
  const zonesQ = useQuery({ queryKey: ['zones', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/drawings/zones`)).data.zones });

  if (dash.isLoading || !dash.data) return <Spinner label="Loading…" />;
  const { overall, categories, project } = dash.data;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card flex flex-col items-center justify-center p-6">
          <div className="mb-2 text-sm font-medium text-slate-500">Overall Completion</div>
          <Gauge pct={overall.completionPct} />
          <div className="mt-3 text-sm text-slate-500">Estimated finish: <span className="font-semibold text-navy">{fmtDate(overall.estimatedCompletionDate)}</span></div>
        </div>
        <div className="card p-5 lg:col-span-2">
          <div className="mb-3 text-sm font-medium text-slate-600">Category Breakdown</div>
          <div className="space-y-2">
            {categories.map((c: any) => (
              <div key={c.category} className="flex items-center gap-3">
                <div className="w-40 truncate text-sm text-slate-600">{c.category}</div>
                <div className="h-3 flex-1 rounded-full bg-slate-200">
                  <div className="h-3 rounded-full" style={{ width: `${c.completionPct}%`, background: COLOR_HEX[colorFor(c.completionPct)] }} />
                </div>
                <div className="w-12 text-right text-sm font-medium">{c.completionPct}%</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {zonesQ.data?.length > 0 && (
        <div className="card p-4">
          <div className="mb-3 text-sm font-medium text-slate-600">Site Floor Plan</div>
          <div className="lg:w-2/3"><FloorPlan2D zones={zonesQ.data} onSelect={() => {}} /></div>
        </div>
      )}

      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <div className="text-sm font-medium text-slate-600">Project Report</div>
          <div className="text-xs text-slate-400">Download a branded progress summary.</div>
        </div>
        <button className="btn-primary" onClick={() => downloadFile(`/projects/${projectId}/reports/pdf?type=client`, 'progress-report.pdf')}>Download Report (PDF)</button>
      </div>
    </div>
  );
}
