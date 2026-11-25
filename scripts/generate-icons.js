import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logoPng = path.resolve(__dirname, '../docs/assets/logo.png');
const outPngPath = path.resolve(__dirname, '../build/icon.png');
const icoPath = path.resolve(__dirname, '../build/icon.ico');

execFileSync('python', [
  '-c',
  `
from PIL import Image, ImageDraw
orig = Image.open(r'${logoPng}').convert('RGB')
size = 1024
radius = 224

mask = Image.new('L', (size * 4, size * 4), 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle([0, 0, size * 4, size * 4], radius=radius * 4, fill=255)
mask = mask.resize((size, size), Image.Resampling.LANCZOS)

rgba = orig.convert('RGBA')
rgba.putalpha(mask)

rgba.save(r'${outPngPath}', format='PNG')
rgba.save(r'${icoPath}', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Successfully generated build/icon.png and build/icon.ico from logo.png')
`,
]);
console.log('Icon generation completed successfully.');
