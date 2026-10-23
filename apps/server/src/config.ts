import { join, resolve } from 'node:path';
import { randomToken } from './util';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  adminPassword: string;
  publicUrl: string;
  /** Directory with the built dashboard (served in production). */
  webDist?: string;
  /** Directory with the Lua agent files served to turtles. */
  turtleDir: string;
  /** Secure cookies require HTTPS; off by default for local HTTP setups. */
  secureCookies: boolean;
  /** Chat webhook (Discord, Slack, ...) for job notifications; off when unset. */
  notifyUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const dataDir = resolve(repoRoot, env.DATA_DIR ?? './data');
  let adminPassword = env.ADMIN_PASSWORD ?? '';
  if (!adminPassword || adminPassword === 'change-me') {
    if (env.NODE_ENV === 'production') throw new Error('ADMIN_PASSWORD must be set in production');
    adminPassword = randomToken(9);
    console.warn(`[config] ADMIN_PASSWORD not set; using a one-off password for this run: ${adminPassword}`);
    console.warn('[config] Run `npm run setup` to create a persistent .env.');
  }
  const port = Number(env.PORT ?? 8787);
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    dataDir,
    dbFile: join(dataDir, 'fleet.sqlite'),
    adminPassword,
    publicUrl: env.PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    webDist: env.WEB_DIST ? resolve(repoRoot, env.WEB_DIST) : join(repoRoot, 'apps/web/dist'),
    turtleDir: join(repoRoot, 'turtle'),
    secureCookies: env.SECURE_COOKIES === '1',
    notifyUrl: webhookUrl(env.NOTIFY_WEBHOOK_URL),
  };
}

/** An http(s) URL, or undefined (with a warning) for anything else. */
function webhookUrl(v: string | undefined): string | undefined {
  if (!v?.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch {
    /* fall through */
  }
  console.warn('[config] NOTIFY_WEBHOOK_URL is not an http(s) URL; notifications are off');
  return undefined;
}
