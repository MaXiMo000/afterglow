/** Same-origin API client (docs/PLAN.md section 4). Only fixed paths and a validated 32-hex id are ever used. */
import type { RepoRef } from './repo';
import { validateResult, type Result } from './result';

export type Stage = 'queued' | 'cloning' | 'counting' | 'parsing' | 'sizing' | 'scoring' | 'done' | 'failed';
export type Progress = { status: 'queued' | 'running' | 'done' | 'failed'; stage: Stage; n: number; total: number; reason?: string };

const STAGES: readonly Stage[] = ['queued', 'cloning', 'counting', 'parsing', 'sizing', 'scoring', 'done', 'failed'];
const ID = /^[0-9a-f]{32}$/;
const REASON = /^[a-z_]{1,32}$/;

export class ApiError extends Error {
  constructor(readonly code: string, readonly retryAfter: number | null = null) {
    super(code);
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  let code = 'unavailable';
  try {
    const body: unknown = await res.json();
    const c = (body as { error?: unknown }).error;
    if (typeof c === 'string' && REASON.test(c)) code = c;
  } catch {
    /* non-JSON error body: keep the generic code */
  }
  const ra = Number(res.headers.get('retry-after'));
  return new ApiError(code, Number.isFinite(ra) && ra > 0 ? ra : null);
}

export async function startAnalysis(repo: RepoRef): Promise<{ id: string; done: boolean }> {
  const res = await fetch('/api/v1/analyses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Afterglow': '1' },
    body: JSON.stringify({ repo: `${repo.owner}/${repo.name}` }),
    credentials: 'omit',
  });
  if (res.status !== 200 && res.status !== 202) throw await errorOf(res);
  const body = (await res.json()) as { id?: unknown; status?: unknown };
  if (typeof body.id !== 'string' || !ID.test(body.id)) throw new ApiError('bad_response');
  return { id: body.id, done: body.status === 'done' };
}

function parseProgress(data: string): Progress | null {
  try {
    const p = JSON.parse(data) as Record<string, unknown>;
    const stage = p['stage'];
    const status = p['status'];
    const n = p['n'];
    const total = p['total'];
    if (typeof stage !== 'string' || !STAGES.includes(stage as Stage)) return null;
    if (status !== 'queued' && status !== 'running' && status !== 'done' && status !== 'failed') return null;
    if (!Number.isInteger(n) || !Number.isInteger(total)) return null;
    const out: Progress = { status, stage: stage as Stage, n: n as number, total: total as number };
    if (typeof p['reason'] === 'string' && REASON.test(p['reason'])) out.reason = p['reason'];
    return out;
  } catch {
    return null;
  }
}

/** Follow SSE progress until done/failed. Resolves on done, rejects with the reason code on failure. */
export function followProgress(id: string, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
  if (!ID.test(id)) return Promise.reject(new ApiError('bad_response'));
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/v1/analyses/${id}/events`);
    const stop = (): void => es.close();
    signal?.addEventListener('abort', () => {
      stop();
      reject(new ApiError('aborted'));
    });
    es.addEventListener('progress', (ev) => {
      const p = parseProgress((ev as MessageEvent<string>).data);
      if (!p) return;
      onProgress(p);
      if (p.status === 'done') {
        stop();
        resolve();
      } else if (p.status === 'failed') {
        stop();
        reject(new ApiError(p.reason ?? 'failed'));
      }
    });
    es.onerror = () => {
      // EventSource retries on its own; give up only if the server closed us out entirely.
      if (es.readyState === EventSource.CLOSED) reject(new ApiError('unavailable'));
    };
  });
}

export async function fetchResult(id: string): Promise<Result> {
  if (!ID.test(id)) throw new ApiError('bad_response');
  const res = await fetch(`/api/v1/analyses/${id}`, { credentials: 'omit' });
  if (res.status !== 200) throw await errorOf(res);
  return validateResult(await res.json());
}
