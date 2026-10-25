import { chromium } from 'playwright';

async function capture() {
  const browser = await chromium.launch({ headless: true });

  // 1. Overview 1440px
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'docs/screenshots/before/overview-1440.png' });
    await page.close();
  }

  // 2. Overview 390px (mobile)
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'docs/screenshots/before/overview-390.png' });
    await page.close();
  }

  // 3. Incidents with sheet/drawer open 1440px
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    // Click incidents tab
    const incidentsTab = page.locator('button:has-text("Incidents")').first();
    if (await incidentsTab.count() > 0) {
      await incidentsTab.click();
      await page.waitForTimeout(1000);
      // Click first incident row if exists
      const firstRow = page.locator('tbody tr').first();
      if (await firstRow.count() > 0) {
        await firstRow.click();
        await page.waitForTimeout(1000);
      }
    }
    await page.screenshot({ path: 'docs/screenshots/before/incidents-sheet-1440.png' });
    await page.close();
  }

  // 4. Offline state 1440px
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    // Simulate offline
    await page.context().setOffline(true);
    // Wait for offline banner or trigger it
    await page.waitForTimeout(4000);
    await page.screenshot({ path: 'docs/screenshots/before/offline-1440.png' });
    await page.close();
  }

  await browser.close();
  console.log('Before screenshots captured successfully');
}

capture().catch(err => {
  console.error('Error capturing before screenshots:', err);
  process.exit(1);
});
