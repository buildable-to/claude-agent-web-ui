import type { DirectoryTree, EngineInfo, HistoryMessage, ServerConfig, SessionSummary } from '@shared/protocol';
import { authHeaders, authQuery, BASE, page } from '@/lib/page';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function withAccount(path: string): string {
  if (page.token || !page.account) return path;
  return `${path}${path.includes('?') ? '&' : '?'}account=${encodeURIComponent(page.account)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${withAccount(path)}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // keep statusText
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/** True when this page's token (or dev account) is no longer accepted. */
export async function authExpired(): Promise<boolean> {
  try {
    await request<unknown>('/api/config');
    return false;
  } catch (err) {
    return err instanceof ApiError && err.status === 401;
  }
}

export { authQuery };

export const api = {
  config: () => request<ServerConfig>('/api/config'),
  sessions: (project?: string | null) =>
    request<SessionSummary[]>(project ? `/api/sessions?project=${encodeURIComponent(project)}` : '/api/sessions'),
  tree: () => request<DirectoryTree>('/api/tree'),
  engine: () => request<EngineInfo>('/api/engine'),
  history: (id: string) => request<HistoryMessage[]>(`/api/sessions/${id}/messages`),
  rename: (id: string, title: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
};
