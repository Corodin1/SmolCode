import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RELEASE_TAG = 'master-1133-52491bd';
const ASSET_BY_TARGET = {
  'win32-x64': `https://github.com/leejet/stable-diffusion.cpp/releases/download/${RELEASE_TAG}/sd-master-52491bd-bin-win-vulkan-x64.zip`,
  'linux-x64': `https://github.com/leejet/stable-diffusion.cpp/releases/download/${RELEASE_TAG}/sd-master-52491bd-bin-Linux-Ubuntu-26.04-x86_64-vulkan.zip`,
  'darwin-arm64': `https://github.com/leejet/stable-diffusion.cpp/releases/download/${RELEASE_TAG}/sd-master-52491bd-bin-Darwin-macOS-26.7.2-arm64.zip`,
};

const targetKey = `${process.platform}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
const destDir = resolve(process.cwd(), 'resources', 'bin', targetKey);
const destExe = join(destDir, exeName);

if (existsSync(destExe)) {
  console.log(`Image engine already bundled at ${destExe}`);
  process.exit(0);
}

const url = ASSET_BY_TARGET[targetKey];
if (!url) {
  console.warn(`No prebuilt sd-cli release configured for ${targetKey}; skipping.`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
const archivePath = join(tmpdir(), `smolcode-sd-${RELEASE_TAG}.zip`);

console.log(`Fetching bundled stable-diffusion.cpp engine (${targetKey})...`);
execFileSync('curl', ['-L', '-f', url, '-o', archivePath], { stdio: 'inherit' });

try {
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
  console.log(`Bundled image engine installed at ${destDir}`);
} finally {
  if (existsSync(archivePath)) {
    rmSync(archivePath, { force: true });
  }
}
