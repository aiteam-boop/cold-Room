import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import NotificationBell from './NotificationBell';
import ErrorBoundary from './ErrorBoundary';

export default function AppShell() {
  const { user, logout, isAdmin, isSuperAdmin, canView } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const navCls = ({ isActive }: { isActive: boolean }) => `rounded-lg px-2.5 py-1.5 font-display font-semibold transition-colors ${isActive ? 'bg-white/15 text-white' : 'text-slate-200 hover:bg-white/10'}`;
  const mNavCls = ({ isActive }: { isActive: boolean }) => `block rounded-lg px-3 py-2 font-display font-semibold ${isActive ? 'bg-white/15 text-white' : 'text-slate-200 hover:bg-white/10'}`;

  // The nav links — identical set for the desktop bar and the mobile menu, so the
  // two never drift. `cls` picks the right styling for each context.
  const links = (cls: typeof navCls) => (
    <>
      <NavLink to="/" end className={cls}>Projects</NavLink>
      {canView('vendors') && <NavLink to="/vendors" className={cls}>Vendors</NavLink>}
      {/* New Advance now lives as the first tab inside Travel. Keep a standalone
          link only for users who can't reach it via Travel. */}
      {canView('pettycash') && !canView('travel') && <NavLink to="/petty-cash" className={cls}>New Advance</NavLink>}
      {canView('travel') && <NavLink to="/travel" className={cls}>Travel</NavLink>}
      {/* Approvals is a personal queue — always reachable so designated approvers
          (who may lack the page grant) can act on their items. */}
      <NavLink to="/approvals" className={cls}>Approvals</NavLink>
      {canView('reports') && <NavLink to="/reports" className={cls}>Reports</NavLink>}
      {canView('siteforms') && <NavLink to="/site-forms" className={cls}>Site Forms</NavLink>}
      {canView('attendance') && <NavLink to="/attendance" className={cls}>Attendance</NavLink>}
      {canView('po') && <NavLink to="/deposits" className={cls}>Deposit Tracking</NavLink>}
      {canView('machinemodels') && <NavLink to="/settings/machine-models" className={cls}>Machine Models</NavLink>}
      {isAdmin && <NavLink to="/settings/users" className={cls}>Users</NavLink>}
      {isSuperAdmin && <NavLink to="/settings/api-keys" className={cls}>API Keys</NavLink>}
    </>
  );

  // The project workspace pins a rail to the viewport's left edge (see
  // ProjectWorkspace), so it must run full-bleed: a centred, max-width column
  // would drag the content away from that fixed rail. Every other page keeps the
  // centred column, capped so rows don't stretch on an ultra-wide display.
  const isWorkspace = /^\/projects\/[^/]+/.test(pathname);
  const container = 'mx-auto w-full max-w-[1920px] px-4 sm:px-5 lg:px-6';

  return (
    <div className="min-h-screen">
      {/* h-14 (56px) is a fixed, known height — the workspace rail anchors itself
          directly beneath it with `top-14`. Don't change it without updating that. */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-navy text-white">
        <div className={`flex h-14 items-center justify-between gap-3 ${isWorkspace ? 'w-full px-4 sm:px-5 lg:px-6' : container}`}>
          <div className="flex items-center gap-2 md:gap-4">
            {/* Mobile menu toggle — only below md; the desktop nav is untouched. */}
            <button type="button" className="rounded-lg p-1.5 text-slate-200 hover:bg-white/10 md:hidden" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{menuOpen ? <><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></> : <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>}</svg>
            </button>
            <Link to="/" className="flex items-center gap-2 font-display text-[15px] font-extrabold tracking-tight">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/10 text-gold">❄</span>
              <span>CRMCTS</span>
            </Link>
            <nav className="hidden items-center gap-1 text-sm md:flex">
              {links(navCls)}
            </nav>
          </div>
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <NotificationBell />
            <div className="hidden text-right sm:block">
              <div className="font-medium leading-tight">{user?.name}</div>
              <div className="text-xs text-slate-300">{user?.role}</div>
            </div>
            <button onClick={logout} className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/20">
              Logout
            </button>
          </div>
        </div>

        {/* Mobile menu panel — same links as the desktop bar, only below md. */}
        {menuOpen && (
          <div className="border-t border-white/10 bg-navy px-4 pb-3 pt-2 md:hidden">
            <div className="mb-2 border-b border-white/10 pb-2">
              <div className="text-sm font-medium">{user?.name}</div>
              <div className="text-xs text-slate-300">{user?.role}</div>
            </div>
            <nav className="flex flex-col gap-1 text-sm" onClick={() => setMenuOpen(false)}>
              {links(mNavCls)}
            </nav>
          </div>
        )}
      </header>
      {/* The workspace owns its own padding (it has to clear the fixed rail).
          overflow-x-hidden on the normal column stops a stray wide element from
          forcing a page-wide horizontal scroll / zoom-out on mobile (the sticky
          header sits OUTSIDE main, so it is unaffected). Wide tables keep their own
          overflow-x-auto wrappers and scroll internally. Workspace is left untouched. */}
      <main className={isWorkspace ? '' : `overflow-x-hidden py-6 ${container}`}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
