import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pngPath = path.resolve(__dirname, '../build/icon.png');
const icoPath = path.resolve(__dirname, '../build/icon.ico');

if (!fs.existsSync(pngPath)) {
  console.error(`Missing ${pngPath}`);
  process.exit(1);
}

try {
  const pyCode = `
from PIL import Image, ImageDraw

png_img = Image.open(r'${pngPath}').convert('RGBA')

mask = Image.new('L', png_img.size, 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle([0, 0, png_img.size[0], png_img.size[1]], radius=220, fill=255)

ico_base = png_img.copy()
ico_base.putalpha(mask)

ico_base.save(r'${icoPath}', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Successfully generated build/icon.ico with all 7 sizes and squircle transparency')
`;

  execFileSync('python', ['-c', pyCode], { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to generate icon.ico:', err);
  process.exit(1);
}
