import type { HistoryMessage, ServerConfig, SessionSummary } from '@shared/protocol';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
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
  sessions: () => request<SessionSummary[]>('/api/sessions'),
  history: (id: string) => request<HistoryMessage[]>(`/api/sessions/${id}/messages`),
  rename: (id: string, title: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
};
