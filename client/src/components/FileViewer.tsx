import { useEffect, useState } from 'react';
import { fetchAuthedBlobUrl } from '../lib/api';

// One file to view. `url` is either a public URL (/uploads/… or http) or an authed
// API path WITHOUT the /api prefix (set `authed: true` — it's fetched as a blob so
// the bearer token rides along). `name` drives the PDF-vs-image guess + the title.
export interface ViewFile { url: string; name: string; authed?: boolean; label?: string }

const isImage = (f: ViewFile) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(f.url) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');
const isPdf = (f: ViewFile) => /\.pdf(\?|$)/i.test(f.url) || /\.pdf$/i.test(f.name || '');

// A modal that shows PDFs and images inline (no new tab). Handles authed API files
// (fetched as a blob) and public URLs, with prev/next + a thumbnail strip when there
// is more than one. Reused for PO/WO/GRN/PI PDFs and GRN photos.
export function FileViewerModal({ items, startIndex = 0, title, onClose }: { items: ViewFile[]; startIndex?: number; title?: string; onClose: () => void }) {
  const [idx, setIdx] = useState(Math.min(startIndex, Math.max(items.length - 1, 0)));
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const cur = items[idx];

  useEffect(() => {
    if (!cur) return;
    let alive = true;
    let objectUrl: string | null = null;
    setLoading(true); setErr(''); setSrc(null);
    (async () => {
      try {
        if (cur.authed) { const b = await fetchAuthedBlobUrl(cur.url); if (!alive) { URL.revokeObjectURL(b); return; } objectUrl = b; setSrc(b); }
        else setSrc(cur.url);
      } catch { if (alive) setErr('Could not load this file.'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes; arrows move between attachments.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && idx < items.length - 1) setIdx((i) => i + 1);
      else if (e.key === 'ArrowLeft' && idx > 0) setIdx((i) => i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, items.length, onClose]);

  if (!cur) return null;
  const pdf = isPdf(cur);
  const img = isImage(cur);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-lg" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-navy">{title || cur.label || 'Attachment'}{items.length > 1 ? ` — ${idx + 1} of ${items.length}` : ''}</div>
            <div className="truncate text-[11px] text-slate-400">{cur.name}</div>
          </div>
          {items.length > 1 && (
            <div className="flex items-center gap-1">
              <button className="rounded border border-slate-300 px-2 py-0.5 text-sm disabled:opacity-30" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>‹</button>
              <button className="rounded border border-slate-300 px-2 py-0.5 text-sm disabled:opacity-30" disabled={idx === items.length - 1} onClick={() => setIdx((i) => i + 1)}>›</button>
            </div>
          )}
          {src && <a href={src} download={cur.name} target="_blank" rel="noreferrer" className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-navy hover:bg-slate-50" title="Download / open in new tab">⬇ Download</a>}
          <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {/* Body — fills the rest of the fixed-height modal; children scroll inside. */}
        <div className="flex min-h-0 flex-1 bg-slate-100">
          {/* Thumbnail strip — its OWN scrollbar, so the modal never grows/scrolls. */}
          {items.length > 1 && (
            <div className="w-24 shrink-0 space-y-2 overflow-y-auto border-r border-slate-200 bg-slate-50 p-2">
              {items.map((f, i) => (
                <button key={i} onClick={() => setIdx(i)} className={`block w-full overflow-hidden rounded border ${i === idx ? 'border-navy ring-2 ring-navy/30' : 'border-slate-200 hover:border-slate-300'}`} title={f.name}>
                  {isImage(f) && !f.authed
                    ? <img src={f.url} alt="" className="h-16 w-full object-cover" />
                    : <div className="flex h-16 w-full items-center justify-center bg-white text-2xl">{isImage(f) ? '🖼️' : '📄'}</div>}
                  <div className="truncate bg-white px-1 py-0.5 text-center text-[9px] text-slate-500">{f.label || `#${i + 1}`}</div>
                </button>
              ))}
            </div>
          )}

          {/* Viewer — fills the body; the file itself scrolls/zooms within it. */}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
            {loading ? <div className="p-10 text-sm text-slate-400">Loading…</div>
              : err ? <div className="p-10 text-sm text-rose-500">{err}</div>
              : !src ? null
              : img ? <img src={src} alt={cur.name} className="max-h-full max-w-full object-contain" />
              : <iframe src={pdf ? `${src}#toolbar=1` : src} title={cur.name} className="h-full w-full border-0 bg-white" />}
          </div>
        </div>
      </div>
    </div>
  );
}
