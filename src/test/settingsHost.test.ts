// Integration coverage for SettingsManager (src/views/settings.ts): the
// message-driven write queue, lock-retry, and success/failure repost
// contract. Uses a dedicated POSIX stub
// (Windows cannot execFile shell scripts — skipped there, same as
// extension.test.ts) rather than the shared one, since `grim config ...`
// dispatch needs its own canned shapes. Most cases exercise global scope only
// (no workspace-folder dependency); the project-init flow below is the one
// exception and relies on the workspace folder .vscode-test.mjs always opens
// (src/test/fixtures/workspace) — it never touches that folder's real
// grimoire.toml, only this suite's own stub responses.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GrimoireApi } from '../extension';
import { ScopeService } from '../scopes';
import { SettingsManager } from '../views/settings';
import { Watchers } from '../watchers';
import type { HostToSettings, SettingsToHost } from '../webview/protocol';

const isWindows = process.platform === 'win32';

interface Stub {
  dir: string;
  executable: string;
  argvLog: string;
}

/** The (fake) global $GRIM_HOME — a real directory the stub's global-scope
 *  writes touch (grimoire.toml) as a side effect, same as real grim persisting
 *  a config change to disk. Exists so the external-edit/self-write watcher
 *  tests have a real file to watch: it's the SAME path handed back as
 *  `grim_home` in contextDoc(), which is what production `rebuildWatchers()`
 *  arms its global-scope watch against. */
const GRIM_HOME_DIR = path.join(os.tmpdir(), 'grim-settings-home');

function canned(dir: string, name: string, doc: unknown): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(doc));
}

function writeStub(): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-settings-stub-'));
  const argvLog = path.join(dir, 'argv.log');
  const executable = path.join(dir, 'grim');
  const script = `#!/bin/sh
echo "$@" >> "${argvLog}"
scope=project
if [ "$1" = "--global" ]; then
  scope=global
  shift
fi
cmd="$1"
touch_home() {
  # Mimics real grim persisting a global-scope write to grimoire.toml —
  # only for global scope, so project-scope writes never touch this file.
  [ "$scope" = "global" ] || return 0
  echo "$1" >> "${GRIM_HOME_DIR}/grimoire.toml"
  # Self-write-suppression test: holds the grim process open past the file
  # write so the fs event has time to arrive (and be dropped) WHILE the
  # caller's suspendWhile is still active, instead of racing suspendDepth
  # returning to 0 against inotify delivery latency.
  [ -f "${dir}/slow-touch" ] && sleep 0.5
}
if [ "$cmd" = "context" ]; then
  if [ "$scope" = "global" ]; then
    # Global's own before/after pair (mirrors project's below) is opt-in: only
    # consulted once a test has actually canned one of the two files, so every
    # pre-existing global-scope test (relying on the plain context.json,
    # config_exists:true unconditionally) is unaffected.
    if [ -f "${dir}/context-global-before.json" ] || [ -f "${dir}/context-global-after.json" ]; then
      if [ -f "${dir}/global-initialized" ]; then
        [ -f "${dir}/context-global-after.json" ] && { cat "${dir}/context-global-after.json"; exit 0; }
      else
        [ -f "${dir}/context-global-before.json" ] && { cat "${dir}/context-global-before.json"; exit 0; }
      fi
    fi
    [ -f "${dir}/context.json" ] && { cat "${dir}/context.json"; exit 0; }
  else
    if [ -f "${dir}/project-initialized" ]; then
      [ -f "${dir}/context-project-after.json" ] && { cat "${dir}/context-project-after.json"; exit 0; }
    else
      [ -f "${dir}/context-project-before.json" ] && { cat "${dir}/context-project-before.json"; exit 0; }
    fi
  fi
fi
if [ "$cmd" = "init" ]; then
  if [ "$scope" = "global" ]; then
    touch "${dir}/global-initialized"
  else
    touch "${dir}/project-initialized"
  fi
  [ -f "${dir}/init.json" ] && { cat "${dir}/init.json"; exit 0; }
fi
if [ "$cmd" = "config" ]; then
  sub="$2"
  if [ "$sub" = "list" ]; then
    [ -f "${dir}/config-list.json" ] && { cat "${dir}/config-list.json"; exit 0; }
  elif [ "$sub" = "set" ]; then
    # configSetArgs emits config set -- key value (grim.ts), but runJson
    # inserts --format json right before that --, so key/value's exact
    # position shifts (and --global, already shifted off above, would too) —
    # grab the last two "$@" tokens instead of a fixed index.
    key=""
    value=""
    for tok in "$@"; do
      key="$value"
      value="$tok"
    done
    case "$key" in
      reject-value)
        echo '{"error":{"code":"data","exit":65,"message":"invalid value for options.reject-value"}}'
        exit 0 ;;
      lock-once)
        if [ -f "${dir}/lock-hit" ]; then
          rm -f "${dir}/lock-hit"
          touch_home "set lock-once"
          cat "${dir}/config-set.json"
        else
          touch "${dir}/lock-hit"
          echo '{"error":{"code":"lock","exit":75,"message":"grimoire.lock is locked"}}'
        fi
        exit 0 ;;
      *)
        if [ -f "${dir}/config-set.json" ]; then
          touch_home "set $key"
          cat "${dir}/config-set.json"
          exit 0
        fi ;;
    esac
  elif [ "$sub" = "unset" ]; then
    [ -f "${dir}/config-unset.json" ] && { cat "${dir}/config-unset.json"; exit 0; }
  elif [ "$sub" = "registry" ]; then
    action="$3"
    # registryAddArgs/registryRmArgs/registryUseArgs (grim.ts) all now emit
    # the alias as the LAST token (after a --, or after the --oci=/--index=
    # flag for add) rather than at a fixed position — grab the last "$@"
    # entry instead of a fixed $4.
    alias_arg=""
    for tok in "$@"; do
      alias_arg="$tok"
    done
    case "$action" in
      list) [ -f "${dir}/registry-list.json" ] && { cat "${dir}/registry-list.json"; exit 0; } ;;
      fields) [ -f "${dir}/registry-fields.json" ] && { cat "${dir}/registry-fields.json"; exit 0; } ;;
      add)
        case "$alias_arg" in
          dup-alias)
            echo '{"error":{"code":"usage","exit":64,"message":"registry alias already exists"}}'
            exit 0 ;;
          *)
            if [ -f "${dir}/registry-add.json" ]; then
              touch_home "registry-add $alias_arg"
              cat "${dir}/registry-add.json"
              exit 0
            fi ;;
        esac ;;
      rm)
        if [ -f "${dir}/registry-rm.json" ]; then
          touch_home "registry-rm $alias_arg"
          cat "${dir}/registry-rm.json"
          exit 0
        fi ;;
      use)
        if [ -f "${dir}/registry-use.json" ]; then
          touch_home "registry-use $alias_arg"
          cat "${dir}/registry-use.json"
          exit 0
        fi ;;
    esac
  fi
fi
echo '{"error":{"code":"usage","exit":64,"message":"unhandled stub call"}}'
`;
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return { dir, executable, argvLog };
}

function contextDoc(): Record<string, unknown> {
  return {
    version: '0.9.0',
    scope: 'global',
    workspace: null,
    config_path: '/nonexistent/global-grimoire.toml',
    config_exists: true,
    lock_path: '/nonexistent/global-grimoire.lock',
    lock_exists: true,
    grim_home: GRIM_HOME_DIR,
    offline: false,
    clients: ['claude'],
    registries: [],
    default_registry: null,
  };
}

/** Global-scope `grim context` before/after `grim init --global` — same
 *  before/after-marker convention as contextProjectDoc, gated behind its own
 *  opt-in files (see the stub script's comment) so every OTHER global-scope
 *  test, which never cans these, keeps hitting the plain contextDoc()
 *  (config_exists: true) exactly as before. */
function contextGlobalDoc(configExists: boolean): Record<string, unknown> {
  return {
    version: '0.9.0',
    scope: 'global',
    workspace: null,
    config_path: '/nonexistent/global-grimoire.toml',
    config_exists: configExists,
    lock_path: '/nonexistent/global-grimoire.lock',
    lock_exists: configExists,
    grim_home: GRIM_HOME_DIR,
    offline: false,
    clients: [],
    registries: [],
    default_registry: null,
  };
}

/** Project-scope `grim context` AFTER `grim init` — the stub's `init` handler
 *  flips which of these two docs it returns (project-initialized marker), so
 *  `ready` -> `initProject` -> re-fetch can be driven end to end. Only ever
 *  the config_exists:true shape: real grim never succeeds with
 *  config_exists:false for project scope (see notDiscoveredDoc below). */
function contextProjectDoc(): Record<string, unknown> {
  return {
    version: '0.9.0',
    scope: 'project',
    workspace: '/fixture-workspace',
    config_path: '/fixture-workspace/grimoire.toml',
    config_exists: true,
    lock_path: '/fixture-workspace/grimoire.lock',
    lock_exists: true,
    grim_home: GRIM_HOME_DIR,
    offline: false,
    clients: [],
    registries: [],
    default_registry: null,
  };
}

/** grim's real failure shape for `context` when no grimoire.toml exists
 *  anywhere up the directory tree from the project workspace folder
 *  (ConfigError::NotDiscovered) — verified live against grim 0.9.0. This is
 *  the BEFORE-init state for project scope: grim's walk-up discovery itself
 *  fails, so `context` never reaches the point of reporting
 *  config_exists:false (see isProjectNotDiscovered, src/scopes.ts). */
function notDiscoveredDoc(): Record<string, unknown> {
  return {
    error: {
      code: 'not-found',
      exit: 79,
      message: '/fixture-workspace: no grimoire.toml found by walking up from the working directory',
    },
  };
}

function configEntry(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: `options.${key}`,
    value: null,
    set: false,
    type: 'integer',
    title: key,
    description: `The ${key} option.`,
    default: '1',
    values: null,
    constraints: null,
    ...overrides,
  };
}

/** A detached webview-panel double that records posted messages — the same
 *  "untracked panel" convention extension.test.ts's fakePanel() uses for
 *  DetailsManager (SettingsManager.post() only guards against a DISPOSED
 *  panel, so a plain double works without ever calling settings.open()). */
function fakeSettingsPanel(): { panel: vscode.WebviewPanel; posts: HostToSettings[] } {
  const posts: HostToSettings[] = [];
  const panel = {
    webview: {
      postMessage: (message: HostToSettings) => {
        posts.push(message);
        return Promise.resolve(true);
      },
    },
  } as unknown as vscode.WebviewPanel;
  return { panel, posts };
}

function argvLines(stub: Stub): string[] {
  try {
    return (
      fs
        .readFileSync(stub.argvLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        // withGlobalFlag prepends --global before the subcommand; shift it to
        // the tail so a plain `startsWith('config ...')` check works either way.
        .map((l) => (l.startsWith('--global ') ? `${l.slice('--global '.length)} --global` : l))
    );
  } catch {
    return [];
  }
}

async function activateExtension(): Promise<GrimoireApi> {
  const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
  assert.ok(extension, 'extension not found');
  const api = await extension.activate();
  assert.ok(api, 'extension returned no API');
  return api;
}

async function send(
  api: GrimoireApi,
  panel: vscode.WebviewPanel,
  message: SettingsToHost,
): Promise<void> {
  await api.providers.settings.onMessage(panel, message);
}

function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout waiting for condition'));
      } else {
        setTimeout(tick, 100);
      }
    };
    tick();
  });
}

suite('settings host integration', () => {
  let stub: Stub;

  suiteSetup(async function () {
    if (isWindows) {
      this.skip();
    }
    stub = writeStub();
    canned(stub.dir, 'context', contextDoc());
    canned(stub.dir, 'context-project-before', notDiscoveredDoc());
    canned(stub.dir, 'context-project-after', contextProjectDoc());
    canned(stub.dir, 'init', { path: '/fixture-workspace/grimoire.toml', scope: 'project', status: 'created' });
    canned(stub.dir, 'config-list', { items: [configEntry('expand_levels')] });
    canned(stub.dir, 'registry-list', { items: [] });
    canned(stub.dir, 'config-set', {
      action: 'set',
      key: 'options.expand_levels',
      value: '2',
      scope: 'global',
    });
    canned(stub.dir, 'registry-add', {
      action: 'registry-added',
      key: 'acme',
      value: 'ghcr.io/acme',
      scope: 'global',
    });
    canned(stub.dir, 'registry-rm', {
      action: 'registry-removed',
      key: 'acme',
      value: null,
      scope: 'global',
    });
    canned(stub.dir, 'registry-use', {
      action: 'registry-default',
      key: 'acme',
      value: null,
      scope: 'global',
    });
    fs.mkdirSync(GRIM_HOME_DIR, { recursive: true });
    fs.writeFileSync(path.join(GRIM_HOME_DIR, 'grimoire.toml'), 'initial\n');
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', stub.executable, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    if (isWindows) {
      return;
    }
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(GRIM_HOME_DIR, { recursive: true, force: true });
  });

  test('ready posts a ready-phase state built from config list + registry list', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' });
    assert.strictEqual(posts.length, 1);
    const message = posts[0];
    assert.ok(message);
    assert.strictEqual(message.type, 'state');
    if (message.type !== 'state') {
      return;
    }
    assert.strictEqual(message.state.phase, 'ready');
    assert.strictEqual(message.state.scope, 'global');
    assert.strictEqual(message.state.groups.flatMap((g) => g.rows).length, 1);
  });

  test('setValue success re-fetches and reposts state (no writeError)', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' }); // establishes activeScope
    await send(api, panel, {
      type: 'setValue',
      scope: 'global',
      key: 'options.expand_levels',
      value: '2',
    });
    const writeResult = posts[posts.length - 1];
    assert.ok(writeResult);
    assert.strictEqual(writeResult.type, 'state');
  });

  test('setValue rejected (exit 65) posts writeError only — no state repost', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' });
    posts.length = 0; // isolate the write's own posts from the ready reply above
    await send(api, panel, { type: 'setValue', scope: 'global', key: 'reject-value', value: 'x' });
    assert.strictEqual(posts.length, 1, 'expected exactly one post: writeError, no state repost');
    const message = posts[0];
    assert.ok(message);
    assert.strictEqual(message.type, 'writeError');
    if (message.type === 'writeError') {
      assert.strictEqual(message.key, 'reject-value');
      assert.match(message.message, /invalid value/);
    }
  });

  test('setValue retries once on lock contention (exit 75), then succeeds', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    fs.rmSync(path.join(stub.dir, 'lock-hit'), { force: true });
    await send(api, panel, { type: 'ready', scope: 'global' });
    await send(api, panel, { type: 'setValue', scope: 'global', key: 'lock-once', value: 'x' });
    const last = posts[posts.length - 1];
    assert.ok(last);
    assert.strictEqual(last.type, 'state', 'the retried write should succeed and repost state');
    // Not a startsWith: runJson inserts `--format json` before configSetArgs's
    // own `--`, so the logged line is `config set --format json -- lock-once
    // x` (plus a trailing `--global`, moved there by argvLines) — match on
    // the stable `-- lock-once` pair the builder always emits together.
    const setCalls = argvLines(stub).filter(
      (l) => l.startsWith('config set') && l.includes('-- lock-once'),
    );
    assert.strictEqual(setCalls.length, 2, 'expected exactly one retry after the exit-75 failure');
  });

  test('addRegistry success re-fetches and reposts state', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' });
    posts.length = 0;
    await send(api, panel, {
      type: 'addRegistry',
      scope: 'global',
      alias: 'acme',
      locator: { oci: 'ghcr.io/acme' },
      default: false,
    });
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0]?.type, 'state');
  });

  test('addRegistry with a duplicate alias (exit 64) posts writeError only', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' });
    posts.length = 0;
    await send(api, panel, {
      type: 'addRegistry',
      scope: 'global',
      alias: 'dup-alias',
      locator: { oci: 'ghcr.io/dup' },
      default: false,
    });
    assert.strictEqual(posts.length, 1, 'expected exactly one post: writeError, no state repost');
    const message = posts[0];
    assert.ok(message);
    assert.strictEqual(message.type, 'writeError');
    if (message.type === 'writeError') {
      assert.strictEqual(message.key, 'dup-alias');
      assert.match(message.message, /already exists/);
    }
  });

  test('removeRegistry success re-fetches and reposts state', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' });
    posts.length = 0;
    await send(api, panel, { type: 'removeRegistry', scope: 'global', alias: 'acme' });
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0]?.type, 'state');
  });

  test('useRegistry success re-fetches and reposts state', async () => {
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    await send(api, panel, { type: 'ready', scope: 'global' });
    posts.length = 0;
    await send(api, panel, { type: 'useRegistry', scope: 'global', alias: 'acme' });
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0]?.type, 'state');
  });

  // Regression: real grim's `context` FAILS outright (NotDiscovered, code
  // "not-found", exit 79 — see notDiscoveredDoc/isProjectNotDiscovered) for
  // an unconfigured project, rather than succeeding with
  // config_exists:false. buildState() must route that failure to the
  // 'project-no-toml' empty state, not let it fall through to the generic
  // 'error' phase with grim's raw walk-up message.
  test('project scope: no toml -> initProject -> re-fetch shows the ready panel', async () => {
    fs.rmSync(path.join(stub.dir, 'project-initialized'), { force: true });
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    fs.rmSync(stub.argvLog, { force: true });

    await send(api, panel, { type: 'ready', scope: 'project' });
    assert.strictEqual(posts.length, 1);
    const before = posts[0];
    assert.ok(before);
    assert.strictEqual(before.type, 'state');
    if (before.type === 'state') {
      assert.notStrictEqual(
        before.state.phase,
        'error',
        'the NotDiscovered probe failure must not surface as a raw grim error',
      );
      assert.strictEqual(before.state.phase, 'project-no-toml');
      assert.strictEqual(before.state.error, undefined, 'no raw grim message leaks through');
    }
    posts.length = 0;

    await send(api, panel, { type: 'initProject' });
    const initCalls = argvLines(stub).filter((l) => l.startsWith('init'));
    assert.strictEqual(initCalls.length, 1);
    assert.ok(!initCalls[0]?.includes('--global'), 'init targets the project scope');

    const after = posts[posts.length - 1];
    assert.ok(after);
    assert.strictEqual(after.type, 'state');
    if (after.type === 'state') {
      assert.strictEqual(after.state.phase, 'ready');
      assert.strictEqual(after.state.groups.flatMap((g) => g.rows).length, 1);
    }
  });

  // Regression (user-reported bug, spec §2 — user-decided 2026-07-17): opening
  // Settings must never materialize a config file. Global used to always call
  // `config list`/`registry list` (and render as fully "ready") even with no
  // global grimoire.toml, so the form's very first control edit silently
  // created the file with no explicit Initialize step ever having run. Mirrors
  // the project no-toml test above, but for Global, and additionally asserts
  // the absence of the materializing calls (not just the resulting phase).
  test('global scope: no toml -> ready posts global-no-toml WITHOUT calling config list/registry list/init; initGlobal -> grim init --global -> re-fetch', async () => {
    fs.rmSync(path.join(stub.dir, 'global-initialized'), { force: true });
    canned(stub.dir, 'context-global-before', contextGlobalDoc(false));
    canned(stub.dir, 'context-global-after', contextGlobalDoc(true));
    const api = await activateExtension();
    const { panel, posts } = fakeSettingsPanel();
    fs.rmSync(stub.argvLog, { force: true });

    await send(api, panel, { type: 'ready', scope: 'global' });
    assert.strictEqual(posts.length, 1);
    const before = posts[0];
    assert.ok(before);
    assert.strictEqual(before.type, 'state');
    if (before.type === 'state') {
      assert.strictEqual(before.state.phase, 'global-no-toml');
      assert.strictEqual(before.state.groups.length, 0);
    }
    const preInitCalls = argvLines(stub);
    assert.ok(
      !preInitCalls.some((l) => l.startsWith('config list') || l.startsWith('config registry list')),
      `opening an unconfigured Global scope must never call config/registry list, got: ${JSON.stringify(preInitCalls)}`,
    );
    assert.ok(
      !preInitCalls.some((l) => l.startsWith('init')),
      'must never auto-init on open — init runs only via the initGlobal message',
    );
    posts.length = 0;

    await send(api, panel, { type: 'initGlobal' });
    const initCalls = argvLines(stub).filter((l) => l.startsWith('init'));
    assert.strictEqual(initCalls.length, 1);
    assert.ok(initCalls[0]?.includes('--global'), 'init targets the global scope');

    const after = posts[posts.length - 1];
    assert.ok(after);
    assert.strictEqual(after.type, 'state');
    if (after.type === 'state') {
      assert.strictEqual(after.state.phase, 'ready');
      assert.strictEqual(after.state.groups.flatMap((g) => g.rows).length, 1);
    }
  });

  test('a settings write suspends its own watcher event; a genuine external edit still refreshes', async function () {
    this.timeout(15000);
    // A standalone SettingsManager + Watchers pair (NOT the extension's
    // shared singleton — this test needs its own Watchers instance with a
    // short debounce so it doesn't cost a full second per assertion). It
    // still goes through the SAME grim stub (readConfig() picks up whatever
    // grimoire.path.executable is currently set to, module-wide).
    const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
    assert.ok(extension);
    const fakeOutput = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const scopes = new ScopeService(vscode.Uri.file(stub.dir), fakeOutput);
    const watchers = new Watchers(() => void manager.refreshOpenPanel(), 40);
    const suspendWhile = <T>(fn: () => Promise<T>): Promise<T> => watchers.suspendWhile(fn);
    const manager = new SettingsManager(
      extension.extensionUri,
      scopes,
      fakeOutput,
      async () => {},
      async () => {},
      suspendWhile,
    );
    const { panel, posts } = fakeSettingsPanel();
    // refreshOpenPanel() (the watcher's onChange target) posts to the
    // private `panel` field open() normally sets — open() would create a
    // REAL webview panel whose own bundle boots and posts its own 'ready'
    // asynchronously (racing this test's scripted messages), so assign the
    // field directly instead: deterministic, and every repost (explicit
    // write AND watcher-driven) lands in the same `posts` array either way.
    (manager as unknown as { panel: vscode.WebviewPanel }).panel = panel;
    try {
      watchers.rebuild(GRIM_HOME_DIR);
      await manager.onMessage(panel, { type: 'ready', scope: 'global' }); // establishes activeScope
      assert.strictEqual(posts.length, 1);

      // The write's own side effect (touch_home in the stub) mutates
      // GRIM_HOME_DIR/grimoire.toml — the very file `watchers` above watches.
      // suspendWhile must swallow that event: only the write's own explicit
      // repost should show up here. `slow-touch` holds the stub process open
      // past the file write so the fs event has time to arrive while still
      // inside suspendWhile, instead of racing suspendDepth returning to 0
      // (see writeStub's touch_home).
      fs.writeFileSync(path.join(stub.dir, 'slow-touch'), '');
      await manager.onMessage(panel, {
        type: 'setValue',
        scope: 'global',
        key: 'options.expand_levels',
        value: '2',
      });
      fs.rmSync(path.join(stub.dir, 'slow-touch'), { force: true });
      assert.strictEqual(posts.length, 2, "the write's own repost");
      assert.strictEqual(posts[1]?.type, 'state');

      // Give the debounced watcher a full window to fire a spurious extra
      // refresh from that same self-inflicted edit, were suspendWhile not
      // covering it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.strictEqual(
        posts.length,
        2,
        "the write's own edit must not trigger a second, redundant refresh",
      );

      // Now a genuine external edit (not through any grim write) — the
      // watcher must still be alive and refresh the open panel.
      fs.appendFileSync(path.join(GRIM_HOME_DIR, 'grimoire.toml'), 'external edit\n');
      await waitFor(() => posts.length > 2);
      assert.strictEqual(posts[2]?.type, 'state');
    } finally {
      watchers.dispose();
    }
  });

  // grim's real `config registry fields` shape (verified live against the
  // binary) — used by the two tests below. Deliberately NOT canned in
  // suiteSetup: every earlier test in this suite (and the shared
  // `api.providers.settings` singleton they exercise) must keep working with
  // NO registry-fields.json present at all, exactly like a grim predating
  // this subcommand — none of them inspect `state.registryFields`, so the
  // resulting `[]` fallback is silently harmless there.
  function registryFieldsDoc(): Record<string, unknown> {
    return {
      items: [
        {
          key: 'oci',
          type: 'string',
          title: 'OCI registry ref',
          description: 'Sets the OCI registry host, for example `ghcr.io` or `ghcr.io/acme` with a namespace.',
        },
        {
          key: 'index',
          type: 'string',
          title: 'Package-index locator',
          description: 'Sets a package-index locator that replaces the `_catalog` registry listing.',
        },
        {
          key: 'default',
          type: 'boolean',
          title: 'Default registry flag',
          description: 'Controls whether this registry is the primary one short identifiers expand against.',
        },
      ],
    };
  }

  /** A standalone SettingsManager reusing the SAME grim stub (readConfig()
   *  resolves `grimoire.path.executable`, module-wide, regardless of which
   *  ScopeService instance calls it — same convention the watcher test above
   *  uses) but with its OWN registryFieldsPromise cache, so these two tests
   *  can observe a single panel's fetch-once behavior in isolation from the
   *  shared `api.providers.settings` instance's own (separately memoized) cache. */
  function freshManager(): SettingsManager {
    const fakeOutput = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const scopes = new ScopeService(vscode.Uri.file(stub.dir), fakeOutput);
    return new SettingsManager(
      vscode.Uri.file(stub.dir),
      scopes,
      fakeOutput,
      async () => {},
      async () => {},
    );
  }

  test('registry fields are fetched from grim exactly once per panel and cached across repeated state builds', async () => {
    canned(stub.dir, 'registry-fields', registryFieldsDoc());
    try {
      const manager = freshManager();
      const { panel, posts } = fakeSettingsPanel();
      const before = argvLines(stub).filter((l) => l.startsWith('config registry fields')).length;

      await manager.onMessage(panel, { type: 'ready', scope: 'global' });
      await manager.onMessage(panel, { type: 'switchScope', scope: 'global' });
      await manager.onMessage(panel, { type: 'switchScope', scope: 'global' });

      const after = argvLines(stub).filter((l) => l.startsWith('config registry fields')).length;
      assert.strictEqual(
        after - before,
        1,
        'expected exactly one grim spawn for "config registry fields" across 3 state builds on the same panel',
      );

      const last = posts[posts.length - 1];
      assert.ok(last);
      assert.strictEqual(last.type, 'state');
      if (last.type === 'state') {
        // Labels/descriptions map straight from grim's title/description —
        // never re-derived or reordered.
        assert.deepStrictEqual(
          [...last.state.registryFields].sort((a, b) => a.key.localeCompare(b.key)),
          [
            { key: 'default', title: 'Default registry flag', description: 'Controls whether this registry is the primary one short identifiers expand against.' },
            { key: 'index', title: 'Package-index locator', description: 'Sets a package-index locator that replaces the `_catalog` registry listing.' },
            { key: 'oci', title: 'OCI registry ref', description: 'Sets the OCI registry host, for example `ghcr.io` or `ghcr.io/acme` with a namespace.' },
          ],
        );
      }
    } finally {
      fs.rmSync(path.join(stub.dir, 'registry-fields.json'), { force: true });
    }
  });

  test('a failed registry-fields fetch falls back to an empty list — no error surfaced, state still posts normally', async () => {
    fs.rmSync(path.join(stub.dir, 'registry-fields.json'), { force: true }); // absent: the stub's generic unhandled-call error fires
    const manager = freshManager();
    const { panel, posts } = fakeSettingsPanel();

    await manager.onMessage(panel, { type: 'ready', scope: 'global' });

    assert.strictEqual(posts.length, 1, 'no separate writeError/registryFields message — just the one state post');
    const message = posts[0];
    assert.ok(message);
    assert.strictEqual(message.type, 'state');
    if (message.type === 'state') {
      assert.strictEqual(message.state.phase, 'ready', 'the failed metadata fetch must not affect the scope phase');
      assert.deepStrictEqual(message.state.registryFields, []);
    }
  });
});
