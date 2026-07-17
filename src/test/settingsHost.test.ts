// Integration coverage for SettingsManager (src/views/settings.ts): the
// message-driven write queue, lock-retry, and success/failure repost
// contract (spec settings-impl-spec.md §2/§3). Uses a dedicated POSIX stub
// (Windows cannot execFile shell scripts — skipped there, same as
// extension.test.ts) rather than the shared one, since `grim config ...`
// dispatch needs its own canned shapes. Only global scope is exercised — it
// needs no workspace folder, so this suite stays independent of the
// fixtures/workspace project used elsewhere.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GrimoireApi } from '../extension';
import type { HostToSettings, SettingsToHost } from '../webview/protocol';

const isWindows = process.platform === 'win32';

interface Stub {
  dir: string;
  executable: string;
  argvLog: string;
}

function canned(dir: string, name: string, doc: unknown): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(doc));
}

function writeStub(): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-settings-stub-'));
  const argvLog = path.join(dir, 'argv.log');
  const executable = path.join(dir, 'grim');
  const script = `#!/bin/sh
echo "$@" >> "${argvLog}"
if [ "$1" = "--global" ]; then
  shift
fi
cmd="$1"
if [ "$cmd" = "context" ]; then
  [ -f "${dir}/context.json" ] && { cat "${dir}/context.json"; exit 0; }
fi
if [ "$cmd" = "config" ]; then
  sub="$2"
  if [ "$sub" = "list" ]; then
    [ -f "${dir}/config-list.json" ] && { cat "${dir}/config-list.json"; exit 0; }
  elif [ "$sub" = "set" ]; then
    key="$3"
    case "$key" in
      reject-value)
        echo '{"error":{"code":"data","exit":65,"message":"invalid value for options.reject-value"}}'
        exit 0 ;;
      lock-once)
        if [ -f "${dir}/lock-hit" ]; then
          rm -f "${dir}/lock-hit"
          cat "${dir}/config-set.json"
        else
          touch "${dir}/lock-hit"
          echo '{"error":{"code":"lock","exit":75,"message":"grimoire.lock is locked"}}'
        fi
        exit 0 ;;
      *)
        [ -f "${dir}/config-set.json" ] && { cat "${dir}/config-set.json"; exit 0; } ;;
    esac
  elif [ "$sub" = "unset" ]; then
    [ -f "${dir}/config-unset.json" ] && { cat "${dir}/config-unset.json"; exit 0; }
  elif [ "$sub" = "registry" ]; then
    action="$3"
    case "$action" in
      list) [ -f "${dir}/registry-list.json" ] && { cat "${dir}/registry-list.json"; exit 0; } ;;
      add) [ -f "${dir}/registry-add.json" ] && { cat "${dir}/registry-add.json"; exit 0; } ;;
      rm) [ -f "${dir}/registry-rm.json" ] && { cat "${dir}/registry-rm.json"; exit 0; } ;;
      use) [ -f "${dir}/registry-use.json" ] && { cat "${dir}/registry-use.json"; exit 0; } ;;
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
    grim_home: path.join(os.tmpdir(), 'grim-settings-home'),
    offline: false,
    clients: ['claude'],
    registries: [],
    default_registry: null,
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

suite('settings host integration', () => {
  let stub: Stub;

  suiteSetup(async function () {
    if (isWindows) {
      this.skip();
    }
    stub = writeStub();
    canned(stub.dir, 'context', contextDoc());
    canned(stub.dir, 'config-list', { items: [configEntry('expand_levels')] });
    canned(stub.dir, 'registry-list', { items: [] });
    canned(stub.dir, 'config-set', {
      action: 'set',
      key: 'options.expand_levels',
      value: '2',
      scope: 'global',
    });
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
    const setCalls = argvLines(stub).filter((l) => l.startsWith('config set lock-once'));
    assert.strictEqual(setCalls.length, 2, 'expected exactly one retry after the exit-75 failure');
  });
});
