import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import type { PageKey } from './lib/permissions';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import ProjectsList from './pages/ProjectsList';
import ProjectWorkspace from './pages/ProjectWorkspace';
import VendorsPage from './pages/VendorsPage';
import ApprovalsPage from './pages/ApprovalsPage';
import UsersAdmin from './pages/UsersAdmin';
import MachineModelsPage from './pages/MachineModelsPage';
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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
        <Route path="/approvals" element={<RequirePage page="approvals"><ApprovalsPage /></RequirePage>} />
        <Route path="/settings/users" element={<RequireAdmin><UsersAdmin /></RequireAdmin>} />
        <Route path="/settings/machine-models" element={<RequirePage page="machinemodels"><MachineModelsPage /></RequirePage>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
