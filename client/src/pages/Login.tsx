import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { errMsg } from '../lib/api';

const DEMO = [
  { role: 'Admin', email: 'admin@crmcts.dev' },
  { role: 'Engineer', email: 'engineer@crmcts.dev' },
  { role: 'Supervisor', email: 'supervisor@crmcts.dev' },
  { role: 'Client', email: 'client@crmcts.dev' },
  { role: 'Management', email: 'management@crmcts.dev' },
];

export default function Login() {
  const { user, login, register } = useAuth();
  const nav = useNavigate();
  // Where to land after signing in. When arriving via a protected deep link
  // (e.g. an item's /go/… link) RequireAuth stashes the target here, so login
  // resumes straight to that item instead of dumping the user on the home page.
  const loc = useLocation();
  const from = (loc.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const dest = from?.pathname ? `${from.pathname}${from.search ?? ''}` : '/';
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  // Fields start empty so credentials are never pre-filled for visitors. (The
  // demo-account shortcuts below only exist in local dev.)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={dest} replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password);
      nav(dest, { replace: true });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-navy to-navy-700 p-4">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl md:grid-cols-2">
        <div className="hidden flex-col justify-between bg-navy p-8 text-white md:flex">
          <div>
            <div className="flex items-center gap-2 text-xl font-bold">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/10">❄</span> CRMCTS
            </div>
            <p className="mt-6 text-2xl font-semibold leading-snug">
              Cold Room Management & Construction Tracking
            </p>
            <p className="mt-3 text-sm text-slate-300">
              Real-time progress against BOQ baselines, interactive floor plans, delay-risk prediction
              and one-click reports.
            </p>
          </div>
          {/* Demo-account shortcuts: local development only — never rendered in
              the production build, so credentials are not exposed publicly. */}
          {import.meta.env.DEV && (
            <div className="rounded-xl bg-white/5 p-4 text-xs text-slate-300">
              <div className="mb-2 font-medium text-slate-200">Demo accounts (password: Password123)</div>
              {DEMO.map((d) => (
                <button
                  key={d.email}
                  onClick={() => { setEmail(d.email); setPassword('Password123'); setMode('login'); }}
                  className="mr-1 mb-1 rounded bg-white/10 px-2 py-1 hover:bg-white/20"
                >
                  {d.role}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-8">
          <h1 className="text-xl font-bold text-navy">{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'login' ? 'Welcome back. Enter your credentials.' : 'Register as a site engineer.'}
          </p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === 'register' && (
              <div>
                <label className="label">Full name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
            )}
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <div className="mt-4 text-center text-sm text-slate-500">
            {mode === 'login' ? (
              <>New engineer? <button className="font-medium text-navy" onClick={() => setMode('register')}>Register</button></>
            ) : (
              <>Have an account? <button className="font-medium text-navy" onClick={() => setMode('login')}>Sign in</button></>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
