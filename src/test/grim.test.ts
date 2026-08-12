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
  isForceable,
  isRetryable,
  parseReport,
  positionalOf,
  editRegistrySteps,
  registryAddArgs,
  registrySetArgs,
  registryFieldsArgs,
  registryListArgs,
  registryRmArgs,
  registryUseArgs,
  removeArgs,
  runJson,
  searchArgs,
  statusArgs,
  uninstallArgs,
  updateArgs,
  withFlags,
  type ConfigEntry,
  type ConfigWriteResult,
  type ItemsEnvelope,
  type RegistryEntry,
  type SearchItem,
  type UpdateEntry,
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
    assert.deepStrictEqual(fetchArgs('a/b/c'), ['fetch', '--', 'a/b/c']);
    assert.deepStrictEqual(fetchArgs('a/b/c', { path: 'c/logo.png', vendor: 'claude' }), [
      'fetch',
      '--path',
      'c/logo.png',
      '--vendor',
      'claude',
      '--',
      'a/b/c',
    ]);
  });

  test('fetchArgs description/digestOnly flags', () => {
    assert.deepStrictEqual(fetchArgs('a/b/c', { description: true }), [
      'fetch',
      '--description',
      '--',
      'a/b/c',
    ]);
    assert.deepStrictEqual(fetchArgs('a/b/c', { digestOnly: true }), [
      'fetch',
      '--digest-only',
      '--',
      'a/b/c',
    ]);
    // --description before --digest-only.
    assert.deepStrictEqual(fetchArgs('a/b/c', { description: true, digestOnly: true }), [
      'fetch',
      '--description',
      '--digest-only',
      '--',
      'a/b/c',
    ]);
  });

  test('describe/status/context args', () => {
    assert.deepStrictEqual(describeArgs('a/b'), ['describe', '--', 'a/b']);
    assert.deepStrictEqual(statusArgs(), ['status']);
    // Plain status carries no --check; check:false stays offline too.
    assert.deepStrictEqual(statusArgs({}), ['status']);
    assert.deepStrictEqual(statusArgs({ check: false }), ['status']);
    // check:true opts into the network-verified re-check.
    assert.deepStrictEqual(statusArgs({ check: true }), ['status', '--check']);
    assert.deepStrictEqual(contextArgs(), ['context']);
  });

  test('add/remove/uninstall/update/init args', () => {
    assert.deepStrictEqual(addArgs('a/b:1', { kind: 'skill', name: 'b', noInstall: true }), [
      'add',
      '--kind',
      'skill',
      '--name',
      'b',
      '--no-install',
      '--',
      'a/b:1',
    ]);
    assert.deepStrictEqual(removeArgs('skill', 'b'), ['remove', '--', 'skill', 'b']);
    assert.deepStrictEqual(uninstallArgs('rule', 'r'), ['uninstall', '--', 'rule', 'r']);
    // A bare update protects nothing, so it carries no separator.
    assert.deepStrictEqual(updateArgs(), ['update']);
    assert.deepStrictEqual(updateArgs(['a', 'b']), ['update', '--', 'a', 'b']);
    assert.deepStrictEqual(initArgs({ registry: 'ghcr.io/x' }), [
      'init',
      '--registry',
      'ghcr.io/x',
    ]);
  });

  test('a hyphenated repo/name stays a positional, never a flag', () => {
    // Repos and artifact names come off the registry catalog and grim's status
    // rows — a repo spelled "--global" must reach clap as the reference.
    for (const args of [
      addArgs('--global'),
      fetchArgs('--global'),
      describeArgs('--global'),
      uninstallArgs('skill', '--force'),
      removeArgs('bundle', '--force'),
      updateArgs(['--force']),
    ]) {
      const sep = args.indexOf('--');
      assert.ok(sep !== -1, `${args[0]} emits a separator: ${args.join(' ')}`);
      assert.ok(
        args.slice(sep + 1).some((a) => a.startsWith('--')),
        `the hyphenated value sits behind it: ${args.join(' ')}`,
      );
    }
  });

  test('withFlags puts a flag in front of the separator, positionalOf reads behind it', () => {
    // The force retry's two needs: --force must stay a flag, and the dialog
    // names the artifact off the same argv.
    assert.deepStrictEqual(withFlags(addArgs('a/b'), ['--force']), [
      'add',
      '--force',
      '--',
      'a/b',
    ]);
    assert.deepStrictEqual(withFlags(updateArgs(), ['--force']), ['update', '--force']);
    assert.strictEqual(positionalOf(addArgs('a/b:1')), 'a/b:1');
    assert.strictEqual(positionalOf(updateArgs(['demo'])), 'demo');
    // A builder with no positional to name yields nothing, not its subcommand.
    assert.strictEqual(positionalOf(updateArgs()), '');
    // Nor a flag: the separator-less builders are the scope-wide ones, so
    // whatever sits at args[1] there is an option, never an artifact.
    assert.strictEqual(positionalOf(installArgs()), '');
    assert.strictEqual(positionalOf(initArgs()), '');
    assert.strictEqual(positionalOf(initArgs({ registry: 'https://example.test/r' })), '');
    // Behind a separator, a leading `--` IS the positional — that is what the
    // separator is for, and a ref shaped like a flag must survive verbatim.
    assert.strictEqual(positionalOf(addArgs('--registry/evil')), '--registry/evil');
  });

  test('configListArgs plain vs --all', () => {
    assert.deepStrictEqual(configListArgs(), ['config', 'list']);
    assert.deepStrictEqual(configListArgs({ all: true }), ['config', 'list', '--all']);
  });

  test('configSetArgs/configUnsetArgs', () => {
    assert.deepStrictEqual(configSetArgs('options.tui.default_view', 'tree'), [
      'config',
      'set',
      '--',
      'options.tui.default_view',
      'tree',
    ]);
    assert.deepStrictEqual(configUnsetArgs('options.tui.default_view'), [
      'config',
      'unset',
      '--',
      'options.tui.default_view',
    ]);
  });

  test("configSetArgs forces a leading-hyphen value positional (no allow_hyphen_values on grim's `set`)", () => {
    assert.deepStrictEqual(configSetArgs('options.tui.tree_separators', '--'), [
      'config',
      'set',
      '--',
      'options.tui.tree_separators',
      '--',
    ]);
  });

  test('configSetArgs({dryRun: true}) puts the flag before the -- separator', () => {
    // --dry-run is a flag, not a positional: it must land before the `--`
    // that forces key/value to parse positionally, or it would itself be
    // swallowed as a third positional.
    assert.deepStrictEqual(configSetArgs('options.tui.default_view', 'tree', { dryRun: true }), [
      'config',
      'set',
      '--dry-run',
      '--',
      'options.tui.default_view',
      'tree',
    ]);
  });

  test('configSetArgs({dryRun: false}) matches the no-options form', () => {
    assert.deepStrictEqual(
      configSetArgs('options.tui.default_view', 'tree', { dryRun: false }),
      configSetArgs('options.tui.default_view', 'tree'),
    );
  });

  test('registryListArgs/registryRmArgs/registryUseArgs', () => {
    assert.deepStrictEqual(registryListArgs(), ['config', 'registry', 'list']);
    assert.deepStrictEqual(registryRmArgs('acme'), ['config', 'registry', 'rm', '--', 'acme']);
    assert.deepStrictEqual(registryUseArgs('acme'), ['config', 'registry', 'use', '--', 'acme']);
  });

  test('registryFieldsArgs: context-free, no scope/flag arguments', () => {
    assert.deepStrictEqual(registryFieldsArgs(), ['config', 'registry', 'fields']);
  });

  test('registryRmArgs/registryUseArgs force a leading-hyphen alias positional', () => {
    assert.deepStrictEqual(registryRmArgs('-x'), ['config', 'registry', 'rm', '--', '-x']);
    assert.deepStrictEqual(registryUseArgs('-x'), ['config', 'registry', 'use', '--', '-x']);
  });

  test('registryAddArgs with --oci', () => {
    assert.deepStrictEqual(registryAddArgs('acme', { oci: 'ghcr.io/acme' }), [
      'config',
      'registry',
      'add',
      '--oci=ghcr.io/acme',
      '--',
      'acme',
    ]);
  });

  test('registryAddArgs with --index and --default', () => {
    assert.deepStrictEqual(
      registryAddArgs('pub', { index: 'https://index.example/index.json' }, { default: true }),
      [
        'config',
        'registry',
        'add',
        '--index=https://index.example/index.json',
        '--default',
        '--',
        'pub',
      ],
    );
  });

  test('registryAddArgs repeats a flag per browse-filter pattern, never comma-joining', () => {
    assert.deepStrictEqual(
      registryAddArgs(
        'acme',
        { index: 'https://index.acme.internal' },
        {
          // A brace-alternation pattern is exactly what comma-joining would
          // destroy: grim splits neither flag, so this must survive as ONE arg.
          include: ['acme/platform/**', 'acme/{tools,libs}/**'],
          exclude: ['acme/platform/legacy/**'],
          default: true,
        },
      ),
      [
        'config',
        'registry',
        'add',
        '--index=https://index.acme.internal',
        '--include=acme/platform/**',
        '--include=acme/{tools,libs}/**',
        '--exclude=acme/platform/legacy/**',
        '--default',
        '--',
        'acme',
      ],
    );
  });

  test('registryAddArgs adds --insecure only when the opt-in is on', () => {
    assert.deepStrictEqual(
      registryAddArgs('local', { oci: 'localhost:5050/grimoire' }, { insecure: true }),
      [
        'config',
        'registry',
        'add',
        '--oci=localhost:5050/grimoire',
        '--insecure',
        '--',
        'local',
      ],
    );
    assert.deepStrictEqual(
      registryAddArgs('local', { oci: 'localhost:5050/grimoire' }, { insecure: false }),
      registryAddArgs('local', { oci: 'localhost:5050/grimoire' }),
    );
  });

  test('registryAddArgs emits no filter flag for empty lists (argv unchanged from before the feature)', () => {
    assert.deepStrictEqual(
      registryAddArgs('acme', { oci: 'ghcr.io/acme' }, { include: [], exclude: [] }),
      registryAddArgs('acme', { oci: 'ghcr.io/acme' }),
    );
  });

  test('registryAddArgs keeps a leading-hyphen glob a flag VALUE, not a flag', () => {
    // `--` cannot protect these — they are flag values, and everything after
    // the separator parses positionally. `=` is what delimits them.
    assert.deepStrictEqual(
      registryAddArgs('acme', { oci: 'ghcr.io/acme' }, { include: ['--global'] }),
      ['config', 'registry', 'add', '--oci=ghcr.io/acme', '--include=--global', '--', 'acme'],
    );
  });

  test('registryAddArgs forces a leading-hyphen alias positional and protects the locator via --flag=value', () => {
    assert.deepStrictEqual(registryAddArgs('-x', { oci: '--not-a-flag' }), [
      'config',
      'registry',
      'add',
      '--oci=--not-a-flag',
      '--',
      '-x',
    ]);
  });

  test('registrySetArgs mirrors registryAddArgs flag for flag', () => {
    assert.deepStrictEqual(
      registrySetArgs(
        'acme',
        { index: 'https://index.acme.internal' },
        {
          include: ['acme/platform/**', 'acme/{tools,libs}/**'],
          exclude: ['acme/platform/legacy/**'],
          default: true,
        },
      ),
      [
        'config',
        'registry',
        'set',
        '--index=https://index.acme.internal',
        '--include=acme/platform/**',
        '--include=acme/{tools,libs}/**',
        '--exclude=acme/platform/legacy/**',
        '--default',
        '--',
        'acme',
      ],
    );
  });

  test('registrySetArgs spells an emptied list with --clear-*, never alongside the pattern flags', () => {
    // A flag given zero times means "untouched", so an empty list needs the
    // clear flag — and the two are mutually exclusive per field even when a
    // caller names both.
    assert.deepStrictEqual(
      registrySetArgs(
        'acme',
        { oci: 'ghcr.io/acme' },
        { include: ['ignored/**'], clearInclude: true, exclude: ['b/**'] },
      ),
      [
        'config',
        'registry',
        'set',
        '--oci=ghcr.io/acme',
        '--clear-include',
        '--exclude=b/**',
        '--',
        'acme',
      ],
    );
  });

  test('registrySetArgs writes the plain-HTTP opt-in as a flag pair, and omits it when unset', () => {
    // grim's own tri-state: the flag absent leaves the stored value alone,
    // which is why the option is optional rather than a plain boolean.
    assert.deepStrictEqual(
      registrySetArgs('acme', { oci: 'localhost:5050/grimoire' }, { insecure: true }).slice(-3),
      ['--insecure', '--', 'acme'],
    );
    assert.deepStrictEqual(
      registrySetArgs('acme', { oci: 'localhost:5050/grimoire' }, { insecure: false }).slice(-3),
      ['--no-insecure', '--', 'acme'],
    );
    assert.ok(
      !registrySetArgs('acme', { oci: 'localhost:5050/grimoire' }).some((a) =>
        a.includes('insecure'),
      ),
    );
  });

  test('registrySetArgs keeps a leading-hyphen glob a flag VALUE, not a flag', () => {
    assert.deepStrictEqual(registrySetArgs('-x', { oci: '--not-a-flag' }, { exclude: ['-y'] }), [
      'config',
      'registry',
      'set',
      '--oci=--not-a-flag',
      '--exclude=-y',
      '--',
      '-x',
    ]);
  });

  test('editRegistrySteps is a single set when both lists are non-empty and default is on', () => {
    assert.deepStrictEqual(
      editRegistrySteps(
        'acme',
        { oci: 'ghcr.io/acme' },
        { default: true, include: ['a/**'], exclude: ['b/**'], insecure: false },
        { default: true, include: ['old/**'], exclude: ['old/**'], insecure: false },
      ),
      [
        [
          'config',
          'registry',
          'set',
          '--oci=ghcr.io/acme',
          '--include=a/**',
          '--exclude=b/**',
          '--default',
          '--',
          'acme',
        ],
      ],
    );
  });

  test('editRegistrySteps clears an emptied list on the same set, per side', () => {
    // Emptying one side rides on the single `registry set` as a clear flag and
    // leaves the other side's patterns untouched.
    assert.deepStrictEqual(
      editRegistrySteps(
        'acme',
        { oci: 'ghcr.io/acme' },
        { default: true, include: [], exclude: ['b/**'], insecure: false },
        { default: true, include: ['was/**'], exclude: ['b/**'], insecure: false },
      ),
      [
        [
          'config',
          'registry',
          'set',
          '--oci=ghcr.io/acme',
          '--clear-include',
          '--exclude=b/**',
          '--default',
          '--',
          'acme',
        ],
      ],
    );
  });

  test('editRegistrySteps demotes a cleared default through config set false', () => {
    // `--default` only ever promotes (it clears every OTHER entry's flag, like
    // `registry use`), so unchecking the box cannot ride on the set.
    assert.deepStrictEqual(
      editRegistrySteps(
        'acme',
        { oci: 'ghcr.io/acme' },
        { default: false, include: ['a/**'], exclude: ['b/**'], insecure: false },
        { default: true, include: ['a/**'], exclude: ['b/**'], insecure: false },
      ),
      [
        [
          'config',
          'registry',
          'set',
          '--oci=ghcr.io/acme',
          '--include=a/**',
          '--exclude=b/**',
          '--',
          'acme',
        ],
        ['config', 'set', '--', 'registry.acme.default', 'false'],
      ],
    );
  });

  test('editRegistrySteps promotes to default on the set itself, with no follow-up', () => {
    assert.deepStrictEqual(
      editRegistrySteps(
        'acme',
        { oci: 'ghcr.io/acme' },
        { default: true, include: ['a/**'], exclude: [], insecure: false },
        { default: false, include: ['a/**'], exclude: [], insecure: false },
      ),
      [
        [
          'config',
          'registry',
          'set',
          '--oci=ghcr.io/acme',
          '--include=a/**',
          '--default',
          '--',
          'acme',
        ],
      ],
    );
  });

  test('editRegistrySteps writes the plain-HTTP opt-in only when it moves', () => {
    const on = editRegistrySteps(
      'local',
      { oci: 'localhost:5050/grimoire' },
      { default: false, include: [], exclude: [], insecure: true },
      { default: false, include: [], exclude: [], insecure: false },
    );
    assert.deepStrictEqual(on, [
      ['config', 'registry', 'set', '--oci=localhost:5050/grimoire', '--insecure', '--', 'local'],
    ]);
    const unchanged = editRegistrySteps(
      'local',
      { oci: 'localhost:5050/grimoire' },
      { default: false, include: [], exclude: [], insecure: true },
      { default: false, include: [], exclude: [], insecure: true },
    );
    assert.ok(!unchanged[0]?.some((a) => a.includes('insecure')));
  });

  test('editRegistrySteps turns the opt-in off on a swap to an index locator', () => {
    // grim REFUSES to load an index entry carrying `insecure` (exit 78), so the
    // `false` half has to ride along with `--index` — which grim allows; only
    // ENABLING is refused there.
    assert.deepStrictEqual(
      editRegistrySteps(
        'local',
        { index: 'https://index.acme.internal' },
        { default: false, include: [], exclude: [], insecure: false },
        { default: false, include: [], exclude: [], insecure: true },
      ),
      [
        [
          'config',
          'registry',
          'set',
          '--index=https://index.acme.internal',
          '--no-insecure',
          '--',
          'local',
        ],
      ],
    );
  });

  test('editRegistrySteps emits nothing subtractive when nothing was there to subtract', () => {
    // The ordinary save: a registry that is not the default, with a list that
    // was already empty, is ONE process spawn and carries no clear flag.
    assert.deepStrictEqual(
      editRegistrySteps(
        'acme',
        { oci: 'ghcr.io/acme' },
        { default: false, include: ['a/**'], exclude: [], insecure: false },
        { default: false, include: [], exclude: [], insecure: false },
      ),
      [['config', 'registry', 'set', '--oci=ghcr.io/acme', '--include=a/**', '--', 'acme']],
    );
  });

  test('editRegistrySteps clearing everything is one set with both clear flags, then a demotion', () => {
    assert.deepStrictEqual(
      editRegistrySteps(
        'acme',
        { index: 'https://index.acme.internal' },
        { default: false, include: [], exclude: [], insecure: false },
        { default: true, include: ['a/**'], exclude: ['b/**'], insecure: false },
      ),
      [
        [
          'config',
          'registry',
          'set',
          '--index=https://index.acme.internal',
          '--clear-include',
          '--clear-exclude',
          '--',
          'acme',
        ],
        ['config', 'set', '--', 'registry.acme.default', 'false'],
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
    const doc =
      '{"error":{"code":"data","exit":65,"message":"partial-resolve refused","reason":"stale-lock"}}';
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

  test('retryable is surfaced when present', () => {
    const doc =
      '{"error":{"code":"data","exit":65,"message":"partial-resolve refused","reason":"locked","retryable":true}}';
    const result = parseReport(doc, 65, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.retryable, true);
  });

  test('absent retryable stays undefined', () => {
    const doc = '{"error":{"code":"auth","exit":80,"message":"401 from registry"}}';
    const result = parseReport(doc, 80, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.retryable, undefined);
  });

  test('forceable is surfaced when present', () => {
    const doc =
      '{"error":{"code":"data","exit":65,"message":"installed artifact was modified locally","reason":"modified","forceable":true}}';
    const result = parseReport(doc, 65, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.forceable, true);
  });

  test('absent forceable stays undefined', () => {
    const doc = '{"error":{"code":"auth","exit":80,"message":"401 from registry"}}';
    const result = parseReport(doc, 80, '');
    assert.ok(!result.ok && result.kind === 'error');
    assert.strictEqual(result.forceable, undefined);
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
          constraints: null,
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
    assert.strictEqual(entry.constraints, null);
  });

  test('ConfigEntry: a list key with an item-shape rule carries item_pattern + item_width', () => {
    const doc = JSON.stringify({
      key: 'options.tui.tree_separators',
      value: '/',
      set: false,
      type: 'string-list',
      title: 'Tree separators',
      description: 'Characters that split the repository path into nested groups.',
      default: '/',
      values: null,
      constraints: { item_pattern: '^[^\\s\\p{C}]$', item_width: 1 },
    });
    const result = parseReport<ConfigEntry>(doc, 0, '');
    assert.ok(result.ok);
    assert.deepStrictEqual(result.value.constraints, {
      item_pattern: '^[^\\s\\p{C}]$',
      item_width: 1,
    });
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

  test('UpdateEntry: nulls and empty client arrays survive parsing', () => {
    const doc = JSON.stringify({
      items: [
        {
          kind: 'skill',
          name: 'code-review',
          old: null,
          new: 'sha256:abc',
          action: 'updated',
          reaped_clients: [],
          kept_modified_clients: [],
        },
      ],
    });
    const result = parseReport<ItemsEnvelope<UpdateEntry>>(doc, 0, '');
    assert.ok(result.ok);
    const entry = result.value.items[0];
    assert.ok(entry);
    assert.strictEqual(entry.old, null);
    assert.strictEqual(entry.new, 'sha256:abc');
    assert.strictEqual(entry.action, 'updated');
    assert.deepStrictEqual(entry.reaped_clients, []);
    assert.deepStrictEqual(entry.kept_modified_clients, []);
  });

  test('UpdateEntry: removed/kept-modified rows carry a null new digest and populated client arrays', () => {
    const doc = JSON.stringify({
      items: [
        {
          kind: 'rule',
          name: 'dropped-rule',
          old: 'sha256:old1',
          new: null,
          action: 'removed',
          reaped_clients: ['copilot'],
          kept_modified_clients: [],
        },
        {
          kind: 'rule',
          name: 'edited-rule',
          old: 'sha256:old2',
          new: null,
          action: 'kept-modified',
          reaped_clients: [],
          kept_modified_clients: ['claude'],
        },
      ],
    });
    const result = parseReport<ItemsEnvelope<UpdateEntry>>(doc, 0, '');
    assert.ok(result.ok);
    const [removed, keptModified] = result.value.items;
    assert.ok(removed && keptModified);
    assert.strictEqual(removed.new, null);
    assert.deepStrictEqual(removed.reaped_clients, ['copilot']);
    assert.strictEqual(keptModified.action, 'kept-modified');
    assert.deepStrictEqual(keptModified.kept_modified_clients, ['claude']);
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

    const registrySet = parseReport<ConfigWriteResult>(
      '{"action":"registry-set","key":"registry.acme","value":"ghcr.io/acme","scope":"global"}',
      0,
      '',
    );
    assert.ok(registrySet.ok);
    assert.strictEqual(registrySet.value.action, 'registry-set');
  });

  test('ConfigWriteResult carries dry_run verbatim: true for --dry-run, false for a real write', () => {
    const dryRun = parseReport<ConfigWriteResult>(
      '{"action":"set","key":"options.tui.default_view","value":"tree","scope":"project","dry_run":true}',
      0,
      '',
    );
    assert.ok(dryRun.ok);
    assert.strictEqual(dryRun.value.dry_run, true);

    const realWrite = parseReport<ConfigWriteResult>(
      '{"action":"set","key":"options.tui.default_view","value":"tree","scope":"project","dry_run":false}',
      0,
      '',
    );
    assert.ok(realWrite.ok);
    assert.strictEqual(realWrite.value.dry_run, false);
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

suite('isRetryable', () => {
  test('retryable:true + non-75 exit is retryable', () => {
    assert.strictEqual(isRetryable({ exitCode: 65, retryable: true }), true);
  });

  test('retryable absent + exit 75 is retryable', () => {
    assert.strictEqual(isRetryable({ exitCode: 75 }), true);
  });

  test('retryable:false + exit 75 is still retryable (exit code wins)', () => {
    assert.strictEqual(isRetryable({ exitCode: 75, retryable: false }), true);
  });

  test('retryable absent + other exit is not retryable', () => {
    assert.strictEqual(isRetryable({ exitCode: 65 }), false);
  });
});

suite('isForceable', () => {
  test('forceable:true is forceable', () => {
    assert.strictEqual(isForceable({ forceable: true }), true);
  });

  test('forceable:false is not forceable', () => {
    assert.strictEqual(isForceable({ forceable: false }), false);
  });

  test('absent forceable is not forceable', () => {
    assert.strictEqual(isForceable({}), false);
  });

  test('a bare exit 65 with no forceable tag is not forceable — unlike isRetryable, there is no exit-code fallback', () => {
    // exit 65 also covers non-forceable failures (e.g. anchor-escape), so it
    // must never be read as a forceable signal on its own.
    const bareRefusal: { exitCode: number; forceable?: boolean } = { exitCode: 65 };
    assert.strictEqual(isForceable(bareRefusal), false);
  });

  test('a non-boolean truthy forceable value is rejected — `=== true` only, no truthiness coercion', () => {
    // grim's contract promises a bare boolean, but the value crosses a
    // subprocess/JSON boundary untrusted — pin that a string or number
    // impersonating "true" is not read as forceable.
    const stringTrue = { forceable: 'true' } as unknown as { forceable?: boolean };
    const numberOne = { forceable: 1 } as unknown as { forceable?: boolean };
    assert.strictEqual(isForceable(stringTrue), false);
    assert.strictEqual(isForceable(numberOne), false);
  });
});
