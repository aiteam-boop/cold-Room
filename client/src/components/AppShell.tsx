import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import NotificationBell from './NotificationBell';

export default function AppShell() {
  const { user, logout, isAdmin, canView } = useAuth();
  const navCls = ({ isActive }: { isActive: boolean }) => `rounded-lg px-2.5 py-1.5 ${isActive ? 'bg-white/15 text-white' : 'text-slate-200 hover:bg-white/10'}`;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-navy text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/10">❄</span>
              <span>CRMCTS</span>
            </Link>
            <nav className="hidden items-center gap-1 text-sm md:flex">
              <NavLink to="/" end className={navCls}>Projects</NavLink>
              {canView('vendors') && <NavLink to="/vendors" className={navCls}>Vendors</NavLink>}
              {canView('approvals') && <NavLink to="/approvals" className={navCls}>Approvals</NavLink>}
              {isAdmin && <NavLink to="/settings/users" className={navCls}>Users</NavLink>}
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
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
