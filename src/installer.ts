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

/** The releases page, offered to users with a non-managed (PATH / manually
 *  installed) grim so the "update available" toast still has an action. */
export const RELEASE_PAGE = 'https://github.com/grimoire-rs/grimoire/releases/latest';

/** Oldest grim whose CLI surface this extension is built against. The floor is
 *  hard, not a compat shim: older builds reject flags the extension always
 *  sends (`status --check`, `config set --dry-run`) with a clap usage error
 *  (exit 64), which surfaces as an opaque "unexpected argument" toast and — via
 *  the failed-status path — freezes the update badge. One constant, one check
 *  (`grimTooOld`), so "which grim version is acceptable" is decided in exactly
 *  one place. */
export const MINIMUM_GRIM_VERSION = '0.10.0';

/** True when a resolved grim is older than {@link MINIMUM_GRIM_VERSION}.
 *  Unparseable versions compare as 0.0.0 and therefore read as too old — a grim
 *  that can't state its version can't be trusted to speak the current contract.
 *  Pure; exported for tests. */
export function grimTooOld(version: string): boolean {
  return isNewerVersion(MINIMUM_GRIM_VERSION, version);
}

/** The one message shown when the resolved grim is too old. Names the binary
 *  that actually ran, because "which grim is this?" is the whole question a
 *  stale PATH copy raises (the extension-managed copy is only a fallback, so a
 *  stale user-managed grim on PATH is what usually trips this). */
export function tooOldMessage(executable: string, version: string): string {
  return (
    `grim ${version} at ${executable} is too old — Grimoire needs ${MINIMUM_GRIM_VERSION} ` +
    `or newer. Update grim (${RELEASE_PAGE}), or point grimoire.path.executable at a current build.`
  );
}

/** cargo-dist `releases[].app_name` for grim (the manifest ships the whole
 *  `grimoire` workspace under one app today). */
const GRIM_APP_NAME = 'grimoire';

/** Update-toast action labels — shared so the pure decision and the handler
 *  that acts on the choice can't drift. */
export const UPDATE_GRIM = 'Update grim';
export const VIEW_RELEASE = 'View Release';
export const SKIP_VERSION = 'Skip This Version';

export interface UpdatePrompt {
  message: string;
  /** Buttons for showInformationMessage, in order. */
  buttons: string[];
}

/** Pure update-check decision: whether to prompt and with which actions. Kept
 *  out of activate() so the managed-vs-user and skip/newer branches are unit-
 *  testable without stubbing vscode.window. Returns null → no toast. */
export function updateDecision(args: {
  latest: string | undefined;
  current: string;
  skipped: string | undefined;
  managed: boolean;
}): UpdatePrompt | null {
  const { latest, current, skipped, managed } = args;
  if (!latest || latest === skipped || !isNewerVersion(latest, current)) {
    return null;
  }
  return {
    message: `grim ${latest} is available (installed: ${current}).`,
    // Managed binary → we can replace it in place; otherwise link the release
    // page rather than dead-end on a skip-only toast.
    buttons: managed ? [UPDATE_GRIM, SKIP_VERSION] : [VIEW_RELEASE, SKIP_VERSION],
  };
}

// cargo-dist manifest subset we rely on. Version fields optional — external
// data, never assume they exist.
export interface DistManifest {
  announcement_tag?: string;
  releases?: { app_name?: string; app_version?: string }[];
  artifacts: Record<
    string,
    {
      kind: string;
      target_triples?: string[];
    }
  >;
}

/** Latest released version out of a dist-manifest. Prefers the grim
 *  `releases[].app_version` (matched by app name so a multi-package manifest
 *  can't hand back a sibling's version); falls back to any release entry, then
 *  to parsing the announcement tag (`v0.9.1` single-package or `grim-v0.9.1`
 *  workspace style). */
export function latestVersion(manifest: DistManifest): string | undefined {
  const fromRelease =
    manifest.releases?.find((r) => r.app_name === GRIM_APP_NAME && r.app_version)?.app_version ??
    manifest.releases?.find((r) => r.app_version)?.app_version;
  if (fromRelease) {
    return fromRelease;
  }
  // slice(-64) bounds the unanchored regex: announcement_tag is remote data,
  // and without the bound a pathological long digits-only string backtracks
  // O(n²). Real tags are a handful of chars and live at the end.
  const tag = (manifest.announcement_tag ?? '').slice(-64);
  return /(\d+\.\d+\.\d+\S*)$/.exec(tag)?.[1];
}

/** True when `latest` is a strictly newer x.y.z than `current`. Non-numeric
 *  parts compare as 0; equal or garbage input -> false.
 *  ponytail: 3-component numeric compare, not full semver — grim releases plain x.y.z. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [l, c] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) {
    const a = l[i] ?? 0;
    const b = c[i] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
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

/** Latest grim version from the same dist-manifest fetch installGrim uses. */
export async function fetchLatestVersion(): Promise<string | undefined> {
  const raw = await download(`${RELEASE_BASE}/dist-manifest.json`);
  return latestVersion(JSON.parse(raw.toString('utf8')) as DistManifest);
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
