// Auto-installer for the grim binary. Reads cargo-dist's dist-manifest.json
// from the latest GitHub release (survives the planned tar.xz -> tar.gz
// switch), downloads the platform archive, verifies its sha256 against the
// sibling `.sha256` asset, and extracts with the system `tar` — bsdtar on
// Windows 10+/macOS handles zip and xz alike; Linux GNU tar + xz-utils
// handles tar.xz/tar.gz.
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const RELEASE_BASE = 'https://github.com/grimoire-rs/grimoire/releases/latest/download';

// cargo-dist manifest subset we rely on.
export interface DistManifest {
  artifacts: Record<
    string,
    {
      kind: string;
      target_triples?: string[];
    }
  >;
}

/** platform/arch -> rust target triple. */
export function targetTriple(platform: string, arch: string): string | undefined {
  const triples: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  return triples[`${platform}-${arch}`];
}

export interface SelectedAsset {
  name: string;
  checksumName: string;
}

/**
 * Picks the executable archive for this platform out of a dist-manifest.
 * Format-agnostic: matches on artifact kind + target triple, not on the file
 * extension (tar.xz today, tar.gz planned).
 */
export function selectAsset(
  manifest: DistManifest,
  platform: string,
  arch: string,
): SelectedAsset | undefined {
  const triple = targetTriple(platform, arch);
  if (!triple) {
    return undefined;
  }
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    if (artifact.kind === 'executable-zip' && artifact.target_triples?.includes(triple)) {
      return { name, checksumName: `${name}.sha256` };
    }
  }
  return undefined;
}

/** Parses a `.sha256` asset ("<hex>" or "<hex>  <file>"). */
export function parseSha256(text: string): string | undefined {
  const token = text.trim().split(/\s+/)[0];
  return token && /^[0-9a-fA-F]{64}$/.test(token) ? token.toLowerCase() : undefined;
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed: ${url} -> HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Extracts any tar/zip archive with the system tar (bsdtar handles both). Exported for tests. */
export function extract(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', destDir], { shell: false }, (error, _out, stderr) => {
      if (error) {
        reject(new Error(`tar extraction failed: ${stderr || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

/** Recursively locates the extracted binary. Exported for tests. */
export function findBinary(dir: string, binary: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === binary) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findBinary(full, binary);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export interface InstallProgress {
  report(message: string): void;
}

/**
 * Downloads and installs the latest grim release into `storageDir/bin`.
 * Returns the absolute path of the installed binary.
 */
export async function installGrim(storageDir: string, progress: InstallProgress): Promise<string> {
  progress.report('Fetching release manifest…');
  const manifestRaw = await download(`${RELEASE_BASE}/dist-manifest.json`);
  const manifest = JSON.parse(manifestRaw.toString('utf8')) as DistManifest;
  const asset = selectAsset(manifest, process.platform, process.arch);
  if (!asset) {
    throw new Error(`no grim release asset for ${process.platform}/${process.arch}`);
  }

  progress.report(`Downloading ${asset.name}…`);
  const [archive, checksumRaw] = await Promise.all([
    download(`${RELEASE_BASE}/${asset.name}`),
    download(`${RELEASE_BASE}/${asset.checksumName}`),
  ]);
  const expected = parseSha256(checksumRaw.toString('utf8'));
  if (!expected) {
    throw new Error(`unparseable checksum asset ${asset.checksumName}`);
  }
  const actual = sha256Hex(archive);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
  }

  progress.report('Extracting…');
  const binDir = path.join(storageDir, 'bin');
  const stageDir = path.join(storageDir, 'stage');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const archivePath = path.join(stageDir, asset.name);
  fs.writeFileSync(archivePath, archive);
  await extract(archivePath, stageDir);

  const binaryName = process.platform === 'win32' ? 'grim.exe' : 'grim';
  const found = findBinary(stageDir, binaryName);
  if (!found) {
    throw new Error(`archive ${asset.name} did not contain ${binaryName}`);
  }
  const target = path.join(binDir, binaryName);
  fs.copyFileSync(found, target);
  if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o755);
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
  return target;
}
