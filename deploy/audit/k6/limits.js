// SECURITY section 8 / T11 load checks against the local stack, run by scripts/load-test.sh.
// Each k6 container is one client IP (Caddy sets X-Real-IP from the socket; it cannot be spoofed), and `hosts` maps
// localhost to Caddy so the Host and SNI are the only ones the stack accepts (T13).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = 'https://localhost:8443';
const H = { 'Content-Type': 'application/json', 'X-Afterglow': '1', Origin: BASE };
const MODE = __ENV.MODE;
const ME = __ENV.CLIENT || '0';
const codes = new Counter('status');

export const options = {
  hosts: { 'localhost:8443': `${__ENV.CADDY}:8443` },
  insecureSkipTLSVerify: true, // Caddy's local internal CA
  scenarios:
    MODE === 'soak'
      ? { soak: { executor: 'constant-arrival-rate', rate: 40, timeUnit: '1s', duration: __ENV.DURATION || '3m', preAllocatedVUs: 20 } }
      : MODE === 'sse'
        ? { sse: { executor: 'per-vu-iterations', vus: 6, iterations: 1 } }
        : { one: { executor: 'per-vu-iterations', vus: 1, iterations: 1 } },
  summaryTrendStats: ['p(50)', 'p(95)', 'max'],
};

const post = (repo) => http.post(`${BASE}/api/v1/analyses`, JSON.stringify({ repo }), { headers: H });
const tag = (r) => codes.add(1, { code: String(r.status) });

export default function () {
  if (MODE === 'rate') {
    // 15 POSTs in a burst from one client: the per-client bucket allows 10 per minute. Invalid names still count.
    const got = [];
    for (let i = 0; i < 15; i++) {
      const r = post('not a repo');
      tag(r);
      got.push(r.status);
      if (r.status === 429) check(r, { 'rate: 429 carries Retry-After': (x) => Number(x.headers['Retry-After']) > 0 });
    }
    console.log(`rate ${got.join(',')}`);
    check(got, { 'rate: first 10 reach the API (400)': (g) => g.slice(0, 10).every((s) => s === 400) });
    check(got, { 'rate: the rest are 429': (g) => g.slice(10).every((s) => s === 429) });
  } else if (MODE === 'jobs') {
    // Two queued jobs per client (the per-client cap); scripts/load-test.sh runs enough clients to pass MAX_QUEUE.
    const out = [];
    for (let i = 0; i < 3; i++) {
      const r = post(`loadtest/c${ME}-r${i}`);
      tag(r);
      out.push(r.status === 202 ? r.status : `${r.status}:${(r.json() || {}).error}`);
      if (r.status === 503) check(r, { 'queue: 503 carries Retry-After': (x) => Number(x.headers['Retry-After']) > 0 });
    }
    console.log(`jobs client=${ME} ${out.join(',')}`);
  } else if (MODE === 'sse') {
    // 6 concurrent streams on one job from one client: the gate allows 4 per client.
    const r = http.get(`${BASE}/api/v1/analyses/${__ENV.JOB}/events`, { timeout: '4s', headers: { Accept: 'text/event-stream' } });
    tag(r);
    console.log(`sse vu=${__VU} status=${r.status} ${r.error || ''}`);
  } else if (MODE === 'soak') {
    // Sustained mixed traffic (reads, bad ids, static) for the memory-flat check; limits answer most of it with 429.
    const pick = __ITER % 4;
    const r =
      pick === 0 ? http.get(`${BASE}/`)
      : pick === 1 ? http.get(`${BASE}/api/v1/analyses/${'0'.repeat(32)}`)
      : pick === 2 ? post('not a repo')
      : http.get(`${BASE}/healthz`);
    tag(r);
    check(r, { 'soak: never a 5xx': (x) => x.status < 500 });
  }
}
