import { useState } from 'react';
import PaymentDashboard from './PaymentDashboard';
import DocList from './DocList';
import GRNView from './GRNView';
import VendorsView from './VendorsView';
import DocumentsView from './DocumentsView';

const SUBS = [
  { key: 'dashboard', label: 'Payment Pipeline' },
  { key: 'po', label: 'Purchase Orders' },
  { key: 'wo', label: 'Work Orders' },
  { key: 'grn', label: 'GRNs' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'documents', label: 'Documents' },
] as const;

export default function ProcurementTab({ projectId, role }: { projectId: string; role: string }) {
  const [sub, setSub] = useState<string>('dashboard');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {SUBS.map((s) => (
          <button key={s.key} onClick={() => setSub(s.key)} className={`rounded-md px-3 py-1.5 font-medium ${sub === s.key ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {sub === 'dashboard' && <PaymentDashboard projectId={projectId} role={role} />}
      {sub === 'po' && <DocList projectId={projectId} role={role} type="PO" />}
      {sub === 'wo' && <DocList projectId={projectId} role={role} type="WO" />}
      {sub === 'grn' && <GRNView projectId={projectId} role={role} />}
      {sub === 'vendors' && <VendorsView projectId={projectId} role={role} />}
      {sub === 'documents' && <DocumentsView projectId={projectId} role={role} />}
    </div>
  );
}
