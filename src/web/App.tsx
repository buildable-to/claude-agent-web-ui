import { useEffect, useState } from 'react';
import type { ServerConfig } from '@shared/protocol';

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);
  return (
    <main className="flex h-screen items-center justify-center text-ink">
      <p className="font-mono text-sm">
        {config ? `project: ${config.projectDir}` : 'connecting to server…'}
      </p>
    </main>
  );
}
