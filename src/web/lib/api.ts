import type { DirectoryTree, EngineInfo, HistoryMessage, ServerConfig, SessionSummary } from '@shared/protocol';
import { authHeaders, BASE } from '@/lib/page';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

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
