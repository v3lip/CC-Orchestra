/**
 * Fingerprint of the backend's code (server + shared protocol sources). The server
 * computes it when it starts; the dashboard build bakes in the one it was built against
 * (vite.config.ts). If they differ, one of them is stale: usually a backend that wasn't
 * restarted after an update.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, seen from this file (apps/server/src). */
export const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

export function backendFingerprint(root = REPO_ROOT): string {
  const h = createHash('sha256');
  for (const dir of ['apps/server/src', 'packages/protocol/src']) {
    const files: string[] = [];
    walk(join(root, dir), files);
    for (const f of files.sort()) {
      h.update(relative(root, f).replaceAll('\\', '/'));
      h.update('\0');
      // Line endings vary with git settings; the code doesn't.
      h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
      h.update('\0');
    }
  }
  return h.digest('hex').slice(0, 12);
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
}

let running: { fingerprint: string; startedAt: number } | undefined;

/** This process's code, fixed when it started (tsx doesn't reload). */
export function runningCode(): { fingerprint: string; startedAt: number } {
  return (running ??= { fingerprint: backendFingerprint(), startedAt: Date.now() });
}
