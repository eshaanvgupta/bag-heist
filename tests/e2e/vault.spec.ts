import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('completes the playable commit, reveal, payout, and craft flow', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Plan quiet/ })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeDisabled();
  await page.getByRole('button', { name: /Evidence room/ }).click();
  await expect(page.getByRole('heading', { name: 'The rules are executable' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Deployment evidence slot' })).toBeVisible();
});

test('fits the product frame without horizontal overflow', async ({ page }) => {
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  await expect(page.getByRole('grid', { name: 'Six by six vault floor' })).toBeVisible();
});
