/**
 * Is the running backend the code this dashboard was built against? The backend runs
 * from source and only picks up an update when restarted; the dashboard only when rebuilt.
 */
export type CodeMismatch = 'backend_older' | 'dashboard_older';

export function codeMismatch(server: { fingerprint: string; startedAt: number } | null | undefined, built: { fingerprint: string; at: number }): CodeMismatch | undefined {
  if (server === undefined) return undefined; // not connected yet
  // A backend that doesn't report its code predates this check: older.
  if (server === null) return 'backend_older';
  if (server.fingerprint === built.fingerprint) return undefined;
  return server.startedAt < built.at ? 'backend_older' : 'dashboard_older';
}
