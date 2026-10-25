import { chromium } from 'playwright';

async function capture() {
  const browser = await chromium.launch({ headless: true });

  // 1. Overview 1440px (Light Theme)
  {
    console.log('Capturing overview-1440.png...');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'docs/screenshots/after/overview-1440.png' });
    await page.close();
  }

  // 2. Overview 390px (Mobile Light Theme)
  {
    console.log('Capturing overview-390.png...');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'docs/screenshots/after/overview-390.png' });
    await page.close();
  }

  // 3. Incidents with slide-over drawer / sheet open (1440px)
  {
    console.log('Capturing incidents-sheet-1440.png...');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Switch to incidents tab
    const incBtn = page.locator('button:visible:has-text("Incidents")').first();
    if (await incBtn.count() > 0) {
      await incBtn.click();
      await page.waitForTimeout(1000);
    }
    // Click an incident item in the table
    const incidentRow = page.locator('tbody tr:visible').first();
    if (await incidentRow.count() > 0) {
      await incidentRow.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: 'docs/screenshots/after/incidents-sheet-1440.png' });
    await page.close();
  }

  // 4. Incidents with slide-over drawer / sheet open (390px mobile)
  {
    console.log('Capturing incidents-sheet-390.png...');
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const incBtn = page.locator('button:visible:has-text("Incidents")').first();
    if (await incBtn.count() > 0) {
      await incBtn.click();
      await page.waitForTimeout(1000);
    }
    const incidentRow = page.locator('tbody tr:visible').first();
    if (await incidentRow.count() > 0) {
      await incidentRow.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: 'docs/screenshots/after/incidents-sheet-390.png' });
    await page.close();
  }

  // 5. Devices 1440px
  {
    console.log('Capturing devices-1440.png...');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const devBtn = page.locator('button:visible:has-text("Devices")').first();
    if (await devBtn.count() > 0) {
      await devBtn.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: 'docs/screenshots/after/devices-1440.png' });
    await page.close();
  }

  // 6. Live Events 1440px
  {
    console.log('Capturing events-1440.png...');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const eventsBtn = page.locator('button:visible:has-text("Live Events")').first();
    if (await eventsBtn.count() > 0) {
      await eventsBtn.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: 'docs/screenshots/after/events-1440.png' });
    await page.close();
  }

  // 7. Offline state 1440px
  {
    console.log('Capturing offline-1440.png...');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    // Disconnect network context
    await page.context().setOffline(true);
    // Wait for onerror and 8s offline timeout
    await page.waitForTimeout(9500);
    await page.screenshot({ path: 'docs/screenshots/after/offline-1440.png' });
    await page.close();
  }

  // 8. Dark Theme Overview 1440px
  {
    console.log('Capturing overview-dark-1440.png...');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const themeBtn = page.locator('button:visible[aria-label="Toggle theme"]').first();
    if (await themeBtn.count() > 0) {
      await themeBtn.click();
      await page.waitForTimeout(800);
    }
    await page.screenshot({ path: 'docs/screenshots/after/overview-dark-1440.png' });
    await page.close();
  }

  await browser.close();
  console.log('All after screenshots captured successfully!');
}

capture().catch((err) => {
  console.error('Error capturing after screenshots:', err);
  process.exit(1);
});
