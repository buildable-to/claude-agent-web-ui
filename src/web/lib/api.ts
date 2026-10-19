import type { Attachment, DirectoryTree, EngineInfo, HistoryMessage, ServerConfig, SessionSummary } from '@shared/protocol';
import { authHeaders, authQuery, BASE, withAccount } from '@/lib/page';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  sessions: (project?: string | null, subject?: string | null) =>
    request<SessionSummary[]>(project ? `/api/sessions?project=${encodeURIComponent(project)}`
      : subject ? `/api/sessions?subject=${encodeURIComponent(subject)}` : '/api/sessions'),
  /** Which element a library conversation is about (ezdxf-flask #723). */
  setSubject: (id: string, subject: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ subject }) }),
  tree: () => request<DirectoryTree>('/api/tree'),
  engine: () => request<EngineInfo>('/api/engine'),
  history: (id: string) => request<HistoryMessage[]>(`/api/sessions/${id}/messages`),
  rename: (id: string, title: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  /** A file for the next message, into the desk's `attached/` folder. */
  attach: (body: Blob, name: string) =>
    request<Attachment>(`/api/attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body,
      headers: { 'content-type': body.type || 'application/octet-stream' },
    }),
};
