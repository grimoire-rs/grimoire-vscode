import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extract,
  findBinary,
  parseSha256,
  selectAsset,
  sha256Hex,
  targetTriple,
  type DistManifest,
} from '../installer';

// Mirrors the real cargo-dist manifest layout (grimoire-<triple>.tar.xz today,
// tar.gz planned — selection must not depend on the extension).
function manifest(extension: string): DistManifest {
  const triples = [
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'aarch64-apple-darwin',
  ];
  const artifacts: DistManifest['artifacts'] = {};
  for (const triple of triples) {
    artifacts[`grimoire-${triple}.${extension}`] = {
      kind: 'executable-zip',
      target_triples: [triple],
    };
    artifacts[`grimoire-${triple}.${extension}.sha256`] = { kind: 'checksum' };
  }
  artifacts['grimoire-x86_64-pc-windows-msvc.zip'] = {
    kind: 'executable-zip',
    target_triples: ['x86_64-pc-windows-msvc'],
  };
  artifacts['grimoire-installer.sh'] = { kind: 'installer' };
  artifacts['dist-manifest.json'] = { kind: 'unknown' };
  return { artifacts };
}

suite('installer asset selection', () => {
  test('targetTriple map covers supported platforms', () => {
    assert.strictEqual(targetTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu');
    assert.strictEqual(targetTriple('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
    assert.strictEqual(targetTriple('darwin', 'x64'), 'x86_64-apple-darwin');
    assert.strictEqual(targetTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
    assert.strictEqual(targetTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
    assert.strictEqual(targetTriple('freebsd', 'x64'), undefined);
  });

  test('selects tar.xz assets (today)', () => {
    const asset = selectAsset(manifest('tar.xz'), 'linux', 'x64');
    assert.deepStrictEqual(asset, {
      name: 'grimoire-x86_64-unknown-linux-gnu.tar.xz',
      checksumName: 'grimoire-x86_64-unknown-linux-gnu.tar.xz.sha256',
    });
  });

  test('selects tar.gz assets (future switch)', () => {
    const asset = selectAsset(manifest('tar.gz'), 'darwin', 'arm64');
    assert.deepStrictEqual(asset, {
      name: 'grimoire-aarch64-apple-darwin.tar.gz',
      checksumName: 'grimoire-aarch64-apple-darwin.tar.gz.sha256',
    });
  });

  test('selects windows zip', () => {
    const asset = selectAsset(manifest('tar.xz'), 'win32', 'x64');
    assert.strictEqual(asset?.name, 'grimoire-x86_64-pc-windows-msvc.zip');
  });

  test('unknown platform yields undefined', () => {
    assert.strictEqual(selectAsset(manifest('tar.xz'), 'sunos', 'x64'), undefined);
  });

  test('installer scripts and checksums are never selected', () => {
    const asset = selectAsset(manifest('tar.xz'), 'linux', 'arm64');
    assert.ok(asset && !asset.name.endsWith('.sh') && !asset.name.endsWith('.sha256'));
  });
});

suite('installer checksums', () => {
  test('parses bare hex', () => {
    const hex = 'a'.repeat(64);
    assert.strictEqual(parseSha256(`${hex}\n`), hex);
  });

  test('parses "hex  filename" format', () => {
    const hex = 'AB'.repeat(32);
    assert.strictEqual(
      parseSha256(`${hex}  grimoire-x86_64-unknown-linux-gnu.tar.xz`),
      hex.toLowerCase(),
    );
  });

  test('rejects garbage', () => {
    assert.strictEqual(parseSha256('not-a-checksum'), undefined);
    assert.strictEqual(parseSha256(''), undefined);
  });

  test('sha256Hex matches known vector', () => {
    // sha256("abc")
    assert.strictEqual(
      sha256Hex(Buffer.from('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('mismatch detection', () => {
    const data = Buffer.from('payload');
    assert.notStrictEqual(sha256Hex(data), sha256Hex(Buffer.from('other')));
  });
});

suite('installer extraction', () => {
  test('extracts a tar.gz with the system tar and finds the nested binary', async function () {
    this.timeout(10000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-extract-'));
    try {
      // Build grimoire-x/grim inside an archive, like the release layout.
      const src = path.join(dir, 'src', 'grimoire-x86_64-unknown-linux-gnu');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'grim'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
      const archive = path.join(dir, 'grimoire.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), '.']);

      const dest = path.join(dir, 'out');
      fs.mkdirSync(dest);
      await extract(archive, dest);
      const found = findBinary(dest, 'grim');
      assert.ok(found, 'grim not found after extraction');
      assert.match(fs.readFileSync(found, 'utf8'), /echo stub/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extract rejects a missing archive', async () => {
    await assert.rejects(
      () => extract('/nonexistent/archive.tar.gz', os.tmpdir()),
      /tar extraction failed/,
    );
  });

  test('findBinary returns undefined when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-empty-'));
    try {
      assert.strictEqual(findBinary(dir, 'grim'), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
