import * as assert from 'assert';
import { formatGrimInfo, type GrimInfo } from '../views/grimInfo';
import { MINIMUM_GRIM_VERSION } from '../installer';

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
  });

  test('a missing global config is marked rather than silently shown as present', () => {
    const { detail } = formatGrimInfo(info({ globalConfigExists: false }));
    assert.ok(detail.includes('(does not exist)'), detail);
  });
});
