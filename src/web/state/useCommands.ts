import { useEffect, useState } from 'react';
import type { CommandInfo } from '@shared/protocol';
import { api } from '@/lib/api';

/**
 * Slash commands / skills for the picker. Starts from the server's probe and
 * switches to the running engine's own list once a session reports one.
 */
export function useCommands(fromSession: CommandInfo[] | undefined) {
  const [probed, setProbed] = useState<CommandInfo[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .commands()
      .then((c) => {
        if (!cancelled) setProbed(c);
      })
      .catch(() => {
        if (!cancelled) setProbed([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { commands: fromSession ?? probed ?? [], loading: loading && !fromSession };
}
