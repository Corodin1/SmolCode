import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RELEASE_TAG = 'v0.2.7';
const ASSET_BY_TARGET = {
  'win32-x64': `https://github.com/h4ckf0r0day/obscura/releases/download/${RELEASE_TAG}/obscura-x86_64-windows-stealth.zip`,
  'linux-x64': `https://github.com/h4ckf0r0day/obscura/releases/download/${RELEASE_TAG}/obscura-x86_64-linux-stealth.tar.gz`,
  'linux-arm64': `https://github.com/h4ckf0r0day/obscura/releases/download/${RELEASE_TAG}/obscura-aarch64-linux-stealth.tar.gz`,
  'darwin-arm64': `https://github.com/h4ckf0r0day/obscura/releases/download/${RELEASE_TAG}/obscura-aarch64-macos-stealth.tar.gz`,
  'darwin-x64': `https://github.com/h4ckf0r0day/obscura/releases/download/${RELEASE_TAG}/obscura-x86_64-macos-stealth.tar.gz`,
};

const targetKey = `${process.platform}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';
const destDir = resolve(process.cwd(), 'resources', 'bin', targetKey);
const destExe = join(destDir, exeName);

if (existsSync(destExe)) {
  console.log(`Obscura browser already bundled at ${destExe}`);
  process.exit(0);
}

const url = ASSET_BY_TARGET[targetKey];
if (!url) {
  console.warn(`No prebuilt Obscura release configured for ${targetKey}; skipping.`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
const ext = url.endsWith('.zip') ? '.zip' : '.tar.gz';
const archivePath = join(tmpdir(), `smolcode-obscura-${RELEASE_TAG}${ext}`);

console.log(`Fetching bundled Obscura browser (${targetKey})...`);
execFileSync('curl', ['-L', '-f', url, '-o', archivePath], { stdio: 'inherit' });

try {
  if (ext === '.zip') {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { stdio: 'inherit' },
      );
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    }
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
  }
  console.log(`Bundled Obscura browser installed at ${destDir}`);
} finally {
  if (existsSync(archivePath)) {
    rmSync(archivePath, { force: true });
  }
}
