import { useMemo, useState } from 'react';

// Public Integration Kit — a detailed, self-contained reference for the CRMCTS
// public API. No auth: anyone with the link can read how to integrate. It exposes
// NO data; it only documents auth, realms, scopes, endpoints, response shapes,
// errors, and copy-paste examples, and offers a live "Try it" console.

// ── Field dictionaries ────────────────────────────────────────────────────────
type Field = { name: string; type: string; desc: string };
const F = {
  project: [
    { name: 'id', type: 'string', desc: 'Project id; use it in project-scoped endpoints.' },
    { name: 'name', type: 'string', desc: 'Project name (core).' },
    { name: 'client', type: 'string | null', desc: 'Client name. Needs read:parties.' },
    { name: 'site', type: 'string | null', desc: 'Site location.' },
    { name: 'status', type: 'string', desc: 'PLANNING, IN_PROGRESS, COMPLETED, ON_HOLD…' },
    { name: 'startDate', type: 'ISO date | null', desc: 'Planned start.' },
    { name: 'targetDate', type: 'ISO date | null', desc: 'Target completion.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the project dashboard.' },
  ],
  doc: [
    { name: 'id', type: 'string', desc: 'Document id.' },
    { name: 'number', type: 'string', desc: 'PO/WO number (e.g. PO-0007).' },
    { name: 'vendor', type: 'string | null', desc: 'Vendor name. Needs read:parties.' },
    { name: 'status', type: 'string', desc: 'DRAFT, PENDING, APPROVED, ON_HOLD…' },
    { name: 'date', type: 'ISO date', desc: 'Document date.' },
    { name: 'basicAmount', type: 'number', desc: 'Amount before taxes. Needs read:money.' },
    { name: 'finalAmount', type: 'number', desc: 'Final amount incl. taxes. Needs read:money.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the order, ready to review/approve.' },
  ],
  grn: [
    { name: 'id', type: 'string', desc: 'GRN id.' },
    { name: 'number', type: 'string', desc: 'GRN number.' },
    { name: 'against', type: 'string | null', desc: 'PO/WO number it was received against.' },
    { name: 'vendor', type: 'string | null', desc: 'Vendor name. Needs read:parties.' },
    { name: 'status', type: 'string', desc: 'DRAFT, PENDING, APPROVED…' },
    { name: 'date', type: 'ISO date', desc: 'Receipt date.' },
    { name: 'invoiceNumber', type: 'string | null', desc: 'Supplier invoice no. Needs read:money.' },
    { name: 'invoiceValue', type: 'number | null', desc: 'Invoice value. Needs read:money.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the GRN.' },
  ],
  payment: [
    { name: 'id', type: 'string', desc: 'Payment id.' },
    { name: 'number', type: 'string', desc: 'FMS payment number.' },
    { name: 'vendor', type: 'string | null', desc: 'Vendor. Needs read:parties.' },
    { name: 'po', type: 'string | null', desc: 'Related PO number.' },
    { name: 'amount', type: 'number', desc: 'Amount to pay. Needs read:money.' },
    { name: 'status', type: 'string', desc: 'DRAFT, PENDING, APPROVED, PAID…' },
    { name: 'paidAt', type: 'ISO date | null', desc: 'When it was marked paid.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the payment.' },
  ],
  task: [
    { name: 'id', type: 'string', desc: 'Gantt activity id.' },
    { name: 'name', type: 'string', desc: 'Activity name.' },
    { name: 'status', type: 'string', desc: 'NOT_STARTED, IN_PROGRESS, COMPLETED…' },
    { name: 'percentComplete', type: 'number', desc: '0–100 completion.' },
    { name: 'plannedStart', type: 'ISO date', desc: 'Planned start.' },
    { name: 'plannedEnd', type: 'ISO date', desc: 'Planned end.' },
    { name: 'actualStart', type: 'ISO date | null', desc: 'Actual start.' },
    { name: 'actualEnd', type: 'ISO date | null', desc: 'Actual end.' },
    { name: 'responsible', type: 'string | null', desc: 'Accountable person. Needs read:people.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the Gantt with this task highlighted.' },
  ],
  boq: [
    { name: 'id', type: 'string', desc: 'BOQ item id.' },
    { name: 'srNo', type: 'string | null', desc: 'Serial number.' },
    { name: 'description', type: 'string', desc: 'Line item description.' },
    { name: 'category', type: 'string | null', desc: 'Section / category.' },
    { name: 'unit', type: 'string | null', desc: 'Unit of measure.' },
    { name: 'plannedQty', type: 'number | null', desc: 'Planned quantity.' },
    { name: 'modelNumber', type: 'string | null', desc: 'Model number.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the BOQ tab.' },
  ],
  vendor: [
    { name: 'id', type: 'string', desc: 'Vendor id.' },
    { name: 'vendorName', type: 'string', desc: 'Vendor / company name. Needs read:parties.' },
    { name: 'type', type: 'string', desc: 'VENDOR, CONTRACTOR…' },
    { name: 'gstin', type: 'string | null', desc: 'GST number. Needs read:parties.' },
    { name: 'pan', type: 'string | null', desc: 'PAN. Needs read:parties.' },
    { name: 'contact', type: 'string | null', desc: 'Contact person. Needs read:parties.' },
    { name: 'phone', type: 'string | null', desc: 'Phone(s). Needs read:parties.' },
    { name: 'deepLink', type: 'url', desc: 'Opens the vendor list.' },
  ],
} satisfies Record<string, Field[]>;

// ── Read endpoint catalog (drives docs, the Try-it console, OpenAPI/Postman) ───
type Endpoint = { id: string; method: string; path: string; desc: string; pathParams?: Field[]; sample: string; fields?: Field[]; fieldsTitle?: string };

const LIST_PAGE = `"page": { "limit": 50, "offset": 0, "total": 1, "hasMore": false }`;

const ENDPOINTS: { group: string; anchor: string; items: Endpoint[] }[] = [
  { group: 'Health', anchor: 'ep-health', items: [
    { id: 'ping', method: 'GET', path: '/api/v1/ping', desc: 'Confirm your key works. Echoes the key’s name, realms & scopes.',
      sample: `{\n  "data": {\n    "ok": true,\n    "key": "Power BI — Finance",\n    "realms": ["projects", "finance"],\n    "scopes": ["read:core", "read:money"],\n    "serverTime": "2026-07-16T09:20:11.482Z"\n  }\n}` },
  ] },
  { group: 'Projects', anchor: 'ep-projects', items: [
    { id: 'projects', method: 'GET', path: '/api/v1/projects', desc: 'List projects (paginated). Each carries a deepLink.',
      sample: `{\n  "data": [\n    {\n      "id": "clx123abc",\n      "name": "Cold Storage — Bhiwandi",\n      "client": "Acme Foods",\n      "status": "IN_PROGRESS",\n      "startDate": "2026-05-01T00:00:00.000Z",\n      "targetDate": "2026-09-30T00:00:00.000Z",\n      "deepLink": "{ORIGIN}/go/project/clx123abc?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.project, fieldsTitle: 'project object' },
    { id: 'project', method: 'GET', path: '/api/v1/projects/{id}', desc: 'One project: details, counts, sub-resource links.', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": {\n    "id": "clx123abc",\n    "name": "Cold Storage — Bhiwandi",\n    "client": "Acme Foods",\n    "status": "IN_PROGRESS",\n    "counts": { "documents": 12, "grns": 5, "payments": 8, "tasks": 24, "boqItems": 140 },\n    "deepLink": "{ORIGIN}/go/project/clx123abc?project=clx123abc",\n    "links": {\n      "purchaseOrders": "/api/v1/projects/clx123abc/purchase-orders",\n      "tasks":          "/api/v1/projects/clx123abc/tasks"\n    }\n  }\n}` },
  ] },
  { group: 'Procurement', anchor: 'ep-procurement', items: [
    { id: 'purchase-orders', method: 'GET', path: '/api/v1/projects/{id}/purchase-orders', desc: 'Purchase orders for a project.', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": [\n    {\n      "id": "po_88f2", "number": "PO-0007", "vendor": "Kingspan Jindal", "status": "APPROVED",\n      "date": "2026-06-12T00:00:00.000Z", "basicAmount": 450000, "finalAmount": 531000,\n      "deepLink": "{ORIGIN}/go/po/po_88f2?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.doc, fieldsTitle: 'purchaseOrder object' },
    { id: 'work-orders', method: 'GET', path: '/api/v1/projects/{id}/work-orders', desc: 'Work orders (same shape as POs).', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": [\n    {\n      "id": "wo_2a10", "number": "WO-0003", "vendor": "Site Contractor", "status": "PENDING",\n      "date": "2026-06-20T00:00:00.000Z", "basicAmount": 120000, "finalAmount": 141600,\n      "deepLink": "{ORIGIN}/go/wo/wo_2a10?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.doc, fieldsTitle: 'workOrder object' },
    { id: 'grns', method: 'GET', path: '/api/v1/projects/{id}/grns', desc: 'Goods receipts (GRNs).', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": [\n    {\n      "id": "grn_51cc", "number": "GRN-0004", "against": "PO-0007", "vendor": "Kingspan Jindal",\n      "status": "APPROVED", "date": "2026-06-28T00:00:00.000Z", "invoiceNumber": "INV-9921", "invoiceValue": 531000,\n      "deepLink": "{ORIGIN}/go/grn/grn_51cc?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.grn, fieldsTitle: 'grn object' },
    { id: 'boq-items', method: 'GET', path: '/api/v1/projects/{id}/boq-items', desc: 'Bill of quantities line items.', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": [\n    {\n      "id": "boq_1200", "srNo": "1.4", "description": "PUF Panel 100mm — wall", "category": "Insulation",\n      "unit": "Sqm", "plannedQty": 320, "modelNumber": "KS1000-100",\n      "deepLink": "{ORIGIN}/go/boq/boq_1200?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.boq, fieldsTitle: 'boqItem object' },
  ] },
  { group: 'Finance', anchor: 'ep-finance', items: [
    { id: 'payments', method: 'GET', path: '/api/v1/projects/{id}/payments', desc: 'Vendor payments (FMS). Finance realm — requires read:money to call at all.', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": [\n    {\n      "id": "fms_77ab", "number": "FMS-0001", "vendor": "Kingspan Jindal", "po": "PO-0007",\n      "amount": 265500, "status": "APPROVED", "paidAt": null,\n      "deepLink": "{ORIGIN}/go/payment/fms_77ab?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.payment, fieldsTitle: 'payment object' },
  ] },
  { group: 'Timeline', anchor: 'ep-timeline', items: [
    { id: 'tasks', method: 'GET', path: '/api/v1/projects/{id}/tasks', desc: 'Gantt activities. A task’s deep link opens it ready to action.', pathParams: [{ name: 'id', type: 'string', desc: 'Project id.' }],
      sample: `{\n  "data": [\n    {\n      "id": "act_9f31", "name": "Install PUF panels — Room 1", "status": "IN_PROGRESS", "percentComplete": 60,\n      "plannedStart": "2026-06-10T00:00:00.000Z", "plannedEnd": "2026-06-24T00:00:00.000Z",\n      "actualStart": "2026-06-11T00:00:00.000Z", "actualEnd": null, "responsible": "Site Engineer",\n      "deepLink": "{ORIGIN}/go/task/act_9f31?project=clx123abc"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.task, fieldsTitle: 'task object' },
  ] },
  { group: 'Masters', anchor: 'ep-masters', items: [
    { id: 'vendors', method: 'GET', path: '/api/v1/vendors', desc: 'The vendor master. Vendors realm — requires read:parties to call at all.',
      sample: `{\n  "data": [\n    {\n      "id": "v_301", "vendorName": "Kingspan Jindal", "type": "VENDOR", "gstin": "27ABCDE1234F1Z5",\n      "pan": "ABCDE1234F", "contact": "R. Mehta", "phone": "+91 98200 00000",\n      "deepLink": "{ORIGIN}/go/vendor/v_301"\n    }\n  ],\n  ${LIST_PAGE}\n}`, fields: F.vendor, fieldsTitle: 'vendor object' },
  ] },
];
const ALL_OPS = ENDPOINTS.flatMap((g) => g.items);

// ── Write endpoints (documented separately; not in the read console) ──────────
type WriteOp = { id: string; method: string; path: string; desc: string; body?: Field[]; sample: string };
const WRITE_OPS: WriteOp[] = [
  { id: 'task-start', method: 'POST', path: '/api/v1/projects/{id}/tasks/{taskId}/start', desc: 'Mark a task started. Needs the timeline realm + write:tasks scope.',
    body: [{ name: 'date', type: 'ISO date (optional)', desc: 'When it started. Defaults to now.' }],
    sample: `{ "data": { "id": "act_9f31", "status": "IN_PROGRESS", "actualStart": "2026-07-16T00:00:00.000Z", ... } }` },
  { id: 'task-progress', method: 'POST', path: '/api/v1/projects/{id}/tasks/{taskId}/progress', desc: 'Set a task’s percent complete (0–100). Needs write:tasks.',
    body: [{ name: 'percentComplete', type: 'number 0–100 (required)', desc: 'New progress.' }],
    sample: `{ "data": { "id": "act_9f31", "status": "IN_PROGRESS", "percentComplete": 75, ... } }` },
  { id: 'task-complete', method: 'POST', path: '/api/v1/projects/{id}/tasks/{taskId}/complete', desc: 'Mark a task complete. Needs write:tasks.',
    body: [{ name: 'date', type: 'ISO date (optional)', desc: 'Completion date. Defaults to now.' }, { name: 'notes', type: 'string (optional)', desc: 'Completion notes.' }],
    sample: `{ "data": { "id": "act_9f31", "status": "COMPLETED", "percentComplete": 100, "actualEnd": "2026-07-16T00:00:00.000Z", ... } }` },
];

const REALM_DOCS = [
  { key: 'projects', reach: 'Projects, status, timelines, completion.', needs: '' },
  { key: 'procurement', reach: 'Purchase & work orders, GRNs, BOQ line items.', needs: '' },
  { key: 'timeline', reach: 'Gantt tasks (read; write needs write:tasks).', needs: '' },
  { key: 'finance', reach: 'Vendor payments (FMS).', needs: 'read:money' },
  { key: 'vendors', reach: 'Vendor master — names, GSTIN/PAN, contacts.', needs: 'read:parties' },
];
const SCOPE_DOCS = [
  { key: 'read:core', gives: 'Ids, numbers, descriptions, quantities, statuses, dates.', note: 'Always on.' },
  { key: 'read:money', gives: 'Amounts, prices, budgets, invoice values, payment amounts, UTRs.', note: '' },
  { key: 'read:parties', gives: 'Vendor / client names, contacts, addresses, GSTIN & PAN.', note: '' },
  { key: 'read:people', gives: 'Responsible-person / employee identities.', note: '' },
  { key: 'read:files', gives: 'File URLs — drawings, invoices, photos, PDFs.', note: '' },
  { key: 'write:tasks', gives: 'Update Gantt tasks (start / progress / complete).', note: 'Write. Needs timeline realm.' },
];

const DEEP_ENTITIES = [
  { entity: 'project', link: '/go/project/{id}?project={id}', dest: 'Project dashboard.' },
  { entity: 'po', link: '/go/po/{id}?project={projectId}', dest: 'Purchase Orders tab, the PO opened.' },
  { entity: 'wo', link: '/go/wo/{id}?project={projectId}', dest: 'Work Orders tab, the WO opened.' },
  { entity: 'grn', link: '/go/grn/{id}?project={projectId}', dest: 'Goods Receipt tab, the GRN opened.' },
  { entity: 'payment', link: '/go/payment/{id}?project={projectId}', dest: 'FMS tab, the payment opened.' },
  { entity: 'task', link: '/go/task/{id}?project={projectId}', dest: 'Gantt, the task highlighted.' },
  { entity: 'boq', link: '/go/boq/{id}?project={projectId}', dest: 'BOQ & Progress tab.' },
  { entity: 'vendor', link: '/go/vendor/{id}', dest: 'Vendors page.' },
];

const ERRORS = [
  { code: '200', err: '—', when: 'Success. Body is { data, … }.' },
  { code: '401', err: 'missing_key', when: 'No key was sent.' },
  { code: '401', err: 'invalid_key', when: 'Key not found, revoked, expired, or malformed (one generic reason).' },
  { code: '403', err: 'forbidden_realm', when: 'The key does not have that realm granted.' },
  { code: '403', err: 'forbidden_scope', when: 'A Finance/Vendors read, or a write, without its required scope.' },
  { code: '403', err: 'ip_not_allowed', when: 'The caller’s IP is not on the key’s allowlist.' },
  { code: '429', err: 'rate_limited', when: 'Per-minute rate limit exceeded. Retry-After + X-RateLimit-* headers.' },
  { code: '400', err: 'validation_error', when: 'Bad request body (writes). issues[] included.' },
  { code: '404', err: 'not_found', when: 'Unknown resource (e.g. bad project/task id).' },
  { code: '500', err: 'server_error', when: 'Verification/DB fault. Retry; do not rotate the key.' },
];

const TOC = [
  { href: '#overview', label: 'Overview' },
  { href: '#try', label: 'Try it live' },
  { href: '#base-url', label: 'Base URL' },
  { href: '#auth', label: 'Authentication' },
  { href: '#realms-scopes', label: 'Realms & scopes' },
  { href: '#conventions', label: 'Conventions' },
  { href: '#limits', label: 'Limits & versioning' },
  { href: '#ep-health', label: 'Endpoints · Health' },
  { href: '#ep-projects', label: 'Endpoints · Projects' },
  { href: '#ep-procurement', label: 'Endpoints · Procurement' },
  { href: '#ep-finance', label: 'Endpoints · Finance' },
  { href: '#ep-timeline', label: 'Endpoints · Timeline' },
  { href: '#ep-masters', label: 'Endpoints · Masters' },
  { href: '#writes', label: 'Write endpoints' },
  { href: '#deep-links', label: 'Deep links' },
  { href: '#errors', label: 'Errors' },
  { href: '#examples', label: 'Code examples' },
  { href: '#downloads', label: 'Downloads' },
  { href: '#recipes', label: 'Recipes' },
];

// ── UI helpers ────────────────────────────────────────────────────────────────
function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return <button className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
    onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}>{ok ? 'Copied ✓' : 'Copy'}</button>;
}
function Code({ children }: { children: string }) {
  return <div className="flex items-start gap-2"><pre className="flex-1 overflow-x-auto rounded-lg bg-navy px-4 py-3 font-mono text-xs leading-relaxed text-slate-100">{children}</pre><Copy text={children} /></div>;
}
function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-slate-200 px-1 font-mono text-xs text-navy">{children}</code>;
}
function FieldTable({ title, fields }: { title: string; fields: Field[] }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-xs"><tbody>
          {fields.map((f, i) => (
            <tr key={f.name} className={i ? 'border-t border-slate-100' : ''}>
              <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono font-medium text-navy">{f.name}</td>
              <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-slate-400">{f.type}</td>
              <td className="px-3 py-1.5 align-top text-slate-600">{f.desc}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
function EndpointCard({ e, origin }: { e: Endpoint; origin: string }) {
  return (
    <div className="scroll-mt-24 space-y-3 rounded-xl border border-slate-200 bg-white p-4" id={`op-${e.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{e.method}</span>
        <code className="font-mono text-sm font-semibold text-navy">{e.path}</code>
        <Copy text={`${origin}${e.path}`} />
      </div>
      <p className="text-sm text-slate-600">{e.desc}</p>
      {e.pathParams && <FieldTable title="Path parameters" fields={e.pathParams} />}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Example response · 200</div>
        <Code>{e.sample.split('{ORIGIN}').join(origin)}</Code>
      </div>
      {e.fields && e.fieldsTitle && <FieldTable title={`Response fields · ${e.fieldsTitle}`} fields={e.fields} />}
    </div>
  );
}

// ── Live "Try it" console (GET reads only) ────────────────────────────────────
function TryConsole({ origin }: { origin: string }) {
  const [key, setKey] = useState('');
  const [opIdx, setOpIdx] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ status: number; ms: number; body: string } | null>(null);
  const [err, setErr] = useState('');
  const op = ALL_OPS[opIdx];
  const needsProject = op.path.includes('{id}');
  const url = `${origin}${needsProject ? op.path.replace('{id}', projectId || '{id}') : op.path}`;

  async function run() {
    setErr(''); setOut(null);
    if (!key.trim()) { setErr('Paste an API key first.'); return; }
    if (needsProject && !projectId.trim()) { setErr('This endpoint needs a project id — run GET /api/v1/projects first.'); return; }
    setBusy(true);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': key.trim() } });
      const ms = Math.round(performance.now() - t0);
      let body: string; try { body = JSON.stringify(await res.json(), null, 2); } catch { body = await res.text(); }
      setOut({ status: res.status, ms, body });
      if (op.id === 'projects' && !projectId) { try { const first = JSON.parse(body)?.data?.[0]?.id; if (first) setProjectId(first); } catch { /* ignore */ } }
    } catch (e) { setErr('Request failed (network/CORS). ' + (e instanceof Error ? e.message : '')); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">API key</label>
          <input type="password" autoComplete="off" placeholder="crmk_live_…" value={key} onChange={(e) => setKey(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-navy" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">Endpoint (GET)</label>
          <select value={opIdx} onChange={(e) => { setOpIdx(Number(e.target.value)); setOut(null); }} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-navy">
            {ALL_OPS.map((o, i) => <option key={o.id} value={i}>{o.method} {o.path}</option>)}
          </select>
        </div>
      </div>
      {needsProject && (
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">Project id</label>
          <input placeholder="clx123abc" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-navy" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={run} disabled={busy} className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700 disabled:opacity-50">{busy ? 'Sending…' : 'Send request'}</button>
        <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-500">GET {url}</code>
      </div>
      {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{err}</div>}
      {out && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className={`rounded px-2 py-0.5 font-bold ${out.status >= 200 && out.status < 300 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{out.status}</span>
            <span className="text-slate-400">{out.ms} ms</span>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg bg-navy px-4 py-3 font-mono text-xs leading-relaxed text-slate-100">{out.body}</pre>
        </div>
      )}
    </div>
  );
}

// ── OpenAPI / Postman generators ──────────────────────────────────────────────
function buildOpenApi(origin: string) {
  const paths: Record<string, unknown> = {};
  const add = (path: string, method: string, desc: string, id: string, pp: string[]) => {
    const p = (paths as Record<string, Record<string, unknown>>)[path] || ((paths as Record<string, Record<string, unknown>>)[path] = {});
    p[method] = { summary: desc, operationId: id, parameters: pp.map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } })), security: [{ ApiKeyAuth: [] }],
      responses: { '200': { description: 'Success' }, '401': { description: 'invalid_key' }, '403': { description: 'forbidden_realm / forbidden_scope' }, '429': { description: 'rate_limited' } } };
  };
  for (const op of ALL_OPS) add(op.path, 'get', op.desc, op.id, [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const op of WRITE_OPS) add(op.path, 'post', op.desc, op.id, [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  return {
    openapi: '3.0.3',
    info: { title: 'CRMCTS Public API', version: '1.0.0', description: 'Read + task-write API with deep links. Envelope: {data, page} for lists, {data} for items, {error:{code,message}} for errors.' },
    servers: [{ url: origin }],
    components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    security: [{ ApiKeyAuth: [] }], paths,
  };
}
function buildPostman(origin: string) {
  const item = (name: string, method: string, path: string, desc: string) => ({
    name: `${method} ${path}`, request: { method, header: [{ key: 'X-API-Key', value: '{{apiKey}}' }, ...(method === 'POST' ? [{ key: 'Idempotency-Key', value: '{{$guid}}' }] : [])],
      url: { raw: '{{baseUrl}}' + path.replace('{id}', '{{projectId}}').replace('{taskId}', '{{taskId}}'), host: ['{{baseUrl}}'], path: path.replace('{id}', '{{projectId}}').replace('{taskId}', '{{taskId}}').split('/').filter(Boolean) }, description: desc } });
  return {
    info: { name: 'CRMCTS Public API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: origin }, { key: 'apiKey', value: 'crmk_live_your_key' }, { key: 'projectId', value: '' }, { key: 'taskId', value: '' }],
    item: [...ALL_OPS.map((o) => item(o.id, 'GET', o.path, o.desc)), ...WRITE_OPS.map((o) => item(o.id, 'POST', o.path, o.desc))],
  };
}
function downloadJson(name: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

export default function IntegrationKit() {
  const origin = useMemo(() => (typeof window !== 'undefined' ? window.location.origin : 'https://coldroom.crystalgrp.xyz'), []);
  const curlExample = `curl -H "X-API-Key: crmk_live_your_key" \\\n  ${origin}/api/v1/projects`;
  const jsExample = `const res = await fetch("${origin}/api/v1/projects", {\n  headers: { "X-API-Key": "crmk_live_your_key" }\n});\nif (!res.ok) throw new Error((await res.json()).error.code);\nconst { data, page } = await res.json();\ndata.forEach(p => console.log(p.name, "→", p.deepLink));`;
  const pyExample = `import requests\nBASE = "${origin}/api/v1"\nH = {"X-API-Key": "crmk_live_your_key"}\nr = requests.get(f"{BASE}/projects", headers=H); r.raise_for_status()\nfor p in r.json()["data"]:\n    print(p["name"], "->", p["deepLink"])`;
  const writeExample = `# Mark a task complete (needs a key with timeline realm + write:tasks scope)\ncurl -X POST \\\n  -H "X-API-Key: crmk_live_your_key" \\\n  -H "Idempotency-Key: 8f3a-once" \\\n  -H "Content-Type: application/json" \\\n  -d '{"notes":"Done on site"}' \\\n  ${origin}/api/v1/projects/clx123abc/tasks/act_9f31/complete`;
  const recipeOverdue = `// Overdue tasks → a link to fix each.\nconst H = { "X-API-Key": "crmk_live_your_key" };\nconst base = "${origin}/api/v1";\nconst { data: projects } = await (await fetch(base + "/projects", { headers: H })).json();\nfor (const p of projects) {\n  const { data: tasks } = await (await fetch(\`\${base}/projects/\${p.id}/tasks\`, { headers: H })).json();\n  tasks.filter(t => !t.actualEnd && new Date(t.plannedEnd) < new Date())\n       .forEach(t => console.log(\`[\${p.name}] \${t.name} overdue → \${t.deepLink}\`));\n}`;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-navy text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-lg">❄</span>
            <div>
              <div className="text-lg font-bold">CRMCTS Integration Kit</div>
              <div className="text-xs text-slate-300">Public API reference · deep links into your dashboard</div>
            </div>
          </div>
          <a href="#examples" className="hidden rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 sm:block">Jump to examples →</a>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
        <aside className="hidden w-52 shrink-0 lg:block">
          <nav className="sticky top-24 space-y-0.5 text-sm">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">On this page</div>
            {TOC.map((t) => <a key={t.href} href={t.href} className="block rounded px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-navy">{t.label}</a>)}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 space-y-12">
          <section id="overview" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-bold text-navy">Overview</h2>
            <p className="text-sm leading-relaxed text-slate-600">
              An API key gives scoped access to CRMCTS — projects, purchase &amp; work orders, goods receipts, vendor
              payments, BOQ, timeline tasks, and the vendor master, plus the ability to update tasks. What a key can
              reach is set by its <strong>realms</strong>; which sensitive fields it sees is set by its <strong>scopes</strong>.
              Every item carries a <strong>deep link</strong> that opens it in the dashboard, ready to act on.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {[['Least-privilege', 'Realms gate endpoints; scopes gate fields. A key sees only what it was granted.'],
                ['Hash-stored', 'Only a SHA-256 hash of the key is stored, compared in constant time. The secret can’t be read back.'],
                ['Auditable', 'Every request is logged (route, status, latency, IP). Anomalies (leak/abuse) are flagged.']].map(([h, d]) => (
                <div key={h} className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-sm font-semibold text-navy">{h}</div><div className="mt-0.5 text-xs text-slate-500">{d}</div></div>
              ))}
            </div>
          </section>

          <section id="try" className="scroll-mt-24 space-y-3">
            <h2 className="text-lg font-bold text-navy">Try it live</h2>
            <p className="text-sm text-slate-600">Paste a key, pick a GET endpoint, and call the real API. Your key stays in this page only.</p>
            <TryConsole origin={origin} />
          </section>

          <section id="base-url" className="scroll-mt-24 space-y-3">
            <h2 className="text-lg font-bold text-navy">Base URL</h2>
            <Code>{`${origin}/api/v1`}</Code>
          </section>

          <section id="auth" className="scroll-mt-24 space-y-3">
            <h2 className="text-lg font-bold text-navy">Authentication</h2>
            <p className="text-sm text-slate-600">
              The super-admin creates keys under <strong>Settings → API Keys</strong>. Keys look like
              {' '}<Mono>crmk_live_…</Mono> (or <Mono>crmk_test_…</Mono>) and are shown once at creation — copy then.
              Send on every request; either header works:
            </p>
            <Code>{`X-API-Key: crmk_live_your_key`}</Code>
            <Code>{`Authorization: Bearer crmk_live_your_key`}</Code>
            <Code>{`curl -H "X-API-Key: crmk_live_your_key" ${origin}/api/v1/ping`}</Code>
          </section>

          <section id="realms-scopes" className="scroll-mt-24 space-y-3">
            <h2 className="text-lg font-bold text-navy">Realms &amp; scopes</h2>
            <p className="text-sm leading-relaxed text-slate-600">Realms decide <em>which endpoints</em>; scopes decide <em>which fields</em>. Check your grants with <Mono>GET /api/v1/ping</Mono>.</p>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Realms</div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-2 font-semibold">Realm</th><th className="px-4 py-2 font-semibold">Reaches</th><th className="px-4 py-2 font-semibold">Requires scope</th></tr></thead>
                <tbody>{REALM_DOCS.map((r) => <tr key={r.key} className="border-t border-slate-100"><td className="px-4 py-2"><Mono>{r.key}</Mono></td><td className="px-4 py-2 text-slate-600">{r.reach}</td><td className="px-4 py-2">{r.needs ? <Mono>{r.needs}</Mono> : <span className="text-slate-300">—</span>}</td></tr>)}</tbody></table>
            </div>
            <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Scopes</div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-2 font-semibold">Scope</th><th className="px-4 py-2 font-semibold">Unlocks</th><th className="px-4 py-2 font-semibold" /></tr></thead>
                <tbody>{SCOPE_DOCS.map((s) => <tr key={s.key} className="border-t border-slate-100"><td className="px-4 py-2"><Mono>{s.key}</Mono></td><td className="px-4 py-2 text-slate-600">{s.gives}</td><td className="px-4 py-2 text-xs text-slate-400">{s.note}</td></tr>)}</tbody></table>
            </div>
            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <div><strong>Field gating is silent.</strong> A field your key lacks the scope for is omitted, not an error. The response’s <Mono>_meta.withheld</Mono> lists every dropped field name.</div>
              <div><strong>Finance &amp; Vendors are stricter.</strong> Those realms are entirely sensitive, so their scope (<Mono>read:money</Mono> / <Mono>read:parties</Mono>) is required to call the endpoint at all — else <Mono>forbidden_scope (403)</Mono>.</div>
            </div>
            <div><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Example — a key without read:money</div>
              <Code>{`{\n  "data": [\n    { "id": "po_88f2", "number": "PO-0007", "status": "APPROVED",\n      "deepLink": "${origin}/go/po/po_88f2?project=clx123abc" }\n  ],\n  "page": { "limit": 50, "offset": 0, "total": 1, "hasMore": false },\n  "_meta": { "withheld": ["basicAmount", "finalAmount", "vendor"] }\n}`}</Code>
            </div>
          </section>

          <section id="conventions" className="scroll-mt-24 space-y-3">
            <h2 className="text-lg font-bold text-navy">Conventions</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-600">
              <li>Lists return <Mono>{'{ data: [...], page: { limit, offset, total, hasMore } }'}</Mono>.</li>
              <li>Single items return <Mono>{'{ data: {...} }'}</Mono>.</li>
              <li>Errors return <Mono>{'{ error: { code, message } }'}</Mono> — branch on the stable <Mono>code</Mono>.</li>
              <li>Paginate with <Mono>?limit=</Mono> (1–200, default 50) and <Mono>?offset=</Mono> (≥0).</li>
              <li>Dates are ISO 8601 UTC or <Mono>null</Mono>; money fields are plain numbers (INR).</li>
              <li>Every object includes a <Mono>deepLink</Mono>; dropped fields appear in <Mono>_meta.withheld</Mono>.</li>
              <li>Rate-limit headers ride every response: <Mono>X-RateLimit-Limit / -Remaining / -Reset</Mono>.</li>
            </ul>
          </section>

          <section id="limits" className="scroll-mt-24 space-y-3">
            <h2 className="text-lg font-bold text-navy">Limits &amp; versioning</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {[['Versioning', 'Version is in the path: /api/v1/…. v1 stays stable; breaking changes ship under a new version.'],
                ['Rate limits', 'Per-key, per-minute (default 600). X-RateLimit-* on every response; 429 + Retry-After on exceed.'],
                ['Pagination', 'limit (1–200, default 50) + offset. page.hasMore tells you when to fetch more.'],
                ['CORS', 'Shares the dashboard origin; browser calls from CRMCTS pages work. Server-to-server has no origin restriction.'],
                ['Permissions', 'Read-only unless the key has a write:* scope. Realms gate endpoints; scopes gate fields.'],
                ['Stability', 'Fields are only added within a version. Ignore unknown fields for forward-compatibility.']].map(([h, d]) => (
                <div key={h} className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-sm font-semibold text-navy">{h}</div><div className="mt-0.5 text-xs text-slate-500">{d}</div></div>
              ))}
            </div>
          </section>

          <section className="scroll-mt-24 space-y-3"><h2 className="text-xl font-bold text-navy">Endpoints</h2><p className="text-sm text-slate-600">All require a valid API key.</p></section>
          {ENDPOINTS.map((g) => (
            <section key={g.anchor} id={g.anchor} className="scroll-mt-24 space-y-4">
              <h3 className="text-base font-bold text-navy">{g.group}</h3>
              {g.items.map((e) => <EndpointCard key={e.id} e={e} origin={origin} />)}
            </section>
          ))}

          {/* Write endpoints */}
          <section id="writes" className="scroll-mt-24 space-y-4">
            <h2 className="text-xl font-bold text-navy">Write endpoints</h2>
            <p className="text-sm leading-relaxed text-slate-600">
              Task actions mirror the dashboard’s own buttons — the API is just another caller of the same domain logic.
              They need the <Mono>timeline</Mono> realm <strong>and</strong> the <Mono>write:tasks</Mono> scope; a read-only key
              gets <Mono>forbidden_scope (403)</Mono>. Pass an <Mono>Idempotency-Key</Mono> header so a retried request never acts twice.
            </p>
            {WRITE_OPS.map((w) => (
              <div key={w.id} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-block rounded bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-700">{w.method}</span>
                  <code className="font-mono text-sm font-semibold text-navy">{w.path}</code>
                </div>
                <p className="text-sm text-slate-600">{w.desc}</p>
                {w.body && <FieldTable title="Request body" fields={w.body} />}
                <div><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Example response · 200</div><Code>{w.sample}</Code></div>
              </div>
            ))}
            <Code>{writeExample}</Code>
          </section>

          <section id="deep-links" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-bold text-navy">Deep links</h2>
            <p className="text-sm leading-relaxed text-slate-600">Every object includes a <Mono>deepLink</Mono>. Point a user at it and CRMCTS opens that exact item — right project, right tab, item expanded. Not signed in? They’re prompted, then returned to the item. Format: {' '}<Mono>{`${origin}/go/{entity}/{id}?project={projectId}`}</Mono>.</p>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-2 font-semibold">Entity</th><th className="px-4 py-2 font-semibold">Link pattern</th><th className="px-4 py-2 font-semibold">Opens</th></tr></thead>
                <tbody>{DEEP_ENTITIES.map((d) => <tr key={d.entity} className="border-t border-slate-100"><td className="px-4 py-2"><Mono>{d.entity}</Mono></td><td className="px-4 py-2 font-mono text-xs text-slate-600">{d.link}</td><td className="px-4 py-2 text-xs text-slate-500">{d.dest}</td></tr>)}</tbody></table>
            </div>
          </section>

          <section id="errors" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-bold text-navy">Errors</h2>
            <p className="text-sm text-slate-600">Failures return <Mono>{'{ error: { code, message } }'}</Mono>. Branch on the stable <Mono>code</Mono>:</p>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-2 font-semibold">HTTP</th><th className="px-4 py-2 font-semibold">code</th><th className="px-4 py-2 font-semibold">When</th></tr></thead>
                <tbody>{ERRORS.map((e, i) => <tr key={e.code + e.err} className={i ? 'border-t border-slate-100' : ''}><td className="w-16 px-4 py-2 align-top font-mono font-semibold text-navy">{e.code}</td><td className="w-40 px-4 py-2 align-top font-mono text-xs text-slate-500">{e.err}</td><td className="px-4 py-2 text-slate-600">{e.when}</td></tr>)}</tbody></table>
            </div>
          </section>

          <section id="examples" className="scroll-mt-24 space-y-4">
            <h2 className="text-xl font-bold text-navy">Code examples</h2>
            <div className="space-y-1"><div className="text-sm font-semibold text-slate-500">cURL</div><Code>{curlExample}</Code></div>
            <div className="space-y-1"><div className="text-sm font-semibold text-slate-500">JavaScript (fetch)</div><Code>{jsExample}</Code></div>
            <div className="space-y-1"><div className="text-sm font-semibold text-slate-500">Python (requests)</div><Code>{pyExample}</Code></div>
          </section>

          <section id="downloads" className="scroll-mt-24 space-y-3">
            <h2 className="text-xl font-bold text-navy">Downloads</h2>
            <p className="text-sm text-slate-600">Import the API into your tooling — base URL is pre-set for this host.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => downloadJson('crmcts-openapi.json', buildOpenApi(origin))} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-slate-50">↓ OpenAPI 3.0 (JSON)</button>
              <button onClick={() => downloadJson('crmcts-postman-collection.json', buildPostman(origin))} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-slate-50">↓ Postman collection</button>
            </div>
            <p className="text-xs text-slate-400">After importing, set the <Mono>apiKey</Mono> variable (and <Mono>projectId</Mono> / <Mono>taskId</Mono> where needed).</p>
          </section>

          <section id="recipes" className="scroll-mt-24 space-y-4">
            <h2 className="text-xl font-bold text-navy">Recipes</h2>
            <div className="space-y-1"><div className="text-sm font-semibold text-slate-500">Overdue tasks → a link to fix each</div><Code>{recipeOverdue}</Code></div>
          </section>

          <footer className="border-t border-slate-200 pt-6 text-center text-xs text-slate-400">CRMCTS · Crystal Group — Cold Room Management &amp; Construction Tracking System</footer>
        </main>
      </div>
    </div>
  );
}
