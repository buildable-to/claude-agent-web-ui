import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export type Config = {
  projectDir: string;
  port: number;
  host: string;
  production: boolean;
  /** Set = multi-account mode: one folder per account under this root. */
  agentsRoot?: string;
  /** HS256 secret shared with the app that mints the tokens. Empty = dev mode. */
  authSecret: string;
  /** Per-account settings.json to seed new folders with. */
  accountTemplate?: string;
};

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

export function loadConfig(): Config {
  const dirArg = readArg('dir') ?? process.env.PROJECT_DIR ?? process.cwd();
  const projectDir = resolve(dirArg);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const port = Number(readArg('port') ?? process.env.PORT ?? 3456);
  const host = readArg('host') ?? process.env.HOST ?? '127.0.0.1';
  const agentsRoot = readArg('agents-root') ?? process.env.AGENTS_ROOT;
  const accountTemplate = readArg('account-template') ?? process.env.ACCOUNT_SETTINGS_TEMPLATE;
  return {
    projectDir,
    port,
    host,
    production: process.env.NODE_ENV === 'production',
    ...(agentsRoot ? { agentsRoot: resolve(agentsRoot) } : {}),
    authSecret: readArg('auth-secret') ?? process.env.AGENT_AUTH_SECRET ?? '',
    ...(accountTemplate ? { accountTemplate: resolve(accountTemplate) } : {}),
  };
}

export function projectName(projectDir: string): string {
  return basename(projectDir) || projectDir;
}
