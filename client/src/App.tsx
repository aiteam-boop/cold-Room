import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import type { PageKey } from './lib/permissions';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import ProjectsList from './pages/ProjectsList';
import ProjectWorkspace from './pages/ProjectWorkspace';
import VendorsPage from './pages/VendorsPage';
import PettyCashPage from './pages/PettyCashPage';
import ApprovalsPage from './pages/ApprovalsPage';
import MasterReports from './pages/MasterReports';
import UsersAdmin from './pages/UsersAdmin';
import ApiKeysAdmin from './pages/ApiKeysAdmin';
import MachineModelsPage from './pages/MachineModelsPage';
import IntegrationKit from './pages/IntegrationKit';
import GoResolver from './pages/GoResolver';
import PublicGrn from './pages/PublicGrn';
import AppShell from './components/AppShell';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner label="Loading…" />;
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  return children;
}

// Block a route the user has no page grant for — covers URL / direct-link /
// manual-navigation access, not just hidden nav links.
function RequirePage({ page, children }: { page: PageKey; children: JSX.Element }) {
  const { canView } = useAuth();
  if (!canView(page)) return <Navigate to="/" replace />;
  return children;
}

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

// Key management is a security surface — gated to the single super-admin, and
// the route simply isn't reachable for anyone else.
function RequireSuperAdmin({ children }: { children: JSX.Element }) {
  const { isSuperAdmin } = useAuth();
  if (!isSuperAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Public — no auth. Documents the API for integrators. */}
      <Route path="/integration-kit" element={<IntegrationKit />} />
      {/* Public — no auth. Site-engineer goods-receipt form (token is the key). */}
      <Route path="/grn/:token" element={<PublicGrn />} />
      {/* Deep-link resolver — authed but outside the shell; it redirects instantly. */}
      <Route path="/go/:entity/:id" element={<RequireAuth><GoResolver /></RequireAuth>} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<ProjectsList />} />
        <Route path="/projects/:projectId" element={<ProjectWorkspace />} />
        <Route path="/vendors" element={<RequirePage page="vendors"><VendorsPage /></RequirePage>} />
        <Route path="/petty-cash" element={<RequirePage page="pettycash"><PettyCashPage /></RequirePage>} />
        <Route path="/approvals" element={<RequirePage page="approvals"><ApprovalsPage /></RequirePage>} />
        <Route path="/reports" element={<RequirePage page="reports"><MasterReports /></RequirePage>} />
        <Route path="/settings/users" element={<RequireAdmin><UsersAdmin /></RequireAdmin>} />
        <Route path="/settings/api-keys" element={<RequireSuperAdmin><ApiKeysAdmin /></RequireSuperAdmin>} />
        <Route path="/settings/machine-models" element={<RequirePage page="machinemodels"><MachineModelsPage /></RequirePage>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
