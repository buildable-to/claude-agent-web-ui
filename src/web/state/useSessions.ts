import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '@shared/protocol';
import { api } from '@/lib/api';
import { page } from '@/lib/page';

/** The session list, narrowed to the app project the page was opened on. */
export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.sessions(page.project));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { sessions, error, refresh };
}
