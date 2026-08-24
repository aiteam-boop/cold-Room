// Rich KYC badge — traffic-light status pill carrying the completeness percentage,
// the X/Y item count and a ⚠ when a mandatory KYC item is still missing (so the
// vendor can't yet be used). Falls back to a plain dot + status when no score is
// available. Shared by the embedded vendor list and the global Vendors page so
// both read identically.

export interface KycScore {
  completed: number; total: number; percent: number;
  mandatoryMissing: string[]; usable: boolean; level: string;
  items?: { key: string; label: string; done: boolean; mandatory: boolean }[];
}

export const KYC_DOT: Record<string, string> = { Complete: 'bg-green-500', Partial: 'bg-amber-500', Missing: 'bg-red-500' };

const KYC_STATUS_CLASS: Record<string, string> = {
  Complete: 'bg-green-100 text-green-700 border-green-200',
  Partial: 'bg-amber-100 text-amber-700 border-amber-200',
  Missing: 'bg-red-100 text-red-700 border-red-200',
};

export default function KycBadge({ kyc, kycStatus }: { kyc?: KycScore; kycStatus?: string }) {
  const status = kycStatus || 'Missing';
  if (!kyc) return <span className="inline-flex items-center gap-1 text-xs"><span className={`h-2 w-2 rounded-full ${KYC_DOT[status]}`} />{status}</span>;
  const tip = kyc.mandatoryMissing.length
    ? `Cannot use — missing: ${kyc.mandatoryMissing.join(', ')}`
    : kyc.percent < 100 ? 'Usable · optional details pending' : 'KYC complete';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${KYC_STATUS_CLASS[status] || KYC_STATUS_CLASS.Missing}`} title={tip}>
      <span className={`h-2 w-2 rounded-full ${KYC_DOT[status]}`} />
      <span>{kyc.percent}%</span>
      <span className="opacity-70">· {kyc.completed}/{kyc.total}</span>
      {!kyc.usable && <span title={tip}>⚠</span>}
    </span>
  );
}
