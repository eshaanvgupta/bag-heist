import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

test('completes the playable commit, reveal, payout, and craft flow', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Plan quiet/ })).toBeVisible();
  await page.getByRole('button', { name: /Practice floor/ }).click();
  await expect(page.getByRole('grid')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start heist', exact: true }).click();
  await expect(page.getByText('hash matched')).toBeVisible();
  await page.getByRole('button', { name: 'Register heist profile' }).click();
  await page.getByRole('button', { name: 'Register BAG storage' }).click();
  await page.getByRole('button', { name: 'Scout route' }).click();
  await expect(page.getByRole('heading', { name: 'Exit secured' })).toBeVisible();
  await page.getByRole('button', { name: 'Seal this route' }).click();
  await expect(page.getByText('Commitment sealed. Your reveal backup was saved first.')).toBeVisible();
  await page.getByRole('button', { name: 'Close commitment window' }).click();
  await page.getByRole('button', { name: 'Reveal matching route' }).click();
  await page.getByRole('button', { name: 'Close reveal window' }).click();
  await page.getByRole('button', { name: 'Finalize round' }).click();
  await page.getByRole('button', { name: 'Claim 100 BAG' }).click();
  await expect(page.getByText('100 BAG moved from treasury to winner.')).toBeVisible();
  await page.getByRole('button', { name: 'Craft for 5 BAG' }).click();
  await expect(page.getByText('5 BAG burned; crowbar added to inventory.')).toBeVisible();
  await expect(page.getByText('Supply audit')).toBeVisible();
});

test('keeps live and evidence modes visibly separated from practice', async ({ page }) => {
  await page.getByRole('button', { name: /Testnet vault/ }).click();
  await expect(page.getByText('Wallet signed').first()).toBeVisible();
  await expect(page.getByPlaceholder('your-contract.testnet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /Evidence room/ }).click();
  await expect(page.getByRole('heading', { name: 'The rules are executable' })).toBeVisible();
  await expect(page.getByText('Recorded NEAR receipts')).toBeVisible();
});

test('fits the product frame without horizontal overflow', async ({ page }) => {
  await page.getByRole('button', { name: /Practice floor/ }).click();
  await page.getByRole('button', { name: 'Start heist', exact: true }).click();
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  await expect(page.getByRole('grid', { name: 'Six by six vault floor' })).toBeVisible();
});

test('waits for Start before opening a practice round and preserves a sealed reveal on reload', async ({ page }) => {
  await page.getByRole('button', { name: /Practice floor/ }).click();
  await expect(page.getByRole('grid')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('bag-heist:practice:v1'))).toBeNull();
  await page.getByRole('button', { name: 'Start heist', exact: true }).click();
  await page.getByRole('button', { name: 'Register heist profile' }).click();
  await page.getByRole('button', { name: 'Register BAG storage' }).click();
  await page.getByRole('button', { name: 'Scout route' }).click();
  await page.getByRole('button', { name: 'Seal this route' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Export reveal' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close commitment window' }).click();
  await page.getByRole('button', { name: 'Reveal matching route' }).click();
  await expect(page.getByText('Matching route revealed and scored.')).toBeVisible();
});

test('opens the real NEAR testnet wallet with the published contract and return URL', async ({ page, context }) => {
  await context.route('https://testnet.mynearwallet.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Wallet handoff</h1>' }));
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL('https://testnet.mynearwallet.com/**');
  const walletUrl = new URL(popup.url());
  expect(walletUrl.searchParams.get('contract_id')).toBe('bag-heist-mw7swkjh.testnet');
  expect(walletUrl.searchParams.get('success_url')).toContain('127.0.0.1:4173');
  await popup.close();
});
