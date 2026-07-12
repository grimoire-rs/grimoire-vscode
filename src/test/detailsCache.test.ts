import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CACHE_VERSION, DetailsCache, type DetailsCacheEntry } from '../detailsCache';

function entry(repo: string, overrides: Partial<DetailsCacheEntry> = {}): DetailsCacheEntry {
  return {
    version: CACHE_VERSION,
    repo,
    artifactDigest: 'sha256:a',
    companionDigest: null,
    savedAt: new Date().toISOString(),
    describe: null,
    fetch: null,
    readme: `readme for ${repo}`,
    logoUri: null,
    changelog: null,
    ...overrides,
  };
}

/** Mirrors DetailsCache's private filename scheme so tests can address files. */
function fileFor(dir: string, repo: string): string {
  return path.join(dir, `${createHash('sha1').update(repo).digest('hex')}.json`);
}

suite('DetailsCache', () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-details-cache-'));
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('save then load round-trips the entry', async () => {
    const cache = new DetailsCache(dir);
    const e = entry('ghcr.io/o/skills/x', { companionDigest: 'sha256:c', readme: '# Hi' });
    await cache.save(e.repo, e);
    assert.deepStrictEqual(await cache.load(e.repo), e);
  });

  test('load returns null for an unknown repo', async () => {
    const cache = new DetailsCache(dir);
    assert.strictEqual(await cache.load('ghcr.io/o/skills/missing'), null);
  });

  test('save stamps the current cache version', async () => {
    const cache = new DetailsCache(dir);
    const repo = 'ghcr.io/o/skills/x';
    await cache.save(repo, entry(repo));
    const written = JSON.parse(fs.readFileSync(fileFor(dir, repo), 'utf8'));
    assert.strictEqual(written.version, CACHE_VERSION);
  });

  test('a version-mismatch entry (e.g. pre-cleanup) loads as null and is deleted', async () => {
    const cache = new DetailsCache(dir);
    const repo = 'ghcr.io/o/skills/stale';
    const file = fileFor(dir, repo);
    fs.mkdirSync(dir, { recursive: true });
    // An entry written by an older schema — no/old version field.
    fs.writeFileSync(file, JSON.stringify({ ...entry(repo), version: CACHE_VERSION - 1 }));
    assert.strictEqual(await cache.load(repo), null);
    assert.ok(!fs.existsSync(file), 'stale-version file removed');
  });

  test('save overwrites in place (latest-only, no history)', async () => {
    const cache = new DetailsCache(dir);
    const repo = 'ghcr.io/o/skills/x';
    await cache.save(repo, entry(repo, { readme: 'v1' }));
    await cache.save(repo, entry(repo, { readme: 'v2' }));
    assert.strictEqual((await cache.load(repo))?.readme, 'v2');
    // One file per repo — not a version stack.
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1);
  });

  test('prune keeps only the newest maxEntries', async () => {
    const cache = new DetailsCache(dir, 4); // injected small ceiling
    for (let i = 0; i < 10; i++) {
      await cache.save(`ghcr.io/o/skills/x${i}`, entry(`ghcr.io/o/skills/x${i}`));
    }
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 4);
  });

  test('prune drops the oldest by mtime, keeps the freshest', async () => {
    const cache = new DetailsCache(dir, 4);
    // Seed 4, aging each to a distinct increasing mtime (y0 oldest, y3 newest).
    for (let i = 0; i < 4; i++) {
      const repo = `ghcr.io/o/skills/y${i}`;
      await cache.save(repo, entry(repo));
      const t = new Date(2000 + i, 0, 1);
      fs.utimesSync(fileFor(dir, repo), t, t);
    }
    // A 5th save triggers prune → the single oldest (y0) is evicted.
    await cache.save('ghcr.io/o/skills/fresh', entry('ghcr.io/o/skills/fresh'));
    assert.strictEqual(await cache.load('ghcr.io/o/skills/y0'), null, 'oldest evicted');
    assert.ok(await cache.load('ghcr.io/o/skills/y3'), 'freshest kept');
    assert.ok(await cache.load('ghcr.io/o/skills/fresh'), 'new entry kept');
  });

  test('presentLogos returns logos for cached repos only (readdir once)', async () => {
    const cache = new DetailsCache(dir);
    await cache.save('ghcr.io/o/skills/withlogo', entry('ghcr.io/o/skills/withlogo', { logoUri: 'data:image/png;base64,AAA' }));
    await cache.save('ghcr.io/o/skills/nologo', entry('ghcr.io/o/skills/nologo', { logoUri: null }));
    const logos = await cache.presentLogos([
      'ghcr.io/o/skills/withlogo',
      'ghcr.io/o/skills/nologo',
      'ghcr.io/o/skills/uncached',
    ]);
    assert.strictEqual(logos.get('ghcr.io/o/skills/withlogo'), 'data:image/png;base64,AAA');
    assert.ok(!logos.has('ghcr.io/o/skills/nologo'), 'cached but no logo → omitted');
    assert.ok(!logos.has('ghcr.io/o/skills/uncached'), 'uncached → omitted');
  });

  test('presentLogos on a missing dir is an empty map', async () => {
    const cache = new DetailsCache(path.join(dir, 'does-not-exist'));
    assert.strictEqual((await cache.presentLogos(['a/b/c'])).size, 0);
  });

  test('a corrupt file loads as null and is deleted', async () => {
    const cache = new DetailsCache(dir);
    const repo = 'ghcr.io/o/skills/x';
    const file = fileFor(dir, repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{ not valid json');
    assert.strictEqual(await cache.load(repo), null);
    assert.ok(!fs.existsSync(file), 'corrupt file removed');
  });

  test('an entry whose stored repo differs (hash collision guard) loads as null', async () => {
    const cache = new DetailsCache(dir);
    const file = fileFor(dir, 'ghcr.io/o/skills/asked');
    fs.writeFileSync(file, JSON.stringify(entry('ghcr.io/o/skills/other')));
    assert.strictEqual(await cache.load('ghcr.io/o/skills/asked'), null);
  });
});
