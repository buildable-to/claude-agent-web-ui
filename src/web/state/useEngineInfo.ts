import { useEffect, useState } from 'react';
import type { EngineInfo, SessionMeta } from '@shared/protocol';
import { api } from '@/lib/api';

/**
 * Commands, skills and models for the pickers. Starts from the server's
 * probe and switches to the running engine's own lists once a session
 * reports them.
 */
export function useEngineInfo(meta: SessionMeta) {
  const [probed, setProbed] = useState<EngineInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .engine()
      .then((info) => {
        if (!cancelled) setProbed(info);
      })
      .catch(() => {
        if (!cancelled) setProbed({ commands: [], models: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    commands: meta.commands ?? probed?.commands ?? [],
    models: meta.models ?? probed?.models ?? [],
    loading: loading && !meta.commands,
  };
}
