import { Navigate, useParams, useSearchParams } from 'react-router-dom';

// Deep-link resolver. Every entity returned by the public API carries a link of
// the form `/go/:entity/:id?project=<projectId>`. This route (behind auth) turns
// that into the real in-app destination: the project workspace, on the right tab,
// with the item opened — so following a link from an integration lands the user
// exactly where they can act on that thing.
const PROJECT_TAB: Record<string, string> = {
  po: 'po', wo: 'wo', grn: 'grn', payment: 'payment', task: 'task', boq: 'boq',
};

export default function GoResolver() {
  const { entity = '', id = '' } = useParams<{ entity: string; id: string }>();
  const [sp] = useSearchParams();
  const projectId = sp.get('project');

  // Global entities resolve to their own pages.
  if (entity === 'vendor') return <Navigate to="/vendors" replace />;
  if (entity === 'project' && id) return <Navigate to={`/projects/${id}`} replace />;

  // Everything else is project-scoped and needs the owning project.
  if (id && projectId && PROJECT_TAB[entity]) {
    return <Navigate to={`/projects/${projectId}?open=${entity}:${id}`} replace />;
  }
  // Unknown / malformed link — fall back to the project (if known) or home.
  return <Navigate to={projectId ? `/projects/${projectId}` : '/'} replace />;
}
