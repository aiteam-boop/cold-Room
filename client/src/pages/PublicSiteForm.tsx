import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Spinner } from '../components/ui';
import { SiteForm, SafetyForm, type FormIO, type Project } from './SiteForms';

// No-login public DPR fill page — opened from the `/site-forms/:token` link emailed to
// the engineer. Reuses the same Site/Safety form components in public (token) mode.
export default function PublicSiteForm() {
  const { token } = useParams();
  const q = useQuery({
    queryKey: ['public-dpr', token],
    queryFn: async () => (await api.get(`/public/site-forms/${token}`)).data as { dpr: any; boq: any[] },
    retry: false,
  });

  if (q.isLoading) return <div className="p-16 text-center"><Spinner label="Loading DPR…" /></div>;
  if (q.isError || !q.data) return <div className="mx-auto max-w-lg p-16 text-center text-slate-500">This DPR link is invalid or has expired.</div>;

  const { dpr, boq } = q.data;
  const submitted = dpr.status === 'SUBMITTED';
  const project: Project | null = (dpr.projectId || dpr.projectName)
    ? { id: dpr.projectId || '', name: dpr.projectName || '', clientName: dpr.clientName, siteLocation: dpr.siteLocation }
    : null;

  const io: FormIO = {
    canEdit: !submitted,
    projects: [],
    fixedProject: project,
    lockProject: true,
    initial: {
      dprDate: dpr.dprDate ? new Date(dpr.dprDate).toISOString().slice(0, 10) : undefined,
      engineerName: dpr.engineerName || '',
      data: dpr.data || {},
    },
    boqPreloaded: dpr.type === 'SITE' ? (boq || []) : undefined,
    uploadUrl: `/public/site-forms/${token}/upload`,
    uploadPdfUrl: `/public/site-forms/${token}/upload-pdf`,
    onSubmit: async (rec) => { await api.post(`/public/site-forms/${token}/submit`, { engineerName: rec.engineerName, dprDate: rec.dprDate, data: rec.data, submit: rec.submit }); },
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-navy px-4 py-3 text-white">
        <div className="mx-auto max-w-6xl">
          <div className="text-xs opacity-80">CRMCTS · Crystal Group</div>
          <div className="font-semibold">{dpr.type === 'SAFETY' ? 'Safety Engineer' : 'Site Engineer'} — Daily Progress Report{dpr.dprNumber ? ` · ${dpr.dprNumber}` : ''}</div>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {submitted && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">✓ This DPR has been submitted — it is now view-only.</div>}
        {dpr.type === 'SAFETY' ? <SafetyForm io={io} /> : <SiteForm io={io} />}
      </div>
    </div>
  );
}
