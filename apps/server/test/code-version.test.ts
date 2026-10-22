import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendFingerprint } from '../src/codeVersion';
import { startServer } from './helpers';

let server: Awaited<ReturnType<typeof startServer>> | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ccf-code-'));
  dirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

describe('backend code fingerprint', () => {
  it('ignores line endings and changes when the code does', () => {
    const a = repo({ 'apps/server/src/a.ts': 'x\ny\n', 'packages/protocol/src/b.ts': 'z\n' });
    const crlf = repo({ 'apps/server/src/a.ts': 'x\r\ny\r\n', 'packages/protocol/src/b.ts': 'z\r\n' });
    const changed = repo({ 'apps/server/src/a.ts': 'x\ny2\n', 'packages/protocol/src/b.ts': 'z\n' });
    expect(backendFingerprint(a)).toBe(backendFingerprint(crlf));
    expect(backendFingerprint(a)).not.toBe(backendFingerprint(changed));
  });

  it('the dashboard gets the running code in its first message', async () => {
    server = await startServer();
    const init = server.fleet.initMessage();
    expect(init.type === 'init' && init.server?.fingerprint).toBe(backendFingerprint());
  });
});
