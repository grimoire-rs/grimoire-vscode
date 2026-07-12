import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseDeclaredRefs, ScopeService, withGlobalFlag } from '../scopes';
import { artifactName } from '../webview/model';
import type { DetailsVM, HostToDetails, RevalidateState } from '../webview/protocol';
import type { GrimoireApi } from '../extension';

const isWindows = process.platform === 'win32';

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

interface Stub {
  dir: string;
  executable: string;
  argvLog: string;
}

/**
 * Writes a POSIX shell stub that plays grim: appends its argv to a log and
 * prints the canned JSON for the requested subcommand. (Windows cannot
 * execFile shell scripts — those suites are skipped there; the pure unit
 * suites cover the logic.)
 */
function writeStub(): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-stub-'));
  const argvLog = path.join(dir, 'argv.log');
  const executable = path.join(dir, 'grim');
  // A fetch for a "race-slow" repo sleeps, so tests can retarget the reusable
  // preview slot while its buildVM is still in flight (stale-VM race).
  const script = `#!/bin/sh
echo "$@" >> "${argvLog}"
# Real grim takes --global as a top-level flag BEFORE the subcommand
# (withGlobalFlag prepends it); consume it so $1/$2 stay subcommand/first-arg.
if [ "$1" = "--global" ]; then
  shift
fi
cmd="$1"
if [ "$cmd" = "fetch" ]; then
  case "$*" in
    *race-slow*) sleep 1 ;;
  esac
  # v2 description surface (feature-detected via describe.has_description), answered
  # from dedicated canned files so v2 tests can tell digest-only probes apart from
  # content fetches. In-tree README/CHANGELOG are fetched by --path against the
  # artifact's own files.
  case "$*" in
    *--digest-only*)
      case "$*" in
        *--description*) [ -f "${dir}/fetch-desc-digest.json" ] && { cat "${dir}/fetch-desc-digest.json"; exit 0; } ;;
        *) [ -f "${dir}/fetch-digest.json" ] && { cat "${dir}/fetch-digest.json"; exit 0; } ;;
      esac ;;
    *--description*)
      [ -f "${dir}/fetch-description.json" ] && { cat "${dir}/fetch-description.json"; exit 0; } ;;
    *--path*README*)
      [ -f "${dir}/fetch-readme.json" ] && { cat "${dir}/fetch-readme.json"; exit 0; } ;;
    *--path*CHANGELOG*)
      [ -f "${dir}/fetch-changelog.json" ] && { cat "${dir}/fetch-changelog.json"; exit 0; } ;;
  esac
fi
# A per-name update (a name in $2, not a flag) can be canned apart from the bare
# full update, so stale-lock recovery tests fail the partial resolve while the
# recovery full-resolve succeeds via update.json. Inert unless update-name.json exists.
if [ "$cmd" = "update" ] && [ -f "${dir}/update-name.json" ]; then
  case "$2" in
    -* | '') ;;
    *) cat "${dir}/update-name.json"; exit 0 ;;
  esac
fi
if [ -f "${dir}/$cmd.json" ]; then
  cat "${dir}/$cmd.json"
else
  echo '{"error":{"code":"usage","exit":64,"message":"unknown stub command"}}'
fi
`;
  fs.writeFileSync(executable, script, { mode: 0o755 });
  return { dir, executable, argvLog };
}

function canned(stub: Stub, command: string, doc: unknown): void {
  fs.writeFileSync(path.join(stub.dir, `${command}.json`), JSON.stringify(doc));
}

function argvLines(stub: Stub): string[] {
  try {
    return (
      fs
        .readFileSync(stub.argvLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        // withGlobalFlag prepends --global before the subcommand; assertions
        // are written subcommand-first, so shift the flag to the tail — every
        // `startsWith(<subcommand>)` and `includes('--global')` check reads
        // the same either way.
        .map((l) => (l.startsWith('--global ') ? `${l.slice('--global '.length)} --global` : l))
    );
  } catch {
    return [];
  }
}

function contextDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.9.0',
    scope: 'project',
    workspace: null,
    config_path: '/nonexistent/grimoire.toml',
    config_exists: false,
    lock_path: '/nonexistent/grimoire.lock',
    lock_exists: false,
    grim_home: path.join(os.tmpdir(), 'grim-stub-home'),
    offline: false,
    clients: ['claude'],
    registries: [
      // `authenticated` is the additive private-registry flag (item 8).
      { alias: null, url: 'https://index.grimoire.rs', kind: 'index', default: true, authenticated: true },
    ],
    default_registry: 'ghcr.io/grimoire-rs',
    ...overrides,
  };
}

/** A full describe report. `has_description` is added only via overrides — absent
 *  by default (a grim predating the v2 surface → no companion). */
function describeDoc(repo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: `${repo}:latest`,
    digest: 'sha256:desc',
    kind: 'skill',
    name: artifactName(repo),
    title: null,
    description: 'A skill.',
    summary: null,
    version: '1.0.0',
    license: null,
    repository: null,
    revision: null,
    created: null,
    keywords: null,
    deprecated: null,
    replaced_by: null,
    tags: ['1.0.0', 'latest'],
    annotations: {},
    ...overrides,
  };
}

function searchItem(repo: string): Record<string, unknown> {
  return {
    kind: 'skill',
    repo,
    summary: null,
    description: 'A skill.',
    version: '1.0.0',
    latest_tag: null,
    repository: null,
    revision: null,
    created: null,
    deprecated: null,
    status: 'not-installed',
  };
}

/** A detached webview-panel double that records posted VMs and revalidate states. */
function fakePanel(): {
  panel: vscode.WebviewPanel;
  posts: DetailsVM[];
  revalidates: RevalidateState[];
  revalidateMessages: Array<string | undefined>;
} {
  const posts: DetailsVM[] = [];
  const revalidates: RevalidateState[] = [];
  const revalidateMessages: Array<string | undefined> = [];
  const panel = {
    title: '',
    iconPath: undefined,
    webview: {
      postMessage: (message: HostToDetails) => {
        if (message.type === 'artifact') {
          posts.push(message.vm);
        } else if (message.type === 'revalidate') {
          revalidates.push(message.state);
          revalidateMessages.push(message.message);
        }
        return Promise.resolve(true);
      },
    },
  } as unknown as vscode.WebviewPanel;
  return { panel, posts, revalidates, revalidateMessages };
}

/** Minimal OutputChannel double that captures appendLine calls. */
function recordingOutput(lines: string[]): vscode.OutputChannel {
  return { appendLine: (l: string) => lines.push(l) } as unknown as vscode.OutputChannel;
}

/** Fresh, isolated snapshot-cache dir routed into the details service. */
function isolateCache(api: GrimoireApi): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-details-cache-'));
  api.providers.details.setCacheDir(dir);
  return dir;
}

async function activateExtension(): Promise<GrimoireApi> {
  const extension = vscode.extensions.getExtension<GrimoireApi>('grimoire-rs.grimoire-vscode');
  assert.ok(extension, 'extension not found');
  const api = await extension.activate();
  assert.ok(api, 'extension returned no API');
  return api;
}

suite('extension integration', () => {
  let stub: Stub;

  suiteSetup(async function () {
    if (isWindows) {
      this.skip();
    }
    stub = writeStub();
    canned(stub, 'context', contextDoc());
    canned(stub, 'search', { items: [] });
    canned(stub, 'status', { items: [] });
    canned(stub, 'add', { kind: 'skill', name: 'demo', pinned: 'x@sha256:1', status: 'added' });
    canned(stub, 'update', { items: [] });
    canned(stub, 'init', { path: '/tmp/grimoire.toml', scope: 'project', status: 'created' });
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', stub.executable, vscode.ConfigurationTarget.Global);
    await activateExtension();
  });

  suiteTeardown(async () => {
    if (isWindows) {
      return;
    }
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', undefined, vscode.ConfigurationTarget.Global);
  });

  test('all commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'grimoire.focusSearch',
      'grimoire.refresh',
      'grimoire.updateAll',
      'grimoire.initProject',
      'grimoire.installGrim',
      'grimoire.showOutput',
      'grimoire.openDetails',
    ]) {
      assert.ok(commands.includes(command), `${command} missing`);
    }
  });

  test('sidebar refresh invokes grim context/status/search with --format json', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.refresh();
    const lines = argvLines(stub);
    assert.ok(lines.length > 0, 'no grim invocations recorded');
    assert.ok(
      lines.every((l) => l.includes('--format json')),
      `all invocations carry --format json: ${lines.join(' | ')}`,
    );
    assert.ok(
      lines.some((l) => l.startsWith('context')),
      'context was invoked',
    );
  });

  test('sidebar install message round-trips to grim add with scope', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.handleMessage({
      type: 'install',
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage',
      scope: 'global',
    });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    const add = argvLines(stub).find((l) => l.startsWith('add'));
    assert.ok(add);
    assert.ok(add.includes('ghcr.io/grimoire-rs/skills/grim-usage'));
    assert.ok(add.includes('--global'));
  });

  test('browse install honors a project-scope target (no --global)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    // A project-scope install (the toggle set to Project); the add targets the
    // project scope — no --global — whether or not an init precedes it.
    await api.providers.sidebar.handleMessage({
      type: 'install',
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage',
      scope: 'project',
    });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    const add = argvLines(stub).find((l) => l.startsWith('add'));
    assert.ok(add && !add.includes('--global'), `install targets the project scope: ${add}`);
  });

  test('sidebar uninstall message round-trips to grim uninstall in project scope', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'uninstall', { kind: 'skill', name: 'demo', status: 'uninstalled' });
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.handleMessage({
      type: 'uninstall',
      kind: 'skill',
      name: 'demo',
      scope: 'project',
    });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('uninstall')));
    const line = argvLines(stub).find((l) => l.startsWith('uninstall'));
    assert.ok(line);
    assert.ok(line.includes('skill demo'));
    assert.ok(!line.includes('--global'));
  });

  test('uninstall of a bundle routes through grim remove, not uninstall', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'remove', { kind: 'bundle', name: 'grim-essentials', status: 'removed' });
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.handleMessage({
      type: 'uninstall',
      kind: 'bundle',
      name: 'grim-essentials',
      scope: 'global',
    });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('remove')));
    const line = argvLines(stub).find((l) => l.startsWith('remove'));
    assert.ok(line);
    assert.ok(line.startsWith('remove bundle grim-essentials'), `argv was: ${line}`);
    assert.ok(line.includes('--global'));
    assert.ok(!argvLines(stub).some((l) => l.startsWith('uninstall')), 'no uninstall was issued');
  });

  test('details uninstall of a bundle-held member notifies without a panel error', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'fetch', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      vendor: 'canonical',
      content: '---\nlicense: Apache-2.0\n---\n# Grim Usage',
      files: [{ path: 'grim-usage/SKILL.md', size: 10 }],
    });
    canned(stub, 'describe', {
      error: { code: 'usage', exit: 64, message: "unrecognized subcommand 'describe'" },
    });
    // grim keeps a bundle-provided member: exit 0 with a no-op status.
    canned(stub, 'uninstall', { kind: 'skill', name: 'grim-usage', status: 'kept-by-bundle' });
    const posted: { type: string }[] = [];
    const panel = {
      title: '',
      iconPath: undefined,
      webview: {
        postMessage: (message: { type: string }) => {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
    } as unknown as vscode.WebviewPanel;
    await api.providers.details.onMessage('ghcr.io/grimoire-rs/skills/grim-usage', panel, {
      type: 'uninstall',
      kind: 'skill',
      name: 'grim-usage',
      scope: 'project',
    });
    assert.ok(
      !posted.some((m) => m.type === 'error'),
      'no error was posted into the details panel',
    );
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered after the no-op',
    );
  });

  test('pickVersion round-trips to grim add repo:tag with the scope flag', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'describe', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      title: null,
      description: null,
      summary: null,
      version: '1.5.0',
      license: null,
      repository: null,
      revision: null,
      created: null,
      keywords: null,
      deprecated: null,
      replaced_by: null,
      tags: ['1.5.0', '1.4.2'],
      annotations: {},
    });
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const originalQuickPick = window.showQuickPick;
    window.showQuickPick = async () => '1.4.2'; // pick the downgrade tag
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'pickVersion',
        repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
      });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    } finally {
      window.showQuickPick = originalQuickPick;
    }
    const add = argvLines(stub).find((l) => l.startsWith('add'));
    assert.ok(add);
    assert.ok(
      add.includes('ghcr.io/grimoire-rs/skills/grim-usage:1.4.2'),
      `expected a tagged ref: ${add}`,
    );
    // context reports config_exists:false, so the project scope is skipped and
    // the install lands in global without a second QuickPick.
    assert.ok(add.includes('--global'), `expected global scope: ${add}`);
  });

  test('updateAll runs update in project and global scope when the project is configured', async () => {
    // A configured project (grimoire.toml present) → the command updates both scopes.
    canned(stub, 'context', contextDoc({ config_exists: true }));
    fs.rmSync(stub.argvLog, { force: true });
    await vscode.commands.executeCommand('grimoire.updateAll');
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.strictEqual(updates.length, 2);
    assert.ok(updates.some((l) => l.includes('--global')));
    assert.ok(updates.some((l) => !l.includes('--global')));
  });

  test('stale-lock update offers a full re-resolve, runs it in the same scope, no error toast', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // The per-name update fails the partial resolve; the bare full update (the
    // recovery) succeeds via the generic update.json.
    canned(stub, 'update-name', {
      error: { code: 'data', exit: 65, message: 'partial-resolve refused', reason: 'stale-lock' },
    });
    canned(stub, 'update', { items: [] });
    const window = vscode.window as unknown as {
      showWarningMessage: unknown;
      showErrorMessage: unknown;
    };
    const originalWarn = window.showWarningMessage;
    const originalError = window.showErrorMessage;
    let warned = false;
    let errored = false;
    window.showWarningMessage = async () => {
      warned = true;
      return 'Run Full Update';
    };
    window.showErrorMessage = async () => {
      errored = true;
      return undefined;
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({ type: 'update', kind: 'skill', name: 'demo', scope: 'global' });
      await waitFor(() => argvLines(stub).some((l) => /^update (--global|--format)/.test(l)));
    } finally {
      window.showWarningMessage = originalWarn;
      window.showErrorMessage = originalError;
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(updates.some((l) => l.startsWith('update demo')), `per-name update ran: ${updates.join(' | ')}`);
    const full = updates.find((l) => /^update (--global|--format)/.test(l));
    assert.ok(full, `a bare full update ran: ${updates.join(' | ')}`);
    assert.ok(full.includes('--global'), `full update stays in the same scope: ${full}`);
    assert.ok(warned, 'the stale-lock warning was shown');
    assert.ok(!errored, 'the per-name refusal produced no error toast');
  });

  test('update failure without a reason keeps the plain error toast, runs no full update', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', {
      error: { code: 'data', exit: 65, message: 'some other update failure' },
    });
    const window = vscode.window as unknown as {
      showWarningMessage: unknown;
      showErrorMessage: unknown;
    };
    const originalWarn = window.showWarningMessage;
    const originalError = window.showErrorMessage;
    let warned = false;
    let errored = false;
    window.showWarningMessage = async () => {
      warned = true;
      return undefined;
    };
    window.showErrorMessage = async () => {
      errored = true;
      return undefined;
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({ type: 'update', kind: 'skill', name: 'demo', scope: 'global' });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('update demo')));
    } finally {
      window.showWarningMessage = originalWarn;
      window.showErrorMessage = originalError;
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(updates.some((l) => l.startsWith('update demo')), 'the per-name update ran');
    assert.ok(
      !updates.some((l) => /^update (--global|--format)/.test(l)),
      `no full update ran: ${updates.join(' | ')}`,
    );
    assert.ok(errored, 'the plain error toast was shown');
    assert.ok(!warned, 'no stale-lock warning for a non-stale error');
  });

  test('details stale-lock update offers a full re-resolve without a panel error', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'fetch', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      vendor: 'canonical',
      content: '# Grim Usage',
      files: [],
    });
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'update-name', {
      error: { code: 'data', exit: 65, message: 'partial-resolve refused', reason: 'stale-lock' },
    });
    canned(stub, 'update', { items: [] });
    const window = vscode.window as unknown as {
      showWarningMessage: unknown;
      showErrorMessage: unknown;
    };
    const originalWarn = window.showWarningMessage;
    const originalError = window.showErrorMessage;
    let warned = false;
    let errored = false;
    window.showWarningMessage = async () => {
      warned = true;
      return 'Run Full Update';
    };
    window.showErrorMessage = async () => {
      errored = true;
      return undefined;
    };
    const posted: { type: string }[] = [];
    const panel = {
      title: '',
      iconPath: undefined,
      webview: {
        postMessage: (message: { type: string }) => {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
    } as unknown as vscode.WebviewPanel;
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.details.onMessage('ghcr.io/grimoire-rs/skills/grim-usage', panel, {
        type: 'update',
        kind: 'skill',
        name: 'grim-usage',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => /^update (--global|--format)/.test(l)));
    } finally {
      window.showWarningMessage = originalWarn;
      window.showErrorMessage = originalError;
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(updates.some((l) => /^update (--global|--format)/.test(l)), 'a bare full update ran');
    assert.ok(warned, 'the stale-lock warning was shown');
    assert.ok(!errored, 'no error toast for the stale-lock refusal');
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered (busy cleared) after the recovery',
    );
  });

  test('initProject invokes grim init without --global', async () => {
    fs.rmSync(stub.argvLog, { force: true });
    await vscode.commands.executeCommand('grimoire.initProject');
    const inits = argvLines(stub).filter((l) => l.startsWith('init'));
    assert.strictEqual(inits.length, 1);
    assert.ok(inits[0] && !inits[0].includes('--global'));
  });

  test('details view model build fetches and honors the describe fallback', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'fetch', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      vendor: 'canonical',
      content: '---\nlicense: Apache-2.0\n---\n# Grim Usage',
      files: [{ path: 'grim-usage/SKILL.md', size: 10 }],
    });
    canned(stub, 'describe', {
      error: { code: 'usage', exit: 64, message: "unrecognized subcommand 'describe'" },
    });
    fs.rmSync(stub.argvLog, { force: true });
    const vm = await api.providers.details.buildVM('ghcr.io/grimoire-rs/skills/grim-usage');
    assert.strictEqual(vm.name, 'grim-usage');
    assert.strictEqual(vm.kind, 'skill');
    assert.strictEqual(vm.license, 'Apache-2.0'); // frontmatter fallback, no describe
    assert.strictEqual(vm.tags, null);
    assert.match(vm.contentMarkdown ?? '', /^# Grim Usage/);
    const lines = argvLines(stub);
    assert.ok(lines.some((l) => l.startsWith('fetch ghcr.io/grimoire-rs/skills/grim-usage')));
    assert.ok(lines.some((l) => l.startsWith('describe')));
  });

  test('v2 has_description:false skips the companion entirely (no --description fetch)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/plain';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:1', kind: 'skill', name: 'plain',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    canned(stub, 'describe', describeDoc(repo, { name: 'plain', has_description: false }));
    fs.rmSync(stub.argvLog, { force: true });
    const vm = await api.providers.details.buildVM(repo);
    assert.strictEqual(vm.name, 'plain');
    const lines = argvLines(stub);
    assert.ok(!lines.some((l) => l.includes('__grimoire')), 'no legacy companion probe fired');
    assert.ok(!lines.some((l) => l.includes('--description')), 'no companion content fetch');
  });

  test('v2 has_description:true builds README/logo/changelog from one inline --description fetch', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/rich';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'rich',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    canned(stub, 'describe', describeDoc(repo, { name: 'rich', has_description: true, digest: 'sha256:art1' }));
    // One report, every member inline; README + CHANGELOG both carry image refs.
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`, digest: 'sha256:comp1', kind: 'desc',
      files: [
        { path: 'README.md', size: 40, content: '# Rich\n\n![logo](./logo.png)\n\ninline-readme-marker' },
        { path: 'logo.png', size: 4, content: 'QUJD', encoding: 'base64' },
        { path: 'CHANGELOG.md', size: 20, content: '![c](logo.png)\n\ninline-changelog-marker' },
      ],
    });
    fs.rmSync(stub.argvLog, { force: true });
    try {
      const vm = await api.providers.details.buildVM(repo);
      assert.match(vm.readmeMarkdown ?? '', /inline-readme-marker/);
      assert.match(vm.changelogMarkdown ?? '', /inline-changelog-marker/);
      assert.strictEqual(vm.logoUri, 'data:image/png;base64,QUJD');
      // Relative image refs rewritten inline to data: URIs in BOTH bodies (F4).
      assert.match(vm.readmeMarkdown ?? '', /!\[logo\]\(data:image\/png;base64,QUJD\)/);
      assert.match(vm.changelogMarkdown ?? '', /!\[c\]\(data:image\/png;base64,QUJD\)/);
      const fetches = argvLines(stub).filter((l) => l.startsWith('fetch'));
      const content = fetches.filter(
        (l) => l.includes('--description') && !l.includes('--digest-only'),
      );
      assert.strictEqual(content.length, 1, 'exactly one content --description fetch');
      assert.ok(!fetches.some((l) => l.includes('--path')), 'no companion --path follow-ups');
      assert.ok(!fetches.some((l) => l.includes('__grimoire')), 'no legacy companion ref');
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-description.json'), { force: true });
    }
  });

  test('describe without has_description fetches no companion — in-tree content only', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/older';
    // Artifact ships an in-tree README (fetched via --path); no companion exists.
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:1', kind: 'skill', name: 'older',
      vendor: 'canonical', content: '# Descriptor',
      files: [{ path: 'older/README.md', size: 20 }],
    });
    canned(stub, 'fetch-readme', {
      ref: `${repo}:latest`, digest: 'sha256:1', kind: 'skill', name: 'older',
      vendor: 'canonical', content: 'in-tree-readme-marker', files: [],
    });
    // A valid describe, but WITHOUT the has_description key (a grim predating v2).
    canned(stub, 'describe', describeDoc(repo, { name: 'older' }));
    fs.rmSync(stub.argvLog, { force: true });
    try {
      const vm = await api.providers.details.buildVM(repo);
      assert.match(vm.readmeMarkdown ?? '', /in-tree-readme-marker/, 'in-tree README is used');
      const lines = argvLines(stub);
      assert.ok(!lines.some((l) => l.includes('__grimoire')), 'no legacy companion probe');
      assert.ok(!lines.some((l) => l.includes('--description')), 'no v2 companion fetch');
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-readme.json'), { force: true });
    }
  });

  test('a second open with matching digests only digest-probes and posts once', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/warm';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'warm',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    // describe's manifest digest matches the cached fetch digest (the warm probe
    // compares live describe.digest against the cached artifact digest).
    canned(stub, 'describe', describeDoc(repo, { name: 'warm', has_description: true, digest: 'sha256:art1' }));
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`, digest: 'sha256:comp1', kind: 'desc',
      files: [{ path: 'README.md', size: 20, content: 'warm-readme-marker' }],
    });
    // Companion digest probe reports the SAME digest as the cached content → fresh.
    canned(stub, 'fetch-desc-digest', { ref: `${repo}:__grimoire`, digest: 'sha256:comp1' });
    try {
      // First open populates the cache.
      await api.providers.details.buildVM(repo);
      // Second open: paint from cache, then revalidate.
      fs.rmSync(stub.argvLog, { force: true });
      const { panel, posts, revalidates } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.strictEqual(posts.length, 1, 'single VM post (cached paint, no repost)');
      assert.match(posts[0]?.readmeMarkdown ?? '', /warm-readme-marker/);
      assert.deepStrictEqual(revalidates, ['checking', 'done'], 'indicator: checking → done');
      const lines = argvLines(stub);
      assert.ok(lines.some((l) => l.startsWith('describe')), 'a live describe probe ran');
      const fetches = lines.filter((l) => l.startsWith('fetch'));
      assert.ok(fetches.length > 0, 'the companion digest probe ran');
      assert.ok(
        fetches.every((l) => l.includes('--digest-only')),
        `only digest-only fetches on a warm reopen: ${fetches.join(' | ')}`,
      );
    } finally {
      for (const f of ['fetch-description', 'fetch-desc-digest']) {
        fs.rmSync(path.join(stub.dir, `${f}.json`), { force: true });
      }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a second open with a changed artifact digest refetches, rewrites the cache, and reposts', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/moved';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'moved',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    canned(stub, 'describe', describeDoc(repo, { name: 'moved', has_description: true, digest: 'sha256:art1' }));
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`, digest: 'sha256:comp1', kind: 'desc',
      files: [{ path: 'README.md', size: 20, content: 'old-readme-marker' }],
    });
    canned(stub, 'fetch-desc-digest', { ref: `${repo}:__grimoire`, digest: 'sha256:comp1' });
    try {
      await api.providers.details.buildVM(repo); // populate cache at art1/comp1
      // The artifact rolled forward: describe now reports the art2 manifest digest,
      // and the content fetches carry new digests + a new README.
      canned(stub, 'describe', describeDoc(repo, { name: 'moved', has_description: true, digest: 'sha256:art2' }));
      canned(stub, 'fetch', {
        ref: `${repo}:latest`, digest: 'sha256:art2', kind: 'skill', name: 'moved',
        vendor: 'canonical', content: '# Descriptor', files: [],
      });
      canned(stub, 'fetch-description', {
        ref: `${repo}:__grimoire`, digest: 'sha256:comp2', kind: 'desc',
        files: [{ path: 'README.md', size: 20, content: 'new-readme-marker' }],
      });
      const { panel, posts } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(posts.length >= 2, 'cached paint then a fresh repost');
      assert.match(posts[0]?.readmeMarkdown ?? '', /old-readme-marker/, 'first paint is cached');
      assert.match(
        posts[posts.length - 1]?.readmeMarkdown ?? '',
        /new-readme-marker/,
        'repost carries the refetched content',
      );
      // A full content fetch ran (not just digest probes).
      assert.ok(
        argvLines(stub).some((l) => l.includes('--description') && !l.includes('--digest-only')),
        'the changed companion was re-fetched',
      );
      // The cache file was rewritten with the new artifact digest.
      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      assert.strictEqual(files.length, 1);
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0] as string), 'utf8'));
      assert.strictEqual(entry.artifactDigest, 'sha256:art2');
      assert.match(entry.readme, /new-readme-marker/);
    } finally {
      for (const f of ['fetch-description', 'fetch-desc-digest']) {
        fs.rmSync(path.join(stub.dir, `${f}.json`), { force: true });
      }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a companion published after caching is discovered on reopen (artifact unchanged)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/flip';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'flip',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    // First: no companion.
    canned(stub, 'describe', describeDoc(repo, { name: 'flip', has_description: false, digest: 'sha256:art1' }));
    try {
      await api.providers.details.buildVM(repo);
      // Companion published later; the artifact manifest is untouched (art1).
      canned(stub, 'describe', describeDoc(repo, { name: 'flip', has_description: true, digest: 'sha256:art1' }));
      canned(stub, 'fetch-description', {
        ref: `${repo}:__grimoire`, digest: 'sha256:comp1', kind: 'desc',
        files: [{ path: 'README.md', size: 20, content: 'freshly-published-readme' }],
      });
      canned(stub, 'fetch-desc-digest', { ref: `${repo}:__grimoire`, digest: 'sha256:comp1' });
      const { panel, posts } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(posts.length >= 2, 'the new companion triggers a repost');
      assert.match(
        posts[posts.length - 1]?.readmeMarkdown ?? '',
        /freshly-published-readme/,
        'the companion published after caching is discovered',
      );
      assert.ok(
        argvLines(stub).some((l) => l.includes('--description') && !l.includes('--digest-only')),
        'the companion content was fetched',
      );
    } finally {
      for (const f of ['fetch-description', 'fetch-desc-digest']) {
        fs.rmSync(path.join(stub.dir, `${f}.json`), { force: true });
      }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a new tag with unchanged content reposts metadata only, no content fetch', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/tagged';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'tagged',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    canned(stub, 'describe', describeDoc(repo, {
      name: 'tagged', has_description: false, digest: 'sha256:art1', tags: ['1.0.0', 'latest'],
    }));
    try {
      await api.providers.details.buildVM(repo);
      // Same manifest digest, but a new tag appeared in describe.
      canned(stub, 'describe', describeDoc(repo, {
        name: 'tagged', has_description: false, digest: 'sha256:art1', tags: ['1.0.0', '1.1.0', 'latest'],
      }));
      fs.rmSync(stub.argvLog, { force: true });
      const { panel, posts, revalidates } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.strictEqual(posts.length, 2, 'cached paint + one metadata-only repost');
      assert.deepStrictEqual(revalidates, ['checking', 'done'], 'metadata-only settles to done');
      assert.ok(posts[1]?.tags?.includes('1.1.0'), 'the new tag reached the reposted VM');
      // No content fetch at all — describe carried the change.
      assert.ok(
        !argvLines(stub).some((l) => l.startsWith('fetch')),
        'metadata-only refresh does not fetch content',
      );
      // The cache file's describe was refreshed with the new tag.
      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0] as string), 'utf8'));
      assert.ok(entry.describe.tags.includes('1.1.0'), 'cache describe refreshed');
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a v2 companion README member with no content does not crash (omit-empty)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/emptyreadme';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'emptyreadme',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    canned(stub, 'describe', describeDoc(repo, { name: 'emptyreadme', has_description: true, digest: 'sha256:art1' }));
    // README member ships NO content (omit-empty) — must not TypeError.
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`, digest: 'sha256:comp1', kind: 'desc',
      files: [{ path: 'README.md', size: 0 }],
    });
    try {
      const vm = await api.providers.details.buildVM(repo);
      assert.strictEqual(vm.readmeMarkdown, null, 'empty companion README falls back to null');
      assert.strictEqual(vm.error, null, 'no crash surfaced');
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-description.json'), { force: true });
    }
  });

  test('a revalidation failure with a cached paint posts the failed indicator, no error banner', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/broken';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'broken',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    canned(stub, 'describe', describeDoc(repo, { name: 'broken', has_description: true, digest: 'sha256:art1' }));
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`, digest: 'sha256:comp1', kind: 'desc',
      files: [{ path: 'README.md', size: 20, content: 'cached-readme-marker' }],
    });
    try {
      await api.providers.details.buildVM(repo); // populate cache
      // Second open: describe reports a changed digest (forces the full pipeline),
      // but the content fetch now fails → entry null → keep-cached + failed.
      canned(stub, 'describe', describeDoc(repo, { name: 'broken', has_description: true, digest: 'sha256:art2' }));
      canned(stub, 'fetch', { error: { code: 'not-found', exit: 79, message: 'gone' } });
      const { panel, posts, revalidates, revalidateMessages } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.deepStrictEqual(revalidates, ['checking', 'failed'], 'indicator: checking → failed');
      assert.strictEqual(posts.length, 1, 'cached paint kept, no repost');
      assert.match(posts[0]?.readmeMarkdown ?? '', /cached-readme-marker/);
      assert.strictEqual(posts[0]?.error ?? null, null, 'no error banner over the cached view');
      // The failed indicator carries the concrete envelope message from the stub.
      assert.strictEqual(revalidateMessages[1], 'gone', 'failed message is the fetch error');
      // Clicking the failed indicator shows a warning with the stored message.
      const original = vscode.window.showWarningMessage;
      const shown: string[] = [];
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (
        m: string,
      ): Thenable<string | undefined> => {
        shown.push(m);
        return Promise.resolve(undefined);
      };
      try {
        await api.providers.details.onMessage(repo, panel, { type: 'revalidateError' });
        assert.deepStrictEqual(shown, ['gone'], 'the stored failure message is surfaced');
      } finally {
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
      }
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-description.json'), { force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a browse search prefetches the top uncached items into the details cache', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const a = 'ghcr.io/grimoire-rs/skills/pf-a';
    const b = 'ghcr.io/grimoire-rs/skills/pf-b';
    canned(stub, 'search', { items: [searchItem(a), searchItem(b)] });
    canned(stub, 'describe', describeDoc(a, { has_description: false }));
    canned(stub, 'fetch', {
      ref: 'x:latest', digest: 'sha256:1', kind: 'skill', name: 'x',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.refresh();
      await waitFor(() => {
        const lines = argvLines(stub);
        return [a, b].every((r) => lines.some((l) => l.startsWith(`fetch ${r}`)));
      });
      const lines = argvLines(stub);
      assert.ok(
        [a, b].every((r) => lines.some((l) => l.startsWith(`describe ${r}`))),
        'prefetch described both top items',
      );
    } finally {
      canned(stub, 'search', { items: [] });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('with grimoire.prefetchDetails=false there are no prefetch calls', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const a = 'ghcr.io/grimoire-rs/skills/pf-off';
    canned(stub, 'search', { items: [searchItem(a)] });
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('prefetchDetails', false, vscode.ConfigurationTarget.Global);
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.refresh();
      await new Promise((r) => setTimeout(r, 300)); // give any prefetch a chance to fire
      const lines = argvLines(stub);
      assert.ok(
        !lines.some((l) => l.startsWith('fetch ') || l.startsWith('describe ')),
        `no per-repo prefetch when disabled: ${lines.join(' | ')}`,
      );
    } finally {
      await vscode.workspace
        .getConfiguration('grimoire')
        .update('prefetchDetails', undefined, vscode.ConfigurationTarget.Global);
      canned(stub, 'search', { items: [] });
    }
  });

  test('a prefetched repo opens from the cache with no content fetch', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/pf-open';
    canned(stub, 'search', { items: [searchItem(repo)] });
    canned(stub, 'describe', describeDoc(repo, { name: 'pf-open', has_description: false, digest: 'sha256:art1' }));
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'pf-open',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.refresh(); // triggers the prefetch
      await waitFor(() => fs.readdirSync(cacheDir).some((f) => f.endsWith('.json')));
      // Open the prefetched repo: paint from cache, revalidate via describe only.
      fs.rmSync(stub.argvLog, { force: true });
      const { panel, revalidates } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      const lines = argvLines(stub);
      assert.ok(lines.some((l) => l.startsWith(`describe ${repo}`)), 'revalidate described');
      assert.ok(
        !lines.some((l) => l.startsWith(`fetch ${repo}`)),
        `no content fetch on a cached open: ${lines.join(' | ')}`,
      );
      assert.deepStrictEqual(revalidates, ['checking', 'done'], 'cached paint → checking/done');
    } finally {
      canned(stub, 'search', { items: [] });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a warm open paints from cache before any context/status spawn (zero-spawn paint)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/instant';
    canned(stub, 'describe', describeDoc(repo, { name: 'instant', has_description: false, digest: 'sha256:art1' }));
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'instant',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    try {
      await api.providers.details.buildVM(repo); // populate the cache + a last-known snapshot
      fs.rmSync(stub.argvLog, { force: true });
      const posts: DetailsVM[] = [];
      const argvAt: number[] = [];
      const panel = {
        title: '',
        iconPath: undefined,
        webview: {
          postMessage: (m: HostToDetails) => {
            if (m.type === 'artifact') {
              posts.push(m.vm);
              argvAt.push(argvLines(stub).length); // grim spawns recorded at post time
            }
            return Promise.resolve(true);
          },
        },
      } as unknown as vscode.WebviewPanel;
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(posts.length >= 1, 'painted');
      assert.strictEqual(argvAt[0], 0, 'the first paint preceded any context/status spawn');
    } finally {
      canned(stub, 'search', { items: [] });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a warm open reposts when the fresh snapshot changes the install rows', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/rows';
    canned(stub, 'context', contextDoc({ config_exists: false }));
    canned(stub, 'describe', describeDoc(repo, { name: 'rows', has_description: false, digest: 'sha256:art1' }));
    canned(stub, 'fetch', {
      ref: `${repo}:latest`, digest: 'sha256:art1', kind: 'skill', name: 'rows',
      vendor: 'canonical', content: '# Descriptor', files: [],
    });
    try {
      await api.providers.details.buildVM(repo); // stale snapshot: project not configured
      // Between sessions the project becomes configured → install rows differ.
      canned(stub, 'context', contextDoc({ config_exists: true }));
      const { panel, posts } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(posts.length >= 2, 'instant stale paint + a fresh install repost');
      assert.strictEqual(posts[0]?.scopes.projectConfigured, false, 'first paint used the stale snapshot');
      assert.strictEqual(
        posts[posts.length - 1]?.scopes.projectConfigured,
        true,
        'reposted with the fresh install state',
      );
    } finally {
      canned(stub, 'context', contextDoc());
      canned(stub, 'search', { items: [] });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('logExecutable records the resolved grim path', () => {
    const lines: string[] = [];
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput(lines));
    scopes.logExecutable();
    assert.ok(
      lines.includes(`grim executable: ${stub.executable}`),
      `expected the resolved path, got: ${lines.join(' | ')}`,
    );
  });

  test('a stale/exit-64 run names the spawned executable in the log', async function () {
    const lines: string[] = [];
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput(lines));
    const result = await scopes.run(['badcmd'], 'global'); // stub → exit-64 usage error
    assert.ok(!result.ok);
    assert.ok(
      lines.some((l) => l.includes(stub.executable) && (l.includes('64') || l.includes('stale'))),
      `expected an exe-naming diagnostic, got: ${lines.join(' | ')}`,
    );
  });

  test('openDetails opens an editor tab for the artifact', async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand(
      'grimoire.openDetails',
      'ghcr.io/grimoire-rs/skills/grim-usage',
    );
    // The panel opens as "grim-usage" and is retitled "Skill: grim-usage"
    // once the view model arrives (design 1c tab label).
    await waitFor(() =>
      vscode.window.tabGroups.all.some((g) =>
        g.tabs.some((t) => t.label === 'grim-usage' || t.label === 'Skill: grim-usage'),
      ),
    );
  });

  test('openDetails ignores non-string arguments', async () => {
    await vscode.commands.executeCommand('grimoire.openDetails', 42);
    await vscode.commands.executeCommand('grimoire.openDetails', undefined);
  });

  test('single-click preview reuses one slot; double-click promotes it', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    const a = 'ghcr.io/grimoire-rs/skills/preview-a';
    const b = 'ghcr.io/grimoire-rs/skills/preview-b';
    // Fail describe/fetch so each panel falls back to its repo-derived name — the
    // tab labels ('preview-a' / 'preview-b') are then distinct and stable.
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    await api.providers.sidebar.handleMessage({ type: 'openDetails', repo: a, mode: 'preview' });
    assert.strictEqual(details.previewRepo, a);
    assert.ok(!details.openRepos.includes(a), 'preview does not create a permanent tab');
    // The preview tab carries the "(Preview)" title marker (item 3 — VS Code
    // has no preview API for webview panels).
    await waitFor(() => labels().includes('preview-a (Preview)'));
    // A single click on another card retargets the one reusable preview tab.
    await api.providers.sidebar.handleMessage({ type: 'openDetails', repo: b, mode: 'preview' });
    assert.strictEqual(details.previewRepo, b);
    assert.ok(!details.openRepos.includes(a), 'the preview tab was reused, not duplicated');
    await waitFor(() => labels().includes('preview-b (Preview)'));
    // Double-click promotes the current preview into a permanent tab.
    await api.providers.sidebar.handleMessage({ type: 'openDetails', repo: b, mode: 'permanent' });
    assert.strictEqual(details.previewRepo, null);
    assert.ok(details.openRepos.includes(b), 'the promoted panel is now permanent');
    // Promotion strips the marker: plain title.
    await waitFor(
      () => labels().includes('preview-b') && !labels().includes('preview-b (Preview)'),
    );
  });

  test('preview retarget navigates in place without rebooting the webview (perf)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const a = 'ghcr.io/grimoire-rs/skills/reboot-a';
    const b = 'ghcr.io/grimoire-rs/skills/reboot-b';
    const c = 'ghcr.io/grimoire-rs/skills/reboot-c';
    details.openPreview(a);
    const panel = details.previewPanel;
    assert.ok(panel, 'preview slot has a panel');
    // attach inlines the full skeleton into the initial document — no empty shell.
    const initialHtml = panel.webview.html;
    assert.ok(initialHtml.includes('Content-Security-Policy'), 'shell + CSP present');
    assert.ok(initialHtml.includes('rail-skeleton-line'), 'skeleton inlined server-side');
    assert.ok(initialHtml.includes('reboot-a'), 'the opened repo is inlined');
    // Retarget across two navigations: the SAME panel is reused and webview.html
    // is never reassigned (reassigning it reboots the whole webview).
    details.openPreview(b);
    assert.strictEqual(details.previewPanel, panel, 'same panel reused (b)');
    assert.strictEqual(details.previewRepo, b, 'retargeted to b');
    assert.strictEqual(panel.webview.html, initialHtml, 'html not reassigned on retarget to b');
    details.openPreview(c);
    assert.strictEqual(details.previewPanel, panel, 'same panel reused (c)');
    assert.strictEqual(panel.webview.html, initialHtml, 'html not reassigned on retarget to c');
  });

  test('same-repo preview re-click is a reveal-only no-op (double-click second click)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const repo = 'ghcr.io/grimoire-rs/skills/reclick-a';
    details.openPreview(repo);
    const panel = details.previewPanel;
    assert.ok(panel, 'preview slot has a panel');
    // The retarget path rewrites panel.title; the same-repo guard must not touch
    // the panel at all beyond reveal — a sentinel title survives the re-click.
    panel.title = 'SENTINEL';
    details.openPreview(repo);
    assert.strictEqual(details.previewPanel, panel, 'same panel');
    assert.strictEqual(details.previewRepo, repo, 'same repo');
    assert.strictEqual(panel.title, 'SENTINEL', 'no retarget/repaint ran');
  });

  test('promote message moves the preview tab to permanent, dropping the marker (item 2)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const repo = 'ghcr.io/grimoire-rs/skills/promote-me';
    details.openPreview(repo);
    const panel = details.previewPanel;
    assert.ok(panel, 'preview slot has a panel');
    assert.strictEqual(details.previewRepo, repo);
    // The pin click / body double-click both post { type: 'promote' }.
    await details.onMessage(repo, panel, { type: 'promote' });
    assert.strictEqual(details.previewRepo, null, 'left the preview slot');
    assert.ok(details.openRepos.includes(repo), 'now a permanent tab');
    assert.ok(!panel.title.includes('(Preview)'), 'the (Preview) marker is dropped');
  });

  test('details→details click reveals an already-open panel, no spawn (item 2a)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const a = 'ghcr.io/grimoire-rs/skills/route-open-a';
    const b = 'ghcr.io/grimoire-rs/skills/route-open-b';
    details.open(a); // permanent
    details.openPreview(b); // preview slot
    const permBefore = details.openRepos.length;
    // A click inside B's view targeting the already-open (permanent) A.
    await details.onMessage(b, fakePanel().panel, { type: 'openDetails', repo: a });
    assert.strictEqual(details.openRepos.length, permBefore, 'no new tab spawned');
    assert.ok(details.openRepos.includes(a), 'the existing permanent tab was revealed');
    assert.strictEqual(details.previewRepo, b, 'preview slot untouched');
  });

  test('details→details click from the preview slot navigates it in place (item 2b)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const b = 'ghcr.io/grimoire-rs/skills/route-nav-b';
    const c = 'ghcr.io/grimoire-rs/skills/route-nav-c';
    details.openPreview(b); // the one preview slot shows b
    const permBefore = details.openRepos.length;
    await details.onMessage(b, fakePanel().panel, { type: 'openDetails', repo: c });
    // The singleton preview slot navigated b → c in place — no new panel.
    assert.strictEqual(details.previewRepo, c, 'preview slot retargeted to the click target');
    assert.strictEqual(details.openRepos.length, permBefore, 'no permanent tab created');
    const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    await waitFor(() => labels().includes('route-nav-c (Preview)'));
  });

  test('details→details click from a permanent tab opens the target in the preview slot (item 2c)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const a = 'ghcr.io/grimoire-rs/skills/route-perm-a';
    const c = 'ghcr.io/grimoire-rs/skills/route-perm-c';
    details.open(a); // permanent
    const permBefore = details.openRepos.length;
    await details.onMessage(a, fakePanel().panel, { type: 'openDetails', repo: c });
    assert.strictEqual(details.previewRepo, c, 'target opened in the preview slot');
    assert.ok(details.openRepos.includes(a), 'the originating permanent tab stays put');
    assert.strictEqual(details.openRepos.length, permBefore, 'no new permanent tab');
  });

  test('retargeting the preview mid-buildVM discards the stale VM (stale-VM race)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const details = api.providers.details;
    const a = 'ghcr.io/grimoire-rs/skills/race-slow-a';
    const b = 'ghcr.io/grimoire-rs/skills/race-fast-b';
    // Both VMs fall back to the repo-derived name (no describe/fetch), so the tab
    // title is 'race-slow-a' / 'race-fast-b' — distinguishable per artifact.
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    canned(stub, 'fetch', { error: { code: 'usage', exit: 64, message: 'no fetch' } });
    const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    // Single-click A: the fetch stub sleeps, parking buildVM(a) in flight.
    details.openPreview(a);
    await waitFor(() => argvLines(stub).some((l) => l.startsWith(`fetch ${a}`)));
    // Single-click B before A resolves: the one reusable slot retargets to B.
    details.openPreview(b);
    assert.strictEqual(details.previewRepo, b);
    // Preview tabs carry the "(Preview)" marker (item 3).
    await waitFor(() => labels().includes('race-fast-b (Preview)'));
    // Let A's slow buildVM (1s sleep) land; the repo guard must discard it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(labels().includes('race-fast-b (Preview)'), 'the panel still shows B');
    assert.ok(
      !labels().includes('race-slow-a (Preview)'),
      "A's stale VM was discarded, not posted into B",
    );
  });

  test('refreshOpenPanels refreshes the open preview slot, not just permanent tabs', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const previewRepo = 'ghcr.io/grimoire-rs/skills/refresh-preview';
    api.providers.details.openPreview(previewRepo);
    assert.strictEqual(api.providers.details.previewRepo, previewRepo);
    // Let the open's initial buildVM settle so a later fetch can only be a refresh.
    await waitFor(() => argvLines(stub).some((l) => l.startsWith(`fetch ${previewRepo}`)));
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.details.refreshOpenPanels();
    assert.ok(
      argvLines(stub).some((l) => l.startsWith(`fetch ${previewRepo}`)),
      'the preview slot was refreshed',
    );
  });

  test('details tab title is set from the catalog at creation, before the VM lands', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const repo = 'ghcr.io/grimoire-rs/skills/race-slow-title';
    canned(stub, 'search', {
      items: [
        {
          kind: 'skill',
          repo,
          summary: null,
          description: 'x',
          version: '1.0.0',
          latest_tag: null,
          repository: null,
          revision: null,
          created: null,
          deprecated: null,
          status: 'not-installed',
        },
      ],
    });
    // Populate the catalog so titleFor can resolve the kind at creation time.
    await api.providers.sidebar.refresh();
    // The *race-slow* fetch sleeps 1s, so postVM cannot retitle within the window.
    api.providers.details.open(repo);
    const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    await waitFor(() => labels().includes('Skill: race-slow-title'), 700);
    // Reset the catalog to empty so later tests are unaffected.
    canned(stub, 'search', { items: [] });
    await api.providers.sidebar.refresh();
  });

  test('details pickVersion with a preselected scope skips the scope QuickPick', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'describe', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      title: null,
      description: null,
      summary: null,
      version: '1.5.0',
      license: null,
      repository: null,
      revision: null,
      created: null,
      keywords: null,
      deprecated: null,
      replaced_by: null,
      tags: ['1.5.0', '1.4.2'],
      annotations: {},
    });
    let quickPicks = 0;
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const originalQuickPick = window.showQuickPick;
    window.showQuickPick = async () => {
      quickPicks++;
      return '1.4.2';
    };
    const panel = {
      title: '',
      iconPath: undefined,
      webview: { postMessage: () => Promise.resolve(true) },
    } as unknown as vscode.WebviewPanel;
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.details.onMessage('ghcr.io/grimoire-rs/skills/grim-usage', panel, {
        type: 'pickVersion',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    } finally {
      window.showQuickPick = originalQuickPick;
    }
    assert.strictEqual(quickPicks, 1, 'only the tag QuickPick ran — the scope was preselected');
    const add = argvLines(stub).find((l) => l.startsWith('add'));
    assert.ok(add?.includes('grim-usage:1.4.2'), `pins the picked tag: ${add}`);
    assert.ok(add?.includes('--global'), `installs into the preselected scope: ${add}`);
  });

  test('details pickVersion into an unconfigured project runs init before add', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'describe', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      title: null,
      description: null,
      summary: null,
      version: '1.5.0',
      license: null,
      repository: null,
      revision: null,
      created: null,
      keywords: null,
      deprecated: null,
      replaced_by: null,
      tags: ['1.5.0', '1.4.2'],
      annotations: {},
    });
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const originalQuickPick = window.showQuickPick;
    window.showQuickPick = async () => '1.4.2';
    const panel = {
      title: '',
      iconPath: undefined,
      webview: { postMessage: () => Promise.resolve(true) },
    } as unknown as vscode.WebviewPanel;
    fs.rmSync(stub.argvLog, { force: true });
    try {
      // The stub context reports config_exists:false, so the preselected
      // project scope must create grimoire.toml before pinning the tag.
      await api.providers.details.onMessage('ghcr.io/grimoire-rs/skills/grim-usage', panel, {
        type: 'pickVersion',
        scope: 'project',
      });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    } finally {
      window.showQuickPick = originalQuickPick;
    }
    const lines = argvLines(stub);
    const initIndex = lines.findIndex((l) => l.startsWith('init'));
    const addIndex = lines.findIndex((l) => l.startsWith('add'));
    assert.ok(initIndex >= 0, `init ran: ${lines.join(' | ')}`);
    assert.ok(addIndex > initIndex, 'add ran after init');
    assert.ok(lines[initIndex] && !lines[initIndex].includes('--global'), 'init is project-scoped');
    assert.ok(lines[addIndex]?.includes('grim-usage:1.4.2'), `pins the picked tag: ${lines[addIndex]}`);
    assert.ok(lines[addIndex] && !lines[addIndex].includes('--global'), 'add is project-scoped');
  });

  test('details install into an unconfigured project runs init then add (item 1)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // context reports config_exists:false, so `grim add` would error before any
    // network — the host must `grim init` first.
    canned(stub, 'init', { path: '/tmp/grimoire.toml', scope: 'project', status: 'created' });
    canned(stub, 'add', {
      kind: 'skill',
      name: 'grim-usage',
      pinned: 'x@sha256:1',
      status: 'added',
    });
    canned(stub, 'fetch', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      vendor: 'canonical',
      content: '# Grim Usage',
      files: [],
    });
    canned(stub, 'describe', {
      error: { code: 'usage', exit: 64, message: 'no describe' },
    });
    const panel = {
      title: '',
      iconPath: undefined,
      webview: { postMessage: () => Promise.resolve(true) },
    } as unknown as vscode.WebviewPanel;
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.details.onMessage('ghcr.io/grimoire-rs/skills/grim-usage', panel, {
      type: 'install',
      scope: 'project',
    });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    const lines = argvLines(stub);
    const initIdx = lines.findIndex((l) => l.startsWith('init'));
    const addIdx = lines.findIndex((l) => l.startsWith('add'));
    assert.ok(initIdx >= 0, 'grim init ran');
    assert.ok(addIdx > initIdx, `grim add ran after init: ${lines.join(' | ')}`);
    assert.ok(!lines[addIdx]?.includes('--global'), 'installs into the project scope');
    assert.ok(!lines[initIdx]?.includes('--global'), 'init targets the project scope');
  });

  test('sidebar install into an unconfigured project runs init then add (item 2)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // context reports config_exists:false, so the sidebar host must `grim init`
    // before `grim add` (which would otherwise error with exit 79) — mirrors
    // the details host.
    canned(stub, 'init', { path: '/tmp/grimoire.toml', scope: 'project', status: 'created' });
    canned(stub, 'add', {
      kind: 'skill',
      name: 'grim-usage',
      pinned: 'x@sha256:1',
      status: 'added',
    });
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.handleMessage({
      type: 'install',
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage',
      scope: 'project',
    });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    const lines = argvLines(stub);
    const initIdx = lines.findIndex((l) => l.startsWith('init'));
    const addIdx = lines.findIndex((l) => l.startsWith('add'));
    assert.ok(initIdx >= 0, `grim init ran: ${lines.join(' | ')}`);
    assert.ok(addIdx > initIdx, `grim add ran after init: ${lines.join(' | ')}`);
    assert.ok(!lines[initIdx]?.includes('--global'), 'init targets the project scope');
    assert.ok(!lines[addIdx]?.includes('--global'), 'add targets the project scope');
  });

  test('grimoire.updateAll command skips project scope when there is no grimoire.toml', async function () {
    this.timeout(15000);
    await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    // updateAll is a native view/title command now; the host drops project when
    // it has no grimoire.toml (context config_exists:false).
    await vscode.commands.executeCommand('grimoire.updateAll');
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('update')));
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.strictEqual(updates.length, 1, `only one update ran: ${updates.join(' | ')}`);
    assert.ok(updates[0]?.includes('--global'), 'the sole update is global');
  });

  test('pickVersion strips an existing tag before pinning (no double tag)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'describe', {
      ref: 'ghcr.io/grimoire-rs/skills/grim-usage:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'grim-usage',
      title: null,
      description: null,
      summary: null,
      version: '1.5.0',
      license: null,
      repository: null,
      revision: null,
      created: null,
      keywords: null,
      deprecated: null,
      replaced_by: null,
      tags: ['1.5.0', '1.4.2'],
      annotations: {},
    });
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const originalQuickPick = window.showQuickPick;
    window.showQuickPick = async () => '1.4.2';
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'pickVersion',
        repo: 'ghcr.io/grimoire-rs/skills/grim-usage:1.5.0', // arrives already tagged
      });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    } finally {
      window.showQuickPick = originalQuickPick;
    }
    const add = argvLines(stub).find((l) => l.startsWith('add'));
    assert.ok(add);
    assert.ok(add.includes('grim-usage:1.4.2'), `pins the picked tag: ${add}`);
    assert.ok(!add.includes('1.5.0:1.4.2'), `no double tag: ${add}`);
    assert.ok(!add.includes('grim-usage:1.5.0'), `original tag stripped: ${add}`);
  });

  test('deep link focuses Browse and opens a permanent details panel', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const repo = 'ghcr.io/grimoire-rs/skills/grim-usage';
    await api.handleUri(
      vscode.Uri.parse(`vscode://grimoire-rs.grimoire-vscode/open?repo=${encodeURIComponent(repo)}`),
    );
    assert.ok(api.providers.details.openRepos.includes(repo));
  });

  test('deep link ignores malformed repos and non-/open paths', async () => {
    const api = await activateExtension();
    const before = api.providers.details.openRepos.length;
    await api.handleUri(vscode.Uri.parse('vscode://grimoire-rs.grimoire-vscode/open?repo=junk'));
    await api.handleUri(
      vscode.Uri.parse('vscode://grimoire-rs.grimoire-vscode/elsewhere?repo=ghcr.io/a/b/c'),
    );
    assert.strictEqual(api.providers.details.openRepos.length, before);
  });

  test('details rail tag click seeds the Browse search with the tag (item 2)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const panel = {
      title: '',
      iconPath: undefined,
      webview: { postMessage: () => Promise.resolve(true) },
    } as unknown as vscode.WebviewPanel;
    fs.rmSync(stub.argvLog, { force: true });
    // Reuses the deep-link path: focus Browse + seed its query. The seeded query
    // reaches grim search as a plain argv term (no shell), so it shows up here.
    await api.providers.details.onMessage('ghcr.io/grimoire-rs/skills/grim-usage', panel, {
      type: 'searchTag',
      tag: 'oci-cli-tag',
    });
    await waitFor(() =>
      argvLines(stub).some((l) => l.startsWith('search') && l.includes('oci-cli-tag')),
    );
    const search = argvLines(stub).find(
      (l) => l.startsWith('search') && l.includes('oci-cli-tag'),
    );
    assert.ok(search, 'Browse searched for the clicked tag');
  });
});

suite('parseDeclaredRefs', () => {
  test('reads artifact tables only', () => {
    const toml = `
[[registries]]
index = "https://index.grimoire.rs"
default = true

[skills]
grim-usage = "ghcr.io/grimoire-rs/skills/grim-usage:1.4.2"
# comment = "ignored"

[rules]

[mcp]
grim = "ghcr.io/grimoire-rs/mcp/grim:latest"

[options]
clients = "claude"
`;
    const declared = parseDeclaredRefs(toml);
    assert.deepStrictEqual(declared, {
      'grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2',
      grim: 'ghcr.io/grimoire-rs/mcp/grim:latest',
    });
  });

  test('empty and garbage input', () => {
    assert.deepStrictEqual(parseDeclaredRefs(''), {});
    assert.deepStrictEqual(parseDeclaredRefs('not toml at all'), {});
  });
});

suite('withGlobalFlag', () => {
  test('prepends the top-level --global before the subcommand', () => {
    assert.deepStrictEqual(withGlobalFlag(['status']), ['--global', 'status']);
    assert.deepStrictEqual(withGlobalFlag(['context']), ['--global', 'context']);
  });

  test('stays before the subcommand for a search with a query', () => {
    // Regression: a trailing --global lands after searchArgs's `--` positional
    // separator, where clap rejects it ("unexpected argument '--global'").
    // As a leading top-level flag it can never collide with `--`.
    assert.deepStrictEqual(withGlobalFlag(['search', '--show-deprecated', '--', 'grim usage']), [
      '--global',
      'search',
      '--show-deprecated',
      '--',
      'grim usage',
    ]);
  });
});

suite('workspace fixture', () => {
  test('fixture workspace has grimoire.toml (project scope available)', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'test workspace folder missing');
    assert.ok(fs.existsSync(path.join(folder.uri.fsPath, 'grimoire.toml')));
  });
});
