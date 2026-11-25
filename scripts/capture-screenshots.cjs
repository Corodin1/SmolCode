const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

async function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1440,
      height: 920,
      show: false,
      frame: false,
      backgroundColor: '#0F0F14',
      webPreferences: {
        preload: path.resolve(__dirname, 'mock-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
      },
    });

    win.webContents.on('console-message', (event, level, message) => {
      if (level >= 3) console.error(`[Renderer Error]`, message);
    });

    win.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.error('[did-fail-load]', code, desc, url);
    });

    const rendererHtml = path.resolve(__dirname, '../out/renderer/index.html');
    await win.loadFile(rendererHtml);
    await delay(1200);

    const outDir = path.resolve(__dirname, '../docs/screenshots');
    fs.mkdirSync(outDir, { recursive: true });

    // 1. Capture Main Thread view (with cat emblem, plan card, composer)
    console.log('Capturing 01-main-thread.png...');
    const img1 = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 920 });
    fs.writeFileSync(path.join(outDir, '01-main-thread.png'), img1.toPNG());
    console.log('Saved 01-main-thread.png');

    // 2. Switch to Settings view (Appearance / Themes)
    console.log('Switching to Settings View...');
    await win.webContents.executeJavaScript(`
      (() => {
        // Find Settings button in titlebar/sidebar or simulate shortcut
        const btns = Array.from(document.querySelectorAll('button'));
        const settingsBtn = btns.find(b => b.getAttribute('aria-label') === 'Settings' || b.textContent.includes('Settings'));
        if (settingsBtn) {
          settingsBtn.click();
        } else {
          // Trigger shortcut or click
          window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }));
        }
      })()
    `);
    await delay(800);
    const img2 = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 920 });
    fs.writeFileSync(path.join(outDir, '02-settings-themes.png'), img2.toPNG());
    console.log('Saved 02-settings-themes.png');

    // 3. Switch to Skills & MCP view
    console.log('Switching to Skills & MCP View...');
    await win.webContents.executeJavaScript(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const skillsBtn = btns.find(b => b.textContent.includes('Skills') || b.getAttribute('aria-label') === 'Skills');
        if (skillsBtn) skillsBtn.click();
      })()
    `);
    await delay(800);
    const img3 = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 920 });
    fs.writeFileSync(path.join(outDir, '03-skills-mcp.png'), img3.toPNG());
    console.log('Saved 03-skills-mcp.png');

    // 4. Switch back to Thread and open Terminal drawer
    console.log('Switching back to thread and opening terminal drawer...');
    await win.webContents.executeJavaScript(`
      (() => {
        const backBtn = document.querySelector('button[aria-label="Back"], button.codex-icon-btn, button');
        if (backBtn) backBtn.click();
        // Toggle terminal with Ctrl+\`
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', ctrlKey: true }));
      })()
    `);
    await delay(900);
    const img4 = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 920 });
    fs.writeFileSync(path.join(outDir, '04-terminal-diff.png'), img4.toPNG());
    console.log('Saved 04-terminal-diff.png');

    console.log('All 4 screenshots captured successfully!');
    app.quit();
  } catch (err) {
    console.error('Failed to capture screenshots:', err);
    process.exit(1);
  }
});
