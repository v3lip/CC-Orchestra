import type { BatchView, CampaignInput, ChunkNeed, DepotInput, DepotView, GroupView, InstanceView, JobEstimate, JobInput, JobView, MapBlock, Targets, TurtleView, Vec3 } from '@ccfleet/protocol';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth')) onUnauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  me: () => req<{ loggedIn: boolean }>('GET', '/api/auth/me'),
  login: (password: string) => req<{ ok: true }>('POST', '/api/auth/login', { password }),
  logout: () => req<{ ok: true }>('POST', '/api/auth/logout', {}),
  instances: () => req<InstanceView[]>('GET', '/api/instances'),
  createInstance: (name: string) => req<InstanceView[]>('POST', '/api/instances', { name }),
  renameInstance: (from: string, to: string) => req<InstanceView[]>('PATCH', `/api/instances/${encodeURIComponent(from)}`, { name: to }),
  deleteInstance: (name: string) => req<InstanceView[]>('DELETE', `/api/instances/${encodeURIComponent(name)}`),
  ores: (world: string, dimension: string) =>
    req<{ ores: MapBlock[] }>('GET', `/api/map/ores?world=${encodeURIComponent(world)}&dimension=${encodeURIComponent(dimension)}`),
  info: () => req<{ publicUrl: string; worlds: { world: string; dimension: string }[] }>('GET', '/api/info'),

  command: (targets: Targets, op: string, args: Record<string, unknown> = {}) => req<BatchView>('POST', '/api/commands', { targets, op, args }),
  stop: (targets: Targets, reason: 'estop' | 'pause') => req<BatchView>('POST', '/api/stop', { targets, reason }),
  resume: (targets: Targets) => req<BatchView>('POST', '/api/resume', { targets }),
  cancel: (targets: Targets) => req<BatchView>('POST', '/api/cancel', { targets }),

  updateTurtle: (id: string, patch: { name?: string; world?: string; dimension?: string }) => req<TurtleView>('PATCH', `/api/turtles/${id}`, patch),
  removeTurtle: (id: string) => req<{ ok: true }>('DELETE', `/api/turtles/${id}`),
  enroll: (body: { name?: string; world?: string; dimension?: string; groupId?: string }) =>
    req<{ code: string; expiresAt: number; publicUrl: string }>('POST', '/api/enrollments', body),

  createGroup: (name: string, memberIds: string[]) => req<GroupView>('POST', '/api/groups', { name, memberIds }),
  setMembers: (id: string, memberIds: string[]) => req<GroupView>('PUT', `/api/groups/${id}/members`, { memberIds }),
  renameGroup: (id: string, name: string) => req<GroupView>('PATCH', `/api/groups/${id}`, { name }),
  deleteGroup: (id: string) => req<{ ok: true }>('DELETE', `/api/groups/${id}`),

  saveDepot: (d: Omit<DepotInput, 'waiting'> & { waiting?: DepotInput['waiting'] }, id?: string) => req<DepotView>(id ? 'PUT' : 'POST', id ? `/api/depots/${id}` : '/api/depots', d),
  deleteDepot: (id: string) => req<{ ok: true }>('DELETE', `/api/depots/${id}`),
  estimateJob: (j: JobInput) => req<{ estimate: JobEstimate; warnings: string[]; chunks: ChunkNeed[] }>('POST', '/api/jobs/estimate', j),
  createJob: (j: JobInput) => req<JobView>('POST', '/api/jobs', j),
  startJob: (id: string) => req<JobView>('POST', `/api/jobs/${id}/start`, {}),
  pauseJob: (id: string) => req<JobView>('POST', `/api/jobs/${id}/pause`, {}),
  cancelJob: (id: string) => req<JobView>('POST', `/api/jobs/${id}/cancel`, {}),
  deleteJob: (id: string) => req<{ ok: true }>('DELETE', `/api/jobs/${id}`),
  setForcedChunk: (c: { world: string; dimension: string; cx: number; cz: number; forced: boolean }) => req<unknown>('POST', '/api/forced-chunks', c),
  createCampaign: (c: CampaignInput) => req<{ campaignId: string; jobs: JobView[]; skipped: string[] }>('POST', '/api/campaigns', c),
  campaignAction: (id: string, action: 'start' | 'pause' | 'cancel') => req<{ jobId: string; ok: boolean; error?: string }[]>('POST', `/api/campaigns/${id}/${action}`, {}),
  turtlesJobs: (turtleIds: string[], action: 'start' | 'pause' | 'cancel') => req<{ jobId: string; ok: boolean; error?: string }[]>('POST', '/api/jobs/by-turtles', { turtleIds, action }),
  goto: (turtleId: string, target: Vec3) => req<{ ok: true }>('POST', '/api/goto', { turtleId, target }),

  mapBlocks: (q: { world: string; dimension: string; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }) =>
    req<{ blocks: MapBlock[]; truncated: boolean }>('GET', `/api/map/blocks?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`),
};
