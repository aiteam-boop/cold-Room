import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import NotificationBell from './NotificationBell';
import ErrorBoundary from './ErrorBoundary';

export default function AppShell() {
  const { user, logout, isAdmin, isSuperAdmin, canView } = useAuth();
  const { pathname } = useLocation();
  const navCls = ({ isActive }: { isActive: boolean }) => `rounded-lg px-2.5 py-1.5 font-display font-semibold transition-colors ${isActive ? 'bg-white/15 text-white' : 'text-slate-200 hover:bg-white/10'}`;

  // The project workspace pins a rail to the viewport's left edge (see
  // ProjectWorkspace), so it must run full-bleed: a centred, max-width column
  // would drag the content away from that fixed rail. Every other page keeps the
  // centred column, capped so rows don't stretch on an ultra-wide display.
  const isWorkspace = /^\/projects\/[^/]+/.test(pathname);
  const container = 'mx-auto w-full max-w-[1920px] px-5 lg:px-6';

  return (
    <div className="min-h-screen">
      {/* h-14 (56px) is a fixed, known height — the workspace rail anchors itself
          directly beneath it with `top-14`. Don't change it without updating that. */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-navy text-white">
        <div className={`flex h-14 items-center justify-between gap-3 ${isWorkspace ? 'w-full px-5 lg:px-6' : container}`}>
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 font-display text-[15px] font-extrabold tracking-tight">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/10 text-gold">❄</span>
              <span>CRMCTS</span>
            </Link>
            <nav className="hidden items-center gap-1 text-sm md:flex">
              <NavLink to="/" end className={navCls}>Projects</NavLink>
              {canView('vendors') && <NavLink to="/vendors" className={navCls}>Vendors</NavLink>}
              {canView('pettycash') && <NavLink to="/petty-cash" className={navCls}>Petty Cash</NavLink>}
              {canView('travel') && <NavLink to="/travel" className={navCls}>Travel</NavLink>}
              {/* Approvals is a personal queue — always reachable so designated
                  approvers (who may lack the page grant) can act on their items. */}
              <NavLink to="/approvals" className={navCls}>Approvals</NavLink>
              {canView('reports') && <NavLink to="/reports" className={navCls}>Reports</NavLink>}
              {canView('po') && <NavLink to="/deposits" className={navCls}>Deposit Tracking</NavLink>}
              {canView('machinemodels') && <NavLink to="/settings/machine-models" className={navCls}>Machine Models</NavLink>}
              {isAdmin && <NavLink to="/settings/users" className={navCls}>Users</NavLink>}
              {isSuperAdmin && <NavLink to="/settings/api-keys" className={navCls}>API Keys</NavLink>}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
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
      </header>
      {/* The workspace owns its own padding (it has to clear the fixed rail). */}
      <main className={isWorkspace ? '' : `py-6 ${container}`}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
