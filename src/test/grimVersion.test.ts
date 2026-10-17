// ScopeService.grimVersion decides, per search, whether paging flags may be
// sent. Its cached answer belongs to the binary that produced it: a stale one
// sends paged flags to an older grim (clap exit 64) or an unpaged request to a
// newer one.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GrimResult } from '../grim';
import { ScopeService } from '../scopes';

function harness(): {
  scopes: ScopeService;
  probes: () => number;
  setVersion: (v: string) => void;
  swapBinary: () => void;
  usePath: (p: string) => void;
  exe: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-version-'));
  const exe = path.join(dir, 'grim');
  fs.writeFileSync(exe, 'a');
  let current = exe;
  let version = '0.14.3';
  let probes = 0;
  const scopes = new ScopeService({ fsPath: dir } as never, { appendLine: () => {} } as never);
  scopes.projectFolder = () => undefined;
  scopes.resolvedExecutable = () => ({ path: current, origin: 'setting' });
  scopes.run = (async <T>(args: string[]): Promise<GrimResult<T>> => {
    if (args[0] === 'context') {
      probes += 1;
      return {
        ok: true,
        value: {
          version,
          config_exists: true,
          config_path: '/nonexistent/grimoire.toml',
          grim_home: '/tmp/grim-home',
          default_registry: null,
          registries: [],
        },
      } as GrimResult<T>;
    }
    return { ok: true, value: { items: [] } } as GrimResult<T>;
  }) as ScopeService['run'];
  return {
    scopes,
    exe,
    probes: () => probes,
    setVersion: (v) => {
      version = v;
    },
    swapBinary: () => {
      fs.writeFileSync(exe, 'bb');
      const later = new Date(Date.now() + 10_000);
      fs.utimesSync(exe, later, later);
    },
    usePath: (p) => {
      current = p;
    },
  };
}

suite('grim version follows the binary', () => {
  test('a snapshot answers for its own binary without a probe', async () => {
    const h = harness();
    await h.scopes.snapshot();
    const before = h.probes();
    assert.strictEqual(await h.scopes.grimVersion(), '0.14.3');
    assert.strictEqual(h.probes(), before, 'the cached snapshot version is trusted');
  });

  test('an in-place upgrade is noticed before the next snapshot', async () => {
    const h = harness();
    await h.scopes.snapshot();
    h.setVersion('0.15.0');
    h.swapBinary();
    assert.strictEqual(await h.scopes.grimVersion(), '0.15.0');
  });

  test('a different executable setting is noticed before the next snapshot', async () => {
    const h = harness();
    await h.scopes.snapshot();
    const other = path.join(path.dirname(h.exe), 'older-grim');
    fs.writeFileSync(other, 'x');
    h.setVersion('0.11.0');
    h.usePath(other);
    assert.strictEqual(await h.scopes.grimVersion(), '0.11.0');
  });

  test('one probe serves every caller until the binary changes again', async () => {
    const h = harness();
    await h.scopes.snapshot();
    h.setVersion('0.15.0');
    h.swapBinary();
    const before = h.probes();
    await Promise.all([h.scopes.grimVersion(), h.scopes.grimVersion()]);
    assert.strictEqual(h.probes(), before + 1);
  });
});
