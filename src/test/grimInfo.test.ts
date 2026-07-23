import * as assert from 'assert';
import { collectGrimInfo, formatGrimInfo, type GrimInfo } from '../views/grimInfo';
import type { ContextInfo, GrimResult } from '../grim';
import { MINIMUM_GRIM_VERSION } from '../installer';
import type { ScopeService } from '../scopes';

function info(overrides: Partial<GrimInfo> = {}): GrimInfo {
  return {
    path: '/home/u/.cargo/bin/grim',
    origin: 'PATH',
    version: MINIMUM_GRIM_VERSION,
    grimHome: '/home/u/.grim',
    globalConfigPath: '/home/u/.grim/grimoire.toml',
    globalConfigExists: true,
    offline: false,
    defaultRegistry: 'https://index.grimoire.rs',
    ...overrides,
  };
}

suite('grim info dialog', () => {
  test('a current grim reports the floor as met', () => {
    const { summary, detail } = formatGrimInfo(info());
    assert.ok(summary.includes(`✓ meets floor ${MINIMUM_GRIM_VERSION}`), summary);
    assert.ok(detail.includes('/home/u/.cargo/bin/grim'));
    assert.ok(detail.includes('PATH'));
    assert.ok(detail.includes('/home/u/.grim/grimoire.toml'));
    assert.ok(detail.includes('https://index.grimoire.rs'));
  });

  test('a too-old grim is called out against the floor', () => {
    const { summary } = formatGrimInfo(info({ version: '0.0.1' }));
    assert.ok(summary.includes('✗'), summary);
    assert.ok(summary.includes(MINIMUM_GRIM_VERSION), summary);
  });

  test('each resolution branch names how the binary was chosen', () => {
    assert.ok(formatGrimInfo(info({ origin: 'setting' })).detail.includes('path.executable'));
    assert.ok(formatGrimInfo(info({ origin: 'bundled' })).detail.includes('extension-managed'));
  });

  test('a failed probe still names the binary and shows the error', () => {
    const { summary, detail } = formatGrimInfo(
      info({
        version: null,
        grimHome: null,
        globalConfigPath: null,
        globalConfigExists: false,
        offline: null,
        defaultRegistry: null,
        error: 'grim executable not found',
      }),
    );
    assert.strictEqual(summary, 'grim did not report a version');
    assert.ok(detail.includes('/home/u/.cargo/bin/grim'));
    assert.ok(detail.includes('grim executable not found'));
    // Nothing the failed probe could not know is invented.
    assert.ok(!detail.includes('Home'));
    assert.ok(!detail.includes('Offline'));
    // Including the registry: "none configured" is a claim about a grim that
    // never answered, and it printed directly above "grim executable not found".
    assert.ok(!detail.includes('Registry'), detail);
  });

  test('a missing global config is marked rather than silently shown as present', () => {
    const { detail } = formatGrimInfo(info({ globalConfigExists: false }));
    assert.ok(detail.includes('(does not exist)'), detail);
  });
});

type Resolved = ReturnType<ScopeService['resolvedExecutable']>;

/** A ScopeService stand-in offering exactly what collectGrimInfo is allowed to
 *  read: the one resolution seam plus the one global `grim context` probe.
 *  Anything else it reaches for (its own setting→bundled→PATH branch, a second
 *  PATH scan) is the duplication that made the dialog disagree with the spawn. */
function fakeScopes(resolved: Resolved, probe: GrimResult<ContextInfo>): ScopeService {
  return {
    resolvedExecutable: () => resolved,
    run: async () => probe,
  } as unknown as ScopeService;
}

function contextProbe(): GrimResult<ContextInfo> {
  return {
    ok: true,
    value: {
      version: MINIMUM_GRIM_VERSION,
      scope: 'global',
      workspace: null,
      config_path: '/home/u/.grim/grimoire.toml',
      config_exists: true,
      lock_path: '/home/u/.grim/grimoire.lock',
      lock_exists: true,
      grim_home: '/home/u/.grim',
      offline: false,
      clients: [],
      registries: [],
      default_registry: 'https://index.grimoire.rs',
    },
  };
}

// The dialog exists to answer "which grim would actually be spawned". It may
// only report what ScopeService resolved — re-deriving the branch is how it
// came to claim `Resolved: PATH` for a binary that is nowhere.
suite('grim info: the binary is reported from the one resolution', () => {
  test('the configured setting is reported as the source, with its path', async () => {
    const info = await collectGrimInfo(
      fakeScopes({ path: '/opt/tools/grim', origin: 'setting' }, contextProbe()),
    );
    assert.strictEqual(info.path, '/opt/tools/grim');
    assert.strictEqual(info.origin, 'setting');
    const { detail } = formatGrimInfo(info);
    assert.ok(detail.includes('/opt/tools/grim'), detail);
    assert.ok(detail.includes('path.executable'), detail);
  });

  test('a PATH grim is named by the absolute file the scan found, not the bare `grim`', async () => {
    const info = await collectGrimInfo(
      fakeScopes({ path: '/usr/local/bin/grim', origin: 'PATH' }, contextProbe()),
    );
    assert.strictEqual(info.path, '/usr/local/bin/grim');
    assert.strictEqual(info.origin, 'PATH');
    assert.ok(formatGrimInfo(info).detail.includes('/usr/local/bin/grim'));
  });

  test('the extension-managed copy is named as extension-managed', async () => {
    const info = await collectGrimInfo(
      fakeScopes({ path: '/storage/bin/grim', origin: 'bundled' }, contextProbe()),
    );
    assert.strictEqual(info.path, '/storage/bin/grim');
    assert.strictEqual(info.origin, 'bundled');
    assert.ok(formatGrimInfo(info).detail.includes('extension-managed'));
  });

  test('no setting, no PATH grim and no bundled copy reports missing — never PATH', async () => {
    // The reported bug: this state paid a full PATH scan only to label a
    // binary that is nowhere as coming from PATH.
    const info = await collectGrimInfo(
      fakeScopes({ path: 'grim', origin: 'missing' }, { ok: false, kind: 'not-found' }),
    );
    assert.strictEqual(info.origin, 'missing');
    const { detail } = formatGrimInfo(info);
    assert.ok(
      !/^Resolved\W+PATH$/m.test(detail),
      `a grim that is nowhere must not be reported as resolved from PATH:\n${detail}`,
    );
    assert.ok(detail.includes('grim executable not found'), detail);
  });
});
