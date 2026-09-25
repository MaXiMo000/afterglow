import type { Page } from '@playwright/test';

/** A small, fully valid analysis result shared by the e2e specs (3 districts, 18 files, one quiet district). */
export function result(): unknown {
  const dirs = [
    { name: 'core', files: 6, loc: 300, last: 1_700_000_000, bus_factor: 1, quiet: false },
    { name: 'tests', files: 6, loc: 200, last: 1_699_000_000, bus_factor: 2, quiet: false },
    { name: 'legacy', files: 6, loc: 90, last: 1_500_000_000, bus_factor: 1, quiet: true },
  ];
  const files = Array.from({ length: 18 }, (_, i) => ({
    path: `${dirs[i % 3]!.name}/f${i}.py`, dir: i % 3, loc: 20 + i * 9, birth: 1_450_000_000 + i * 86_400 * 200,
    last: i % 3 === 2 ? 1_500_000_000 : 1_700_000_000 - i * 1000, changes: 40 - i, changes_12m: i % 3 === 2 ? 0 : 12 - (i % 6),
    authors: 1 + (i % 3), hot: i < 2, dead: i % 3 === 2,
  })); // prettier-ignore
  return {
    meta: {
      repo: 'acme/orbit', sha: 'f'.repeat(40), analyser: 2, generated_at: 1_700_000_100, commits: 400, files: 18,
      people: 5, span: [1_450_000_000, 1_700_000_000], truncated: { files: false, commits: false, sizes: false },
    },
    dirs, files, coupling: [{ a: 0, b: 3, count: 6, strength: 0.7 }],
    people: [{ handle: 'Contributor 1', commits: 300, areas: [0, 1] }],
    insights: { hotspots: [0, 1], bus_factor: [0, 2, 1], quiet: [2], coupling: [0] },
    timeline: Array.from({ length: 12 }, (_, i) => ({ t: 1_450_000_000 + i * 20_000_000, commits: 10 + i, added: 1 + (i % 3) })),
  }; // prettier-ignore
}

/** Serve `result()` for any analysis request. */
export async function mock(page: Page, id: string): Promise<void> {
  await page.route('**/api/v1/analyses', (r) => r.fulfill({ status: 200, json: { id, status: 'done' } }));
  await page.route(`**/api/v1/analyses/${id}`, (r) => r.fulfill({ status: 200, json: result() }));
}
