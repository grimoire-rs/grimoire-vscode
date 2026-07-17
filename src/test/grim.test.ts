import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addArgs,
  configListArgs,
  configSetArgs,
  configUnsetArgs,
  contextArgs,
  describeArgs,
  fetchArgs,
  initArgs,
  installArgs,
  parseReport,
  registryAddArgs,
  registryListArgs,
  registryRmArgs,
  registryUseArgs,
  removeArgs,
  runJson,
  searchArgs,
  statusArgs,
  uninstallArgs,
  updateArgs,
  type ConfigEntry,
  type ConfigWriteResult,
  type ItemsEnvelope,
  type RegistryEntry,
  type SearchItem,
} from '../grim';

suite('grim arg builders', () => {
  test('searchArgs passes a multi-word query as ONE positional behind --', () => {
    // grim's [QUERY] is a single value it whitespace-splits itself; pre-split
    // argv words make clap error ("unexpected argument 'usage'").
    assert.deepStrictEqual(searchArgs('grim usage'), ['search', '--', 'grim usage']);
  });

  test('searchArgs trims but keeps interior whitespace verbatim', () => {
    assert.deepStrictEqual(searchArgs('  grim   usage '), ['search', '--', 'grim   usage']);
  });

  test('searchArgs empty query is whole catalog (no -- needed)', () => {
    assert.deepStrictEqual(searchArgs(''), ['search']);
    assert.deepStrictEqual(searchArgs('   '), ['search']);
  });

  test('searchArgs flags all precede the -- separator', () => {
    assert.deepStrictEqual(searchArgs('x', { refresh: true, showDeprecated: true }), [
      'search',
      '--refresh',
      '--show-deprecated',
      '--',
      'x',
    ]);
  });

  test('searchArgs query that looks like a flag is forced positional', () => {
    assert.deepStrictEqual(searchArgs('--foo'), ['search', '--', '--foo']);
  });

  test('fetchArgs with path and vendor', () => {
    assert.deepStrictEqual(fetchArgs('a/b/c'), ['fetch', 'a/b/c']);
    assert.deepStrictEqual(fetchArgs('a/b/c', { path: 'c/logo.png', vendor: 'claude' }), [
      'fetch',
      'a/b/c',
      '--path',
      'c/logo.png',
      '--vendor',
      'claude',
    ]);
  });

  test('fetchArgs description/digestOnly flags', () => {
    assert.deepStrictEqual(fetchArgs('a/b/c', { description: true }), [
      'fetch',
      'a/b/c',
      '--description',
    ]);
    assert.deepStrictEqual(fetchArgs('a/b/c', { digestOnly: true }), [
      'fetch',
      'a/b/c',
      '--digest-only',
    ]);
    // --description before --digest-only.
    assert.deepStrictEqual(fetchArgs('a/b/c', { description: true, digestOnly: true }), [
      'fetch',
      'a/b/c',
      '--description',
      '--digest-only',
    ]);
  });

  test('describe/status/context args', () => {
    assert.deepStrictEqual(describeArgs('a/b'), ['describe', 'a/b']);
    assert.deepStrictEqual(statusArgs(), ['status']);
    assert.deepStrictEqual(contextArgs(), ['context']);
  });

  test('add/remove/uninstall/update/install/init args', () => {
    assert.deepStrictEqual(addArgs('a/b:1', { kind: 'skill', name: 'b', noInstall: true }), [
      'add',
      'a/b:1',
      '--kind',
      'skill',
      '--name',
      'b',
      '--no-install',
    ]);
    assert.deepStrictEqual(removeArgs('skill', 'b'), ['remove', 'skill', 'b']);
    assert.deepStrictEqual(uninstallArgs('rule', 'r'), ['uninstall', 'rule', 'r']);
    assert.deepStrictEqual(updateArgs(), ['update']);
    assert.deepStrictEqual(updateArgs(['a', 'b']), ['update', 'a', 'b']);
    assert.deepStrictEqual(installArgs({ client: 'claude' }), ['install', '--client', 'claude']);
    assert.deepStrictEqual(initArgs({ registry: 'ghcr.io/x' }), [
      'init',
      '--registry',
      'ghcr.io/x',
    ]);
  });

  test('configListArgs plain vs --all', () => {
    assert.deepStrictEqual(configListArgs(), ['config', 'list']);
    assert.deepStrictEqual(configListArgs({ all: true }), ['config', 'list', '--all']);
  });

  test('configSetArgs/configUnsetArgs', () => {
    assert.deepStrictEqual(configSetArgs('options.tui.default_view', 'tree'), [
      'config',
      'set',
      'options.tui.default_view',
      'tree',
    ]);
    assert.deepStrictEqual(configUnsetArgs('options.tui.default_view'), [
      'config',
      'unset',
      'options.tui.default_view',
    ]);
  });

  test('registryListArgs/registryRmArgs/registryUseArgs', () => {
    assert.deepStrictEqual(registryListArgs(), ['config', 'registry', 'list']);
    assert.deepStrictEqual(registryRmArgs('acme'), ['config', 'registry', 'rm', 'acme']);
    assert.deepStrictEqual(registryUseArgs('acme'), ['config', 'registry', 'use', 'acme']);
  });

  test('registryAddArgs with --oci', () => {
    assert.deepStrictEqual(registryAddArgs('acme', { oci: 'ghcr.io/acme' }), [
      'config',
      'registry',
      'add',
      'acme',
      '--oci',
      'ghcr.io/acme',
    ]);
  });

  test('registryAddArgs with --index and --default', () => {
    assert.deepStrictEqual(
      registryAddArgs('pub', { index: 'https://index.example/index.json' }, { default: true }),
      [
        'config',
        'registry',
        'add',
        'pub',
        '--index',
        'https://index.example/index.json',
        '--default',
      ],
    );
  });
});

suite('grim report parsing', () => {
  test('plain single-object report', () => {
    const result = parseReport<{ path: string }>('{"path":"/x"}', 0, '');
    assert.ok(result.ok);
    assert.strictEqual(result.value.path, '/x');
  });

  test('items envelope', () => {
    const result = parseReport<ItemsEnvelope<SearchItem>>('{"items":[]}', 0, '');
    assert.ok(result.ok);
    assert.deepStrictEqual(result.value.items, []);
  });

  test('error document wins over exit code', () => {
    const doc = '{"error":{"code":"auth","exit":80,"message":"401 from registry"}}';
    const result = parseReport(doc, 80, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.code, 'auth');
    assert.strictEqual(result.exitCode, 80);
    assert.strictEqual(result.message, '401 from registry');
  });

  test('error reason is surfaced when present', () => {
    const doc = '{"error":{"code":"data","exit":65,"message":"partial-resolve refused","reason":"stale-lock"}}';
    const result = parseReport(doc, 65, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.reason, 'stale-lock');
  });

  test('absent reason stays undefined', () => {
    const doc = '{"error":{"code":"auth","exit":80,"message":"401 from registry"}}';
    const result = parseReport(doc, 80, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.reason, undefined);
  });

  test('unknown reason values pass through untouched', () => {
    const doc = '{"error":{"code":"data","exit":65,"message":"x","reason":"some-future-reason"}}';
    const result = parseReport(doc, 65, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.reason, 'some-future-reason');
  });

  test('clap usage error (exit 64, no JSON) maps to usage', () => {
    const result = parseReport('', 64, "error: unrecognized subcommand 'describe'");
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.code, 'usage');
    assert.match(result.message, /unrecognized subcommand/);
  });

  test('malformed JSON with zero exit maps to failure', () => {
    const result = parseReport('not json', 0, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.code, 'failure');
  });

  test('nullable search fields survive parsing', () => {
    const doc = JSON.stringify({
      items: [
        {
          kind: null,
          repo: 'ghcr.io/x/skills/y',
          summary: null,
          description: 'd',
          version: null,
          latest_tag: null,
          repository: null,
          revision: null,
          created: null,
          deprecated: null,
          status: 'not-installed',
        },
      ],
    });
    const result = parseReport<ItemsEnvelope<SearchItem>>(doc, 0, '');
    assert.ok(result.ok);
    const item = result.value.items[0];
    assert.ok(item);
    assert.strictEqual(item.kind, null);
    assert.strictEqual(item.version, null);
    assert.strictEqual(item.status, 'not-installed');
  });

  test('ConfigEntry: unset key parses with the full always-present-null shape', () => {
    const doc = JSON.stringify({
      items: [
        {
          key: 'options.default_registry',
          value: null,
          set: false,
          type: 'string',
          title: 'Default registry',
          description: 'Default registry for short identifiers.',
          default: null,
          values: null,
        },
      ],
    });
    const result = parseReport<ItemsEnvelope<ConfigEntry>>(doc, 0, '');
    assert.ok(result.ok);
    const entry = result.value.items[0];
    assert.ok(entry);
    assert.strictEqual(entry.value, null);
    assert.strictEqual(entry.set, false);
    assert.strictEqual(entry.default, null);
    assert.strictEqual(entry.values, null);
  });

  test('ConfigEntry: enum type carries its values list and a non-null default', () => {
    const doc = JSON.stringify({
      key: 'options.tui.default_view',
      value: 'tree',
      set: true,
      type: 'enum',
      title: 'Default view',
      description: 'The view mode to open with.',
      default: 'tree',
      values: ['flat', 'tree'],
    });
    const result = parseReport<ConfigEntry>(doc, 0, '');
    assert.ok(result.ok);
    assert.strictEqual(result.value.type, 'enum');
    assert.deepStrictEqual(result.value.values, ['flat', 'tree']);
  });

  test('ConfigEntry: an unrecognized future type string still parses (frozen/additive)', () => {
    // grim's contract is additive — a newer grim may ship a `type` this
    // extension doesn't know about yet; parsing must not throw. Degrading it
    // to a read-only row is buildSettingsVM's job (webview/settings), not
    // this layer's.
    const doc = JSON.stringify({
      key: 'options.some_future_key',
      value: 'x',
      set: true,
      type: 'duration',
      title: 'Some future key',
      description: 'd',
      default: null,
      values: null,
    });
    const result = parseReport<ConfigEntry>(doc, 0, '');
    assert.ok(result.ok);
    assert.strictEqual(result.value.type, 'duration');
  });

  test('RegistryEntry: legacy (alias-less) row survives parsing', () => {
    const doc = JSON.stringify({
      items: [
        { alias: null, oci: 'ghcr.io/legacy', index: null, default: false },
        { alias: 'acme', oci: null, index: 'https://index.example/index.json', default: true },
      ],
    });
    const result = parseReport<ItemsEnvelope<RegistryEntry>>(doc, 0, '');
    assert.ok(result.ok);
    const [legacy, acme] = result.value.items;
    assert.ok(legacy && acme);
    assert.strictEqual(legacy.alias, null);
    assert.strictEqual(legacy.oci, 'ghcr.io/legacy');
    assert.strictEqual(acme.index, 'https://index.example/index.json');
    assert.strictEqual(acme.default, true);
  });

  test('ConfigWriteResult: set/unset/registry actions all parse through the one write shape', () => {
    const set = parseReport<ConfigWriteResult>(
      '{"action":"set","key":"options.clients","value":"claude","scope":"project"}',
      0,
      '',
    );
    assert.ok(set.ok);
    assert.strictEqual(set.value.action, 'set');
    assert.strictEqual(set.value.scope, 'project');

    const registryAdded = parseReport<ConfigWriteResult>(
      '{"action":"registry-added","key":"registry.acme","value":"ghcr.io/acme","scope":"global"}',
      0,
      '',
    );
    assert.ok(registryAdded.ok);
    assert.strictEqual(registryAdded.value.action, 'registry-added');
    assert.strictEqual(registryAdded.value.scope, 'global');
  });

  test('config set with an invalid value is an exit-65 error envelope', () => {
    const doc =
      '{"error":{"code":"data","exit":65,"message":"invalid value \'nope\' for options.tui.expand_levels"}}';
    const result = parseReport<ConfigWriteResult>(doc, 65, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.exitCode, 65);
    assert.strictEqual(result.code, 'data');
  });

  test('runJson reports missing executable as not-found', async () => {
    const result = await runJson('/nonexistent/grim-binary-for-test', ['context']);
    assert.ok(!result.ok);
    assert.strictEqual(result.kind, 'not-found');
  });

  test('runJson inserts --format json before a trailing -- separator (skipped on Windows: POSIX stub)', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    // A stub that echoes argv back on stdout — parseReport can't parse that as
    // JSON, so it falls back to treating the echoed text as the error
    // message, which is enough to assert the exact argv order.
    const scriptPath = path.join(os.tmpdir(), `grim-argv-echo-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    try {
      const result = await runJson(scriptPath, ['search', '--global', '--', '--foo']);
      assert.ok(!result.ok && result.kind === 'error');
      assert.strictEqual(result.message, 'search --global --format json -- --foo');
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  });
});
