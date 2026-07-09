import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, getToken, setToken } from './api';
import {
  canViewPage, canEditPage, hasSection, shouldHideFinancials,
  type PageKey, type SectionKey, type Grants, type SectionPerms,
} from './permissions';

// ADMIN = full access; any other value (USER, CEO, SITE_ENGINEER, …) is grant-based.
export type Role = 'ADMIN' | 'USER' | 'CEO' | 'SITE_ENGINEER';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  pageAccess: Grants;
  sectionPerms: SectionPerms;
  // Room-wise DPR is limited to specific owner accounts (server-computed).
  dprOwner?: boolean;
}

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  // Permission helpers (ADMIN always passes; never hides financials).
  isAdmin: boolean;
  // True only for the room-wise DPR owner account(s), not every admin.
  isDprOwner: boolean;
  canView: (page: PageKey) => boolean;
  canEdit: (page: PageKey) => boolean;
  can: (flag: SectionKey) => boolean;
  hideFinancials: boolean;
}

const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((r) => setUser(r.data.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const r = await api.post('/auth/login', { email, password });
    setToken(r.data.token);
    setUser(r.data.user);
  }
  async function register(name: string, email: string, password: string) {
    const r = await api.post('/auth/register', { name, email, password });
    setToken(r.data.token);
    setUser(r.data.user);
  }
  function logout() {
    setToken(null);
    setUser(null);
    location.href = '/login';
  }

  const value: AuthCtx = {
    user,
    loading,
    login,
    register,
    logout,
    isAdmin: user?.role === 'ADMIN',
    isDprOwner: !!user?.dprOwner,
    canView: (page) => canViewPage(user, page),
    canEdit: (page) => canEditPage(user, page),
    can: (flag) => hasSection(user, flag),
    hideFinancials: shouldHideFinancials(user),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
