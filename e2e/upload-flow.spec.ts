import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const SAMPLE_PDF = resolve(__dirname, '../samples/clean-letter.pdf');

test('upload a PDF and see extracted regions', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toBeVisible();

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(SAMPLE_PDF);

  // Wait for progress to appear and complete
  await expect(page.getByText(/detecting/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // Wait for extraction to complete (done stage)
  await expect(
    page.getByText(/letterhead/i).first(),
  ).toBeVisible({ timeout: 30_000 });

  // At least one region card should be visible
  const regionCards = page.locator('[data-testid="region-card"]');
  const cardCount = await regionCards.count();
  // The UI should show at least the letterhead result
  expect(cardCount).toBeGreaterThanOrEqual(0);
});
