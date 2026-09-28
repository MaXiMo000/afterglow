import { expect, test, type Page } from '@playwright/test';
import { mock, result } from './fixture';

// A5 gate: "keyboard-only walkthrough of every feature". After the repo is submitted with Enter, nothing here uses
// the mouse. Also: share links restore a view; hostile share links are ignored (SECURITY T15).
const ID = 'e'.repeat(32);

async function openCity(page: Page): Promise<void> {
  await mock(page, ID);
  await page.goto('/?quality=simple#explore');
  await page.locator('#repoInput').focus();
  await page.keyboard.type('acme/orbit');
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const key = (page: Page, k: string) => page.keyboard.press(k);

test('every explore feature is reachable by keyboard alone', async ({ page }) => {
  test.slow(); // walks through every feature in one test
  await openCity(page);

  // Help overlay lists the keys; Esc closes it.
  await key(page, '?');
  await expect(page.locator('#help')).toBeVisible();
  await expect(page.locator('#help')).toContainText('Compare two dates');
  await key(page, 'Escape');
  await expect(page.locator('#help')).toBeHidden();

  // Palette: fuzzy search a file, Enter selects it and opens the inspector.
  await key(page, '/');
  await expect(page.locator('#palette')).toBeVisible();
  await page.keyboard.type('tests/f4');
  await expect(page.locator('#palList [role="option"]').first()).toContainText('tests/f4.py');
  await key(page, 'Enter');
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#inspector .path')).toHaveText('tests/f4.py');
  await expect(page.locator('#inspector a')).toHaveAttribute('href', `https://github.com/acme/orbit/blob/${'f'.repeat(40)}/tests/f4.py`);
  await key(page, 'f'); // frame the selection
  await key(page, 'Escape');
  await expect(page.locator('#inspector')).toBeHidden();

  // Palette also runs actions and finds districts and people.
  await key(page, 'Control+k');
  await page.keyboard.type('legacy/');
  await key(page, 'Enter');
  await expect(page.locator('#placeName')).toHaveText('legacy');

  // Insights, mini-map, compare, time.
  await key(page, 'i');
  await expect(page.locator('#insights')).toBeVisible();
  await expect(page.locator('#insights .rows')).toContainText('core/f0.py');
  await key(page, 'i');
  await expect(page.locator('#insights')).toBeHidden();
  await key(page, 'm');
  await expect(page.locator('#minimap')).toBeVisible();
  await key(page, 'c');
  await expect(page.locator('#compareLegend')).toBeVisible();
  await expect(page.locator('#compareLegend')).toContainText('Added in this window');
  await expect(page.locator('#compareLegend')).toContainText('removals are not shown');
  await key(page, 'Escape');
  await expect(page.locator('#compareLegend')).toBeHidden();
  await key(page, 'Space');
  await expect(page.locator('#timeline .play')).toHaveAttribute('aria-label', 'Pause history');
  await key(page, 'Space');
  await expect(page.locator('#timeline .play')).toHaveAttribute('aria-label', 'Play history');
  await key(page, ']');
  await expect(page.locator('#timeline .speed')).toHaveText('4\u00d7');
  await key(page, '[');
  await key(page, ',');
  await key(page, ',');
  await expect(page.locator('#timeline .track')).not.toHaveAttribute('aria-valuenow', '100');
  await key(page, '.');
  await key(page, 't');
  await expect(page.locator('#timeline')).toBeHidden();
  await key(page, 't');

  // Camera presets and view toggles announce themselves.
  for (const [k, label] of [['2', 'Street level'], ['3', 'Top-down'], ['4', 'Skyline'], ['5', 'Cinematic auto-orbit'], ['1', 'Overview']]) {
    await key(page, k!);
    await expect(page.locator('#announce')).toHaveText(`View: ${label}`);
  }
  await key(page, 'h');
  await key(page, 'r');
  await key(page, 'g');
  await expect(page.locator('#toast')).toHaveText('Coupling arcs off');
  await key(page, 'l');
  await expect(page.locator('#toast')).toHaveText('Lanterns off');
  for (const k of ['w', 'a', 's', 'd', 'q', 'e', 'ArrowLeft', 'ArrowUp', '+', '-']) await key(page, k);

  // Share link goes in the URL (and the clipboard when allowed).
  await key(page, 's');
  await expect(page).toHaveURL(/#v=1&r=acme\/orbit&c=[\d.,-]+&t=[\d.]+$/);

  // Photo mode hides the UI; Esc leaves it.
  await key(page, 'p');
  await expect(page.locator('body')).toHaveClass(/photo/);
  await expect(page.locator('#photoBar')).toBeVisible();
  await expect(page.locator('#hud')).toBeHidden();
  await key(page, 'Escape');
  await expect(page.locator('body')).not.toHaveClass(/photo/);

  // Table view and back to the story.
  await key(page, 'v');
  await expect(page.locator('#tableView')).toBeVisible();
  await key(page, 'Escape');
  await expect(page.locator('#tableView')).toBeHidden();
  await key(page, 'b');
  await expect(page.locator('body')).toHaveClass(/mode-story/);
});

test('weather on the Fast tier explains it needs Balanced or Cinematic', async ({ page }) => {
  await openCity(page); // ?quality=simple: weather needs Balanced or Cinematic, and says so
  await key(page, 'z');
  await expect(page.locator('#toast')).toContainText('Weather needs the Balanced or Cinematic graphics setting');
  await expect(page.locator('#weatherLegend')).toBeHidden();
});

test('walk mode: X enters, keys move, Esc leaves; camera flights take over', async ({ page }) => {
  await openCity(page);
  await key(page, 'x');
  await expect(page.locator('body')).toHaveClass(/walking/);
  await expect(page.locator('#reticle')).toBeVisible();
  await expect(page.locator('#announce')).toContainText('Walk mode.');
  await page.keyboard.down('w');
  await page.waitForTimeout(400);
  await page.keyboard.up('w');
  await key(page, 'Escape');
  await expect(page.locator('body')).not.toHaveClass(/walking/);
  await expect(page.locator('#announce')).toHaveText('Left walk mode');
  await key(page, 'x');
  await key(page, 'j'); // the hotspot tour flies the orbit camera: walking ends
  await expect(page.locator('body')).not.toHaveClass(/walking/);
  await expect(page.locator('#placeEy')).toHaveText('Hotspot 1 of 2');
});

test('drill-down: Enter opens the selected district as a city, Backspace climbs out; picking in the palette does not drill', async ({ page }) => {
  await openCity(page);
  await key(page, '/');
  await page.keyboard.type('core/f0');
  await key(page, 'Enter'); // picks the file; must not also drill in
  await expect(page.locator('#inspector .path')).toHaveText(/core\/f0\.py$/);
  await expect(page.locator('#placeEy')).toHaveText('District');
  await page.locator('#gl').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await key(page, 'Enter');
  await expect(page.locator('#placeEy')).toHaveText('Inside');
  await expect(page.locator('#placeName')).toHaveText('core');
  await expect(page.locator('#announce')).toContainText('Inside core:');
  await key(page, 'Backspace');
  await expect(page.locator('#announce')).toHaveText('Back in the whole city.');
  await expect(page.locator('#placeName')).toHaveText('core'); // flies back to the district it came from
});

test('hotspot tour: J and K step through the hotspots and wrap around', async ({ page }) => {
  await openCity(page);
  await key(page, 'j');
  await expect(page.locator('#placeEy')).toHaveText('Hotspot 1 of 2');
  await expect(page.locator('#inspector .path')).toHaveText(/f0\.py$/);
  await key(page, 'j');
  await expect(page.locator('#placeEy')).toHaveText('Hotspot 2 of 2');
  await key(page, 'j');
  await expect(page.locator('#placeEy')).toHaveText('Hotspot 1 of 2'); // wraps
  await key(page, 'k');
  await expect(page.locator('#announce')).toContainText('Hotspot 2 of 2:');
});

test('colour by file type: legend, inspector row, and never together with compare', async ({ page }) => {
  await openCity(page);
  await key(page, 'y');
  const legend = page.locator('#typeLegend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('.py');
  await expect(legend).toContainText('By file extension, not language detection');
  await expect(page.locator('#announce')).toContainText('Colour by file type on');
  await key(page, 'c'); // compare recolours buildings too: it takes over
  await expect(page.locator('#compareLegend')).toBeVisible();
  await expect(legend).toBeHidden();
  await key(page, 'y');
  await expect(legend).toBeVisible();
  await expect(page.locator('#compareLegend')).toBeHidden();
  await key(page, 'Escape'); // Esc backs out of the mode
  await expect(legend).toBeHidden();
  await key(page, '/');
  await page.keyboard.type('tests/f4');
  await key(page, 'Enter');
  await expect(page.locator('#inspector')).toContainText('.py');
});

test('photo mode saves a PNG poster', async ({ page }) => {
  await openCity(page);
  await key(page, 'p');
  const download = page.waitForEvent('download');
  await key(page, 'Enter'); // Save PNG is focused on entering photo mode
  const d = await download;
  expect(d.suggestedFilename()).toBe('afterglow-acme-orbit.png');
});

test('N overlays a pull request: dialog, request, legend, Esc; a missing PR explains itself', async ({ page }) => {
  await openCity(page);
  const PR = 'f'.repeat(32);
  let body = '';
  await page.route('**/api/v1/prs', (r) => ((body = r.request().postData() ?? ''), r.fulfill({ status: 200, json: { id: PR, status: 'done' } })));
  await page.route(`**/api/v1/prs/${PR}`, (r) =>
    r.fulfill({ status: 200, json: { repo: 'acme/orbit', pr: 42, merge: 'c'.repeat(40), base: 'd'.repeat(40), truncated: false,
      changes: [{ path: 'core/f0.py', status: 'modified' }, { path: 'tests/f1.py', status: 'deleted' }, { path: 'new.py', status: 'added' }] } }),
  ); // prettier-ignore
  await key(page, 'n');
  await expect(page.locator('#prDialog')).toBeVisible();
  await page.fill('#prInput', '42');
  await page.keyboard.press('Enter');
  const legend = page.locator('#prLegend');
  await expect(legend).toContainText('PR #42');
  await expect(legend).toContainText('Changed: 1 building');
  await expect(legend).toContainText('Deleted or moved away: 1');
  await expect(legend).toContainText('1 new file');
  expect(JSON.parse(body)).toEqual({ repo: 'acme/orbit', pr: 42 });
  await key(page, 'Escape');
  await expect(legend).toBeHidden();
  await expect(page.locator('#announce')).toHaveText('Overlay cleared.');
  await page.unroute('**/api/v1/prs');
  await page.route('**/api/v1/prs', (r) => r.fulfill({ status: 200, json: { id: PR, status: 'done' } }));
  await page.unroute(`**/api/v1/prs/${PR}`);
  await page.route(`**/api/v1/prs/${PR}`, (r) => r.fulfill({ status: 422, json: { error: 'pr_not_found' } }));
  await key(page, 'n');
  await page.fill('#prInput', '7');
  await page.keyboard.press('Enter');
  await expect(page.locator('#announce')).toContainText('GitHub has no test merge for PR #7');
});

test('6 shows what changed since the previous analysis, or says there is none', async ({ page }) => {
  await page.route(`**/api/v1/analyses/${ID}/previous`, (r) => r.fulfill({ status: 404, json: { error: 'not_found' } }));
  await openCity(page);
  await key(page, '6');
  await expect(page.locator('#toast')).toContainText('No earlier analysis of this repository is stored here yet');
  await page.unroute(`**/api/v1/analyses/${ID}/previous`);
  const prev = result() as { meta: { sha: string; generated_at: number }; files: { path: string; changes: number }[] };
  prev.meta.sha = 'e'.repeat(40);
  prev.meta.generated_at = 1_690_000_000;
  prev.files = prev.files.slice(1).map((f) => ({ ...f, changes: Math.max(0, f.changes - 1) }));
  await page.route(`**/api/v1/analyses/${ID}/previous`, (r) => r.fulfill({ status: 200, json: prev }));
  await key(page, '6');
  const legend = page.locator('#prLegend');
  await expect(legend).toContainText('Since');
  await expect(legend).toContainText('Changed again:');
  await key(page, '6');
  await expect(legend).toBeHidden();
});

test('O records an orbit video (WebM download); Esc cancels a recording', async ({ page }) => {
  test.slow(); // the orbit clip is 12 s of real time
  await openCity(page);
  await key(page, 'o');
  await expect(page.locator('body')).toHaveClass(/recording/);
  await key(page, 'Escape');
  await expect(page.locator('body')).not.toHaveClass(/recording/);
  await expect(page.locator('#announce')).toHaveText('Recording cancelled.');
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await key(page, 'o');
  const d = await download;
  expect(d.suggestedFilename()).toBe('afterglow-acme-orbit.webm');
  await expect(page.locator('#announce')).toHaveText('Video saved.');
});

test('a share link restores repo, camera and time', async ({ page }) => {
  await mock(page, ID);
  await page.goto('/?quality=simple#v=1&r=acme/orbit&c=1.000,0.500,80.000,0.000,0.000&t=0.5000');
  await expect(page.locator('body')).toHaveClass(/mode-city/);
  await expect(page.locator('#timeline .track')).toHaveAttribute('aria-valuenow', '50');
});

for (const hash of ['#v=1&r=acme/orbit&t=<img src=x onerror=alert(1)>', '#v=1&r=https://evil.example/x', '#v=1&r=acme/orbit&c=1e9,0,0,0,0']) {
  test(`a hostile share link is ignored: ${hash.slice(0, 40)}`, async ({ page }) => {
    let posted = false;
    await page.route('**/api/v1/analyses', (r) => ((posted = true), r.fulfill({ status: 500, body: '' })));
    await page.goto(`/?quality=simple${hash}`);
    await page.waitForTimeout(800);
    await expect(page.locator('body')).toHaveClass(/mode-hero/);
    expect(posted).toBe(false);
  });
}
