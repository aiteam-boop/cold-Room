import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';

export default function NotificationBell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get('/notifications')).data as { notifications: any[]; unread: number },
    refetchInterval: 30_000,
  });
  const markRead = useMutation({ mutationFn: (id: string) => api.patch(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const markAll = useMutation({ mutationFn: () => api.patch('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });

  const unread = data?.unread ?? 0;
  const items = data?.notifications ?? [];

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-lg bg-white/10 p-2 hover:bg-white/20" title="Notifications">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-800 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <span className="text-sm font-semibold text-navy">Notifications</span>
              {unread > 0 && <button className="text-xs text-navy hover:underline" onClick={() => markAll.mutate()}>Mark all read</button>}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-400">No notifications yet.</div>
              ) : items.map((n) => (
                <button key={n.id} onClick={() => { if (!n.isRead) markRead.mutate(n.id); setOpen(false); const dest = n.type === 'APPROVAL_PENDING' ? '/approvals' : n.link; if (dest) nav(dest); }}
                  className={`block w-full border-b border-slate-50 px-3 py-2 text-left hover:bg-slate-50 ${n.isRead ? '' : 'bg-blue-50/40'}`}>
                  <div className="flex items-start gap-2">
                    {!n.isRead && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700">{n.title}</div>
                      <div className="text-xs text-slate-500">{n.message}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">{fmtDate(n.createdAt)}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
