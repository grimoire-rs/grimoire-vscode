import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SKIP_VERSION,
  UPDATE_GRIM,
  VIEW_RELEASE,
  extract,
  findBinary,
  isNewerVersion,
  latestVersion,
  parseSha256,
  selectAsset,
  sha256Hex,
  targetTriple,
  updateDecision,
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

suite('installer update check', () => {
  test('latestVersion prefers releases[].app_version', () => {
    const doc: DistManifest = {
      announcement_tag: 'v9.9.9',
      releases: [{ app_name: 'grimoire', app_version: '0.9.1' }],
      artifacts: {},
    };
    assert.strictEqual(latestVersion(doc), '0.9.1');
  });

  test('latestVersion falls back to the announcement tag (both cargo-dist styles)', () => {
    assert.strictEqual(latestVersion({ announcement_tag: 'v0.9.1', artifacts: {} }), '0.9.1');
    assert.strictEqual(latestVersion({ announcement_tag: 'grim-v0.9.1', artifacts: {} }), '0.9.1');
  });

  test('latestVersion picks the grim entry in a multi-app manifest', () => {
    const doc: DistManifest = {
      releases: [
        { app_name: 'other-tool', app_version: '9.9.9' },
        { app_name: 'grimoire', app_version: '0.9.1' },
      ],
      artifacts: {},
    };
    assert.strictEqual(latestVersion(doc), '0.9.1');
  });

  test('latestVersion bounds a pathological announcement tag (no ReDoS hang)', () => {
    // A long digits-only tag would backtrack O(n²) against the unanchored
    // regex; the slice bound keeps it linear. Assert it returns fast + safe.
    const doc: DistManifest = { announcement_tag: '9'.repeat(100000), artifacts: {} };
    const started = Date.now();
    assert.strictEqual(latestVersion(doc), undefined);
    assert.ok(Date.now() - started < 100, 'latestVersion must not hang on a long tag');
  });

  test('latestVersion is undefined without version fields (today’s selection manifest)', () => {
    assert.strictEqual(latestVersion(manifest('tar.gz')), undefined);
    assert.strictEqual(latestVersion({ announcement_tag: 'nightly', artifacts: {} }), undefined);
  });

  test('isNewerVersion compares three numeric components', () => {
    assert.strictEqual(isNewerVersion('0.10.0', '0.9.0'), true);
    assert.strictEqual(isNewerVersion('1.0.0', '0.9.9'), true);
    assert.strictEqual(isNewerVersion('0.9.1', '0.9.0'), true);
    assert.strictEqual(isNewerVersion('0.9.0', '0.9.0'), false);
    assert.strictEqual(isNewerVersion('0.9.0', '0.10.0'), false);
  });

  test('isNewerVersion tolerates garbage and pre-release suffixes', () => {
    assert.strictEqual(isNewerVersion('garbage', 'also-garbage'), false);
    assert.strictEqual(isNewerVersion('', '0.9.0'), false);
    // Suffixes don't crash; the numeric core decides.
    assert.strictEqual(isNewerVersion('0.10.0-rc.1', '0.9.0'), true);
    assert.strictEqual(isNewerVersion('0.9.0-rc.1', '0.9.0'), false);
  });

  test('updateDecision offers an in-place update for a managed binary', () => {
    const p = updateDecision({ latest: '0.10.0', current: '0.9.0', skipped: undefined, managed: true });
    assert.ok(p);
    assert.deepStrictEqual(p.buttons, [UPDATE_GRIM, SKIP_VERSION]);
    assert.ok(p.message.includes('0.10.0') && p.message.includes('0.9.0'));
  });

  test('updateDecision links the release page for a user-managed binary', () => {
    const p = updateDecision({ latest: '0.10.0', current: '0.9.0', skipped: undefined, managed: false });
    assert.ok(p);
    // Never "Update grim" — the extension must not overwrite a binary it doesn't own.
    assert.deepStrictEqual(p.buttons, [VIEW_RELEASE, SKIP_VERSION]);
  });

  test('updateDecision returns null when not newer, skipped, or missing', () => {
    assert.strictEqual(
      updateDecision({ latest: '0.9.0', current: '0.9.0', skipped: undefined, managed: true }),
      null,
    );
    assert.strictEqual(
      updateDecision({ latest: '0.9.0', current: '0.10.0', skipped: undefined, managed: true }),
      null,
    );
    assert.strictEqual(
      updateDecision({ latest: '0.10.0', current: '0.9.0', skipped: '0.10.0', managed: true }),
      null,
    );
    assert.strictEqual(
      updateDecision({ latest: undefined, current: '0.9.0', skipped: undefined, managed: true }),
      null,
    );
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
