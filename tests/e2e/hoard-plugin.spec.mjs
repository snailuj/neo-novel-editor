import { test, expect } from '@playwright/test';
import { launchProfile } from '../support/electron-profile.mjs';

// hoard's two halves, as `npm run build` puts them in plugins/hoard. The window half pings
// the main half through neo.invoke when it activates, and only once the answer comes back
// does it offer window.hoard.ping, the same check for a test or the console. The main half
// answers ping once validateHoardPingV1 passes the payload.

const refusedByCsp = (lines) => lines.filter((line) => /Content Security Policy/i.test(line));

test('hoard pings its main half through neo.invoke, refuses a bad payload by its Ajv path, and breaks no CSP rule', async () => {
  const fixture = await launchProfile();
  try {
    const { app, page } = fixture;
    // The main process keeps every console line of the window, where Chromium reports a
    // script or style the CSP refused. The page is loaded again so the plugins' scripts
    // load while it listens.
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.hoardTestConsole = [];
      BrowserWindow.getAllWindows()[0].webContents.on('console-message', (event) => {
        globalThis.hoardTestConsole.push(String(event.message));
      });
    });
    const consoleLines = () => app.evaluate(() => globalThis.hoardTestConsole);
    await page.reload();
    await page.waitForFunction(() => typeof openBook === 'function' && !!window.hoard, null, { timeout: 15_000 });

    expect(await page.evaluate(() => window.hoard.ping({ n: 1 }))).toEqual({ n: 1 });
    const refusal = await page.evaluate(() => window.hoard.ping({ n: 'x' }).then(
      (answer) => ({ answer }),
      (error) => ({ message: String(error && error.message) }),
    ));
    expect(refusal.answer).toBeUndefined();
    expect(refusal.message).toMatch(/\/n must be number/);

    expect(refusedByCsp(await consoleLines())).toEqual([]);
    // the check can fail: an inline script is refused, and the console says so
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.hoardInline = true';
      document.body.appendChild(script);
    });
    await expect.poll(async () => refusedByCsp(await consoleLines()).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.hoardInline)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});
