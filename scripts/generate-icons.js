import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        offscreen: true,
      },
    });

    const svgPath = path.resolve(__dirname, '../build/icon.svg');
    const svgContent = fs.readFileSync(svgPath, 'utf8');
    const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;

    await win.loadURL(dataUri);
    await new Promise((r) => setTimeout(r, 600));

    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: 1024,
      height: 1024,
    });

    const pngBuffer = image.toPNG();
    const outPngPath = path.resolve(__dirname, '../build/icon.png');
    fs.writeFileSync(outPngPath, pngBuffer);
    console.log(`Rendered ${outPngPath} (${pngBuffer.length} bytes)`);

    const icoPath = path.resolve(__dirname, '../build/icon.ico');
    try {
      execFileSync('python', [
        '-c',
        `from PIL import Image; img = Image.open(r'${outPngPath}').convert('RGBA'); img.save(r'${icoPath}', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])`,
      ]);
      console.log(`Generated ${icoPath} with all 7 mipmaps`);
    } catch (e) {
      console.warn('Note: python Pillow step skipped:', e.message);
    }

    app.quit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
});
