import { describe, expect, it } from 'vitest';
import { codeMismatch } from '../src/lib/codeCheck';

describe('stale backend check', () => {
  const built = { fingerprint: 'abc', at: 1000 };
  it('says nothing before connecting, or when the code matches', () => {
    expect(codeMismatch(undefined, built)).toBeUndefined();
    expect(codeMismatch({ fingerprint: 'abc', startedAt: 500 }, built)).toBeUndefined();
  });
  it('a backend started before this build, on other code, needs a restart', () => {
    expect(codeMismatch({ fingerprint: 'old', startedAt: 500 }, built)).toBe('backend_older');
  });
  it('a backend that reports nothing predates the check', () => {
    expect(codeMismatch(null, built)).toBe('backend_older');
  });
  it('a backend started after the build, on other code, means the dashboard needs a rebuild', () => {
    expect(codeMismatch({ fingerprint: 'new', startedAt: 2000 }, built)).toBe('dashboard_older');
  });
});
