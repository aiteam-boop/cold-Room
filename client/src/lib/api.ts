import axios from 'axios';

export const api = axios.create({ baseURL: '/api' });

const TOKEN_KEY = 'crmcts_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && getToken()) {
      setToken(null);
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// Authenticated file download (reports). Anchor hrefs can't carry the bearer
// token, so we fetch as a blob and trigger a download.
export async function downloadFile(url: string, fallbackName: string) {
  const res = await api.get(url, { responseType: 'blob' });
  const disp = res.headers['content-disposition'] as string | undefined;
  const match = disp?.match(/filename="?([^"]+)"?/);
  const name = match?.[1] || fallbackName;
  const blobUrl = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// Open an authenticated file (e.g. server-generated PDF) in a new tab. Anchor
// hrefs can't carry the bearer token, so fetch as a blob first. Pass a path
// WITHOUT the /api prefix (it's added by the axios baseURL).
export async function openAuthedFile(path: string) {
  try {
    const res = await api.get(path, { responseType: 'blob' });
    const blobUrl = URL.createObjectURL(res.data as Blob);
    window.open(blobUrl, '_blank');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (e) {
    alert(errMsg(e));
  }
}

// Pull a human-friendly error message out of an axios error.
export function errMsg(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; details?: unknown } }; message?: string };
  return e.response?.data?.error || e.message || 'Something went wrong';
}
