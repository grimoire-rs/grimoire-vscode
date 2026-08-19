import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isProjectNotDiscovered,
  whichGrim,
  parseDeclaredRefs,
  projectSearchable,
  ScopeService,
  withGlobalFlag,
} from '../scopes';
import type { Snapshot } from '../scopes';
import { artifactName } from '../webview/model';
import type {
  DetailsVM,
  HostToDetails,
  HostToSidebar,
  RevalidateState,
  SidebarState,
} from '../webview/protocol';
import { type GrimoireApi } from '../extension';
import { offerInstallRefusal, offerModifiedRefusal } from '../views/updateRefusal';
import {
  addArgs,
  installArgs,
  initArgs,
  refusedNames,
  updateArgs,
  type ContextInfo,
  type DescribeResult,
  type GrimResult,
  type ItemsEnvelope,
  type Scope,
  type UpdateEntry,
} from '../grim';
import { DEFAULT_EXECUTABLE } from '../config';
import { MINIMUM_GRIM_VERSION, REGISTRY_EDIT_GRIM_VERSION } from '../installer';
import { offerForcedRetry, offerRefusedRetry } from '../views/forceRetry';
import { CACHE_VERSION, DetailsCache, type DetailsCacheEntry } from '../detailsCache';

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
    *--path*logo*)
      [ -f "${dir}/fetch-logo.json" ] && { cat "${dir}/fetch-logo.json"; exit 0; } ;;
  esac
fi
# A --force retry (e.g. after a confirmed force-confirm dialog) can be canned
# apart from the original refusal via <cmd>-force.json — checked before any
# other per-argv special-case below so a forced retry never re-triggers them.
# Inert unless <cmd>-force.json exists.
case "$*" in
  *--force*)
    if [ -f "${dir}/$cmd-force.json" ]; then
      cat "${dir}/$cmd-force.json"
      exit 0
    fi
    ;;
esac
# A per-name update can be canned apart from the bare full update, so stale-lock
# recovery tests fail the partial resolve while the recovery full-resolve
# succeeds via update.json. The names ride behind a "--" separator (updateArgs
# emits one only when it has names), so its presence IS the discriminator.
# Inert unless update-name.json exists.
if [ "$cmd" = "update" ] && [ -f "${dir}/update-name.json" ]; then
  case "$*" in
    *" -- "*) cat "${dir}/update-name.json"; exit 0 ;;
  esac
fi
if [ -f "${dir}/$cmd.json" ]; then
  cat "${dir}/$cmd.json"
  # Optional exit-code companion (see cannedExit). Absent ⇒ exit 0, which is
  # what every fixture predating it relies on: real grim pairs a report with a
  # nonzero code (a refused update exits 65 while still printing its items),
  # and without this the suite could only ever assert the JSON body.
  if [ -f "${dir}/$cmd.exit" ]; then
    exit "$(cat "${dir}/$cmd.exit")"
  fi
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

/** Makes the canned response for `command` exit with `code` instead of 0.
 *  Returns the undo, because the file outlives the test exactly like a canned
 *  JSON body does. Only meaningful alongside `canned` — the stub reads it after
 *  printing `<command>.json`. */
function cannedExit(stub: Stub, command: string, code: number): () => void {
  const file = path.join(stub.dir, `${command}.exit`);
  fs.writeFileSync(file, String(code));
  return () => fs.rmSync(file, { force: true });
}

/** Drops a canned response so the command falls back to the stub script's own
 *  behavior. Needed by any test that cans an ERROR for a command the suite does
 *  not can in suiteSetup (describe, fetch): the file outlives the test, and the
 *  next test to exercise that path silently gets the failure instead. */
function uncan(stub: Stub, ...commands: string[]): void {
  for (const command of commands) {
    fs.rmSync(path.join(stub.dir, `${command}.json`), { force: true });
  }
}

/** True when an argv line is a per-name `grim update` for `name`. The name is a
 *  POSITIONAL, so updateArgs puts it behind a `--` separator (argument
 *  injection: an artifact named `--force` must not reach clap as a flag) —
 *  which is also what tells a per-name update apart from a bare one. */
function updatesArtifact(line: string, name: string): boolean {
  return line.startsWith('update ') && line.includes(`-- ${name}`);
}

/** True when an argv line invokes `cmd` on `ref`. The reference is a
 *  POSITIONAL, so the builders put it behind a `--` separator — matching on
 *  `<cmd> <ref>` adjacency stopped being possible when that landed. */
function invokes(line: string, cmd: string, ref: string): boolean {
  return line.startsWith(`${cmd} `) && line.includes(`-- ${ref}`);
}

/** True when an argv line is a BARE `grim update` (every artifact). It names no
 *  positional, so updateArgs emits no separator — that absence is the tell. */
function isFullUpdate(line: string): boolean {
  return line.startsWith('update') && !line.includes(' -- ');
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
    // At or above MINIMUM_GRIM_VERSION — a fixture below the floor makes every
    // snapshot fail the version gate (see the "grim version floor" suite, which
    // pins an old version deliberately).
    version: MINIMUM_GRIM_VERSION,
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
      {
        alias: null,
        url: 'https://index.grimoire.rs',
        kind: 'index',
        default: true,
        authenticated: true,
      },
    ],
    default_registry: 'ghcr.io/grimoire-rs',
    ...overrides,
  };
}

/** A full describe report. `has_description` is added only via overrides — absent
 *  by default (a grim predating the v2 surface → no companion). */
function describeDoc(
  repo: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

/** 1x1 PNG — the bytes never matter, only that a logo data: URI gets built. */
const LOGO_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Cans a repo that ships an in-tree logo.png: describe, the descriptor fetch
 *  (whose files[] advertises it) and the `--path logo.png` fetch. */
function cannedWithLogo(stub: Stub, repo: string, digest: string): void {
  const base = {
    ref: `${repo}:latest`,
    digest,
    kind: 'skill',
    name: artifactName(repo),
    vendor: 'canonical',
  };
  canned(stub, 'describe', describeDoc(repo, { has_description: false, digest }));
  canned(stub, 'fetch', {
    ...base,
    content: '# Descriptor',
    files: [{ path: 'logo.png', size: 70 }],
  });
  canned(stub, 'fetch-logo', { ...base, path: 'logo.png', content: LOGO_B64, encoding: 'base64' });
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

/** One `grim status` row. `pinned` is what the repo is keyed on (the stub's
 *  context points config_path at a nonexistent file, so no declared ref wins
 *  over it), and `state: 'outdated'` is enough for the count — the local lock
 *  proxy answers when no `--check` verdict is around. */
function statusDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'skill',
    name: 'counted',
    source: 'direct',
    pinned: 'ghcr.io/grimoire-rs/skills/counted:1.0.0',
    state: 'installed',
    outputs: [],
    clients_missing: [],
    clients_extra: [],
    deprecated: null,
    replaced_by: null,
    update_available: null,
    ...overrides,
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

/** A detached webview-view double for the sidebar so its posted states (a
 *  no-op until a real view resolves — see SidebarProvider.post) can be
 *  observed. Models fakePanel(); resolveWebviewView additionally needs
 *  asWebviewUri/cspSource to build the HTML shell, onDidDispose to drop the
 *  boot handshake when the view goes away, and onDidReceiveMessage to wire the
 *  (unused here — tests call handleMessage/refresh directly) message channel. */
function fakeView(): { view: vscode.WebviewView; states: SidebarState[] } {
  const states: SidebarState[] = [];
  const view = {
    onDidDispose: () => ({ dispose() {} }),
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (message: HostToSidebar) => {
        if (message.type === 'state') {
          states.push(message.state);
        }
        return Promise.resolve(true);
      },
    },
  } as unknown as vscode.WebviewView;
  return { view, states };
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

/** Waits until activation's fire-and-forget work has stopped spawning grim.
 *
 *  `activate()` resolves long before it is finished: it kicks off
 *  `publishUpdateCount()` and `checkForUpdates()` without awaiting either, and
 *  a test that clears the argv log mid-chain sees the tail of activation's own
 *  spawns land in what it is about to assert on.
 *
 *  Settles on three consecutive quiet polls (~300ms) after at least one spawn,
 *  rather than waiting for a specific argv line: activation's shape varies. */
async function settleActivation(stub: Stub): Promise<void> {
  let previous = -1;
  let quiet = 0;
  await waitFor(() => {
    const count = argvLines(stub).length;
    quiet = count > 0 && count === previous ? quiet + 1 : 0;
    previous = count;
    return quiet >= 3;
  });
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
    await settleActivation(stub);
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
      'grimoire.checkArtifactUpdates',
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
    // The cheap path: a plain refresh must NOT bust grim's catalog cache.
    const search = lines.find((l) => l.startsWith('search'));
    assert.ok(search, 'search was invoked');
    assert.ok(!search.includes('--refresh'), `plain refresh stays cached: ${search}`);
    // §5 removal regression: grimoire.showDeprecated is retired in favor of
    // grim's own options.show_deprecated (set via the Settings panel) — the
    // extension must never override it with a VS Code-side flag.
    assert.ok(
      !search.includes('--show-deprecated'),
      `search honors grim's own config, no VS Code-side override: ${search}`,
    );
  });

  test('project with no grimoire.toml (NotDiscovered): browse falls back to global, notice offers init, no raw grim error leaks (items 2 + 3)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const { view, states } = fakeView();
    api.providers.sidebar.resolveWebviewView(view);
    // The shell stub cans one context.json for both scopes (it can't fake a
    // per-scope split — see the "run override" suite above), so this overrides
    // scopes.run on the ACTIVATED extension's real, shared ScopeService: project
    // context fails exactly like real grim's NotDiscovered (verified live
    // against grim 0.9.0 — see isProjectNotDiscovered), global context/search
    // succeed with one item, so an incorrect scope choice is visible as a
    // missing item rather than silently passing.
    const originalRun = api.scopes.run;
    const globalItem = searchItem('ghcr.io/grimoire-rs/skills/global-only');
    // Overriding run() entirely bypasses the real spawn (and its argv log) the
    // same way the "run override" suite's per-scope fakes do — record what
    // scope each command was called with directly instead.
    const searchCalls: Scope[] = [];
    try {
      api.scopes.run = (async <T>(args: string[], scope: Scope): Promise<GrimResult<T>> => {
        const cmd = args[0];
        if (cmd === 'context' && scope === 'project') {
          return {
            ok: false,
            kind: 'error',
            code: 'not-found',
            exitCode: 79,
            message: '/ws: no grimoire.toml found by walking up from the working directory',
          } as GrimResult<T>;
        }
        if (cmd === 'context') {
          return { ok: true, value: contextDoc({ config_exists: true }) } as GrimResult<T>;
        }
        if (cmd === 'search') {
          searchCalls.push(scope);
          return {
            ok: true,
            value: { items: scope === 'global' ? [globalItem] : [] },
          } as GrimResult<T>;
        }
        return { ok: true, value: { items: [] } } as GrimResult<T>;
      }) as typeof api.scopes.run;
      await api.providers.sidebar.refresh();
      assert.deepStrictEqual(searchCalls, ['global'], 'browse falls back to global scope');
      const last = states.at(-1);
      assert.ok(last, 'no state was posted');
      assert.notStrictEqual(
        last.phase,
        'error',
        'no raw grim error state — the NotDiscovered probe failure must not surface as a search error',
      );
      assert.strictEqual(last.scopes.projectConfigured, false);
      // projectOpen:true + projectConfigured:false is exactly
      // renderSidebarNotice's trigger condition (the init-offer banner is
      // covered on its own in render.test.ts / parity's notice-init-project).
      assert.strictEqual(last.scopes.projectOpen, true);
      assert.ok(
        last.items.some((c) => c.repo === globalItem['repo']),
        'the global-scope item populated browse',
      );
    } finally {
      api.scopes.run = originalRun;
      canned(stub, 'context', contextDoc());
    }
  });

  test('grimoire.refresh forces a catalog refresh (--refresh)', async function () {
    this.timeout(15000);
    await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    await vscode.commands.executeCommand('grimoire.refresh');
    const search = argvLines(stub).find((l) => l.startsWith('search'));
    assert.ok(search, 'search was invoked');
    assert.ok(search.includes('--refresh'), `explicit refresh carries --refresh: ${search}`);
  });

  test('concurrent refreshes coalesce into one round, keeping the strongest flags', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    // A watcher event, a command and an action's completion refresh can all
    // land at once; each used to spawn its own full round of grim calls.
    await Promise.all([api.refresh(), api.refresh({ refresh: true }), api.refresh()]);
    const searches = argvLines(stub).filter((l) => l.startsWith('search'));
    // Exactly one: three callers on the same tick all queue before the drain
    // starts, so they share a round. A drain that starts synchronously drains
    // an empty queue and charges the later two a second full round of grim
    // calls — the cost this coalescer exists to remove.
    assert.strictEqual(
      searches.length,
      1,
      `three same-tick refreshes are one round: ${searches.join(' | ')}`,
    );
    // The explicit refresh must not be downgraded by the cheap ones it merged
    // with — otherwise clicking Refresh could silently serve grim's cache.
    assert.ok(
      searches.some((l) => l.includes('--refresh')),
      `the coalesced round keeps --refresh: ${searches.join(' | ')}`,
    );
  });

  // The drain runs one round per queued request and each round is independent:
  // one participant throwing must not reject callers whose round never ran
  // (grimoire.refresh hands that promise to VS Code, which reports it as a
  // failed command) nor discard the options queued behind it.
  test('one round failing does not reject the callers or drop the queued round', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const settings = api.providers.settings;
    const original = settings.refreshOpenPanel.bind(settings);
    let rounds = 0;
    let enteredFirstRound = (): void => {};
    const entered = new Promise<void>((resolve) => {
      enteredFirstRound = resolve;
    });
    settings.refreshOpenPanel = async () => {
      rounds += 1;
      if (rounds === 1) {
        enteredFirstRound();
        // Stay in flight so the next caller queues behind this round instead
        // of joining it.
        await new Promise((r) => setTimeout(r, 100));
        throw new Error('refresh participant blew up');
      }
      await original();
    };
    try {
      const first = api.refresh();
      await entered;
      const second = api.refresh();
      const settled = await Promise.allSettled([first, second]);
      assert.deepStrictEqual(
        settled.map((r) => r.status),
        ['fulfilled', 'fulfilled'],
        'a failed round is logged, not handed back to callers as a rejected refresh',
      );
      assert.strictEqual(rounds, 2, 'the refresh queued during the failing round still ran');
      await api.refresh();
      assert.strictEqual(rounds, 3, 'the in-flight flag was released — later refreshes still run');
    } finally {
      settings.refreshOpenPanel = original;
    }
  });

  // Options are unioned across coalesced callers: the daily `check: true`
  // refresh must not be served by a cheap watcher refresh that queued with it.
  test('a plain refresh coalescing with a checked one still runs status --check', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      fs.rmSync(stub.argvLog, { force: true });
      await Promise.all([api.refresh(), api.refresh({ check: true })]);
      const statusLines = argvLines(stub).filter((l) => l.startsWith('status'));
      assert.ok(statusLines.length > 0, 'status was invoked');
      assert.ok(
        statusLines.some((l) => l.includes('--check')),
        `the coalesced round keeps --check: ${statusLines.join(' | ')}`,
      );
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  test('a plain refresh runs grim status without --check (stays offline)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // status only runs when the scope is configured — the default stub context
    // reports config_exists:false, so flip it on for this scope's status pass.
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      fs.rmSync(stub.argvLog, { force: true });
      await api.providers.sidebar.refresh();
      const statusLines = argvLines(stub).filter((l) => l.startsWith('status'));
      assert.ok(statusLines.length > 0, 'status was invoked');
      assert.ok(
        statusLines.every((l) => !l.includes('--check')),
        `a plain refresh must not opt into the network check: ${statusLines.join(' | ')}`,
      );
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  test('grimoire.checkArtifactUpdates runs grim status --check', async function () {
    this.timeout(15000);
    await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      fs.rmSync(stub.argvLog, { force: true });
      await vscode.commands.executeCommand('grimoire.checkArtifactUpdates');
      const statusLines = argvLines(stub).filter((l) => l.startsWith('status'));
      assert.ok(statusLines.length > 0, 'status was invoked');
      assert.ok(
        statusLines.some((l) => l.includes('--check')),
        `the check command opts into --check: ${statusLines.join(' | ')}`,
      );
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  // Automatic checks are gated on the setting AND workspace trust; the round
  // itself is debounced (see CheckScheduler), so these assert what a refresh
  // ARMS rather than waiting out the real quiet window.

  /** Runs `fn` with the window reporting itself untrusted. `isTrusted` is an
   *  accessor on the vscode namespace object and is configurable in this host,
   *  so the real getter is put back afterwards. */
  async function whileUntrusted(fn: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
    assert.ok(original, 'vscode.workspace.isTrusted has no own descriptor to restore');
    Object.defineProperty(vscode.workspace, 'isTrusted', { get: () => false, configurable: true });
    try {
      assert.strictEqual(
        vscode.workspace.isTrusted,
        false,
        'precondition: the window is untrusted',
      );
      await fn();
    } finally {
      Object.defineProperty(vscode.workspace, 'isTrusted', original);
    }
  }

  test('a plain refresh arms a check round — no daily throttle any more', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      await api.refresh();
      assert.ok(api.checkPending(), 'the refresh asked for verdicts');
      // …and it stays armed round after round: nothing consumes a daily stamp.
      await api.refresh();
      assert.ok(api.checkPending(), 'a second refresh is not throttled out');
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  test('checkNow spawns status --check every time it is called', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      for (const round of ['first', 'second']) {
        fs.rmSync(stub.argvLog, { force: true });
        await api.checkNow();
        const status = argvLines(stub).filter((l) => l.startsWith('status'));
        assert.ok(status.length > 0, `${round}: status was invoked`);
        assert.ok(
          status.some((l) => l.includes('--check')),
          `${round} round goes online: ${status.join(' | ')}`,
        );
      }
      assert.strictEqual(api.checkPending(), false, 'an explicit round drops the armed one');
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  test('an untrusted window arms no automatic check, but still obeys the command', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      await whileUntrusted(async () => {
        await api.refresh();
        assert.strictEqual(
          api.checkPending(),
          false,
          'a restricted window resolves nothing against the registry on its own',
        );
        // The command is the user's own gesture, so it is deliberately ungated.
        fs.rmSync(stub.argvLog, { force: true });
        await api.checkNow();
        assert.ok(
          argvLines(stub)
            .filter((l) => l.startsWith('status'))
            .some((l) => l.includes('--check')),
          'the explicit check still runs',
        );
      });
      await api.refresh();
      assert.ok(api.checkPending(), 'and automatic rounds resume the moment trust is granted');
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  test('the activation round publishes a count without a catalog search', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    canned(stub, 'status', { items: [statusDoc({ state: 'outdated' })] });
    try {
      api.providers.sidebar.setUpdateCount(0);
      fs.rmSync(stub.argvLog, { force: true });
      await api.publishUpdateCount();
      assert.strictEqual(api.providers.sidebar.updateCount(), 1, 'the count reaches the badge');
      assert.deepStrictEqual(
        argvLines(stub).filter((l) => l.startsWith('search')),
        [],
        'and it cost no catalog search — updateCount reads no field the catalog provides',
      );
    } finally {
      canned(stub, 'status', { items: [] });
      canned(stub, 'context', contextDoc());
      api.providers.sidebar.setUpdateCount(0);
    }
  });

  test('an unknown install state leaves the count untouched', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'context', contextDoc({ config_exists: true }));
    // A stale binary rejecting `status`: install state is UNKNOWN, and a count
    // taken over it reads as "no updates" — indistinguishable from good news.
    canned(stub, 'status', {
      error: { code: 'usage', exit: 64, message: "unexpected argument '--check' found" },
    });
    try {
      api.providers.sidebar.setUpdateCount(3);
      await api.publishUpdateCount();
      assert.strictEqual(
        api.providers.sidebar.updateCount(),
        3,
        'the last count it could stand behind stays up; it is not cleared to 0',
      );
    } finally {
      canned(stub, 'status', { items: [] });
      canned(stub, 'context', contextDoc());
      api.providers.sidebar.setUpdateCount(0);
    }
  });

  test('a failed status keeps browsing but marks install state unknown', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const { view, states } = fakeView();
    api.providers.sidebar.resolveWebviewView(view);
    // The reported bug: Check for Updates against a grim without `status
    // --check` (exit 64) silently emptied the status list, flipping every
    // installed card to "Install" and clearing the badge. The catalog is still
    // good, so browsing stays available — but the state must say install
    // state is unknown, which drops every install affordance and the badge.
    const originalRun = api.scopes.run;
    try {
      api.scopes.run = (async <T>(args: string[]): Promise<GrimResult<T>> => {
        if (args[0] === 'context') {
          return { ok: true, value: contextDoc({ config_exists: true }) } as GrimResult<T>;
        }
        if (args[0] === 'status') {
          return {
            ok: false,
            kind: 'error',
            code: 'usage',
            exitCode: 64,
            message: "unexpected argument '--check' found",
          } as GrimResult<T>;
        }
        return {
          ok: true,
          value: { items: [searchItem('ghcr.io/grimoire-rs/skills/installed-one')] },
        } as GrimResult<T>;
      }) as typeof api.scopes.run;
      await api.providers.sidebar.refresh({ check: true });
      const last = states.at(-1);
      assert.ok(last, 'no state was posted');
      assert.strictEqual(last.phase, 'ready', 'the catalog loaded — browsing stays available');
      assert.ok(
        last.installStateUnknown?.includes('unexpected argument'),
        `the status failure message rides the state: ${last.installStateUnknown}`,
      );
      assert.strictEqual(
        last.error,
        undefined,
        'a status failure is not a catalog failure — the error phase stays for the latter',
      );
      assert.ok(last.items.length > 0, 'catalog cards still reach the webview');
    } finally {
      api.scopes.run = originalRun;
    }
  });

  test('details buildVM threads {check} into its own snapshot (checked refresh path)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const details = api.providers.details;
    const repo = 'ghcr.io/grimoire-rs/skills/check-details-vm';
    // status only runs for a configured scope; flip config_exists on so the
    // details snapshot issues an inspectable status pass.
    canned(stub, 'context', contextDoc({ config_exists: true }));
    try {
      // A plain buildVM (open / post-action refresh) stays offline — no --check.
      fs.rmSync(stub.argvLog, { force: true });
      await details.buildVM(repo);
      const plain = argvLines(stub).filter((l) => l.startsWith('status'));
      assert.ok(plain.length > 0, 'plain buildVM ran status');
      assert.ok(
        plain.every((l) => !l.includes('--check')),
        `plain buildVM must stay offline: ${plain.join(' | ')}`,
      );
      // A checked buildVM — the path refreshAll({check:true}) drives through
      // refreshOpenPanels → postVM into every open panel — opts into --check, so
      // an open Details panel gets the same network-verified data as the sidebar
      // (not a stale/unchecked snapshot racing the sidebar's checked one).
      fs.rmSync(stub.argvLog, { force: true });
      await details.buildVM(repo, { check: true });
      const checked = argvLines(stub).filter((l) => l.startsWith('status'));
      assert.ok(checked.length > 0, 'checked buildVM ran status');
      assert.ok(
        checked.every((l) => l.includes('--check')),
        `checked buildVM must opt into --check: ${checked.join(' | ')}`,
      );
    } finally {
      canned(stub, 'context', contextDoc());
    }
  });

  test('a search envelope missing items does not crash the refresh', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // A grim response that parses ok but omits `items` (contract violation /
    // version skew) must not throw when the card builders iterate it.
    canned(stub, 'search', { unexpected: true });
    try {
      await api.providers.sidebar.refresh();
    } finally {
      canned(stub, 'search', { items: [] });
    }
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

  test('complete-install runs a scope-wide grim install — never update, never --force', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'install', { items: [] });
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.handleMessage({ type: 'complete-install', scope: 'global' });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('install')));
    const install = argvLines(stub).find((l) => l.startsWith('install'));
    assert.ok(install);
    assert.ok(install.includes('--global'), `scoped: ${install}`);
    // No artifact positional: grim install cannot target one member of the lock.
    assert.ok(!install.includes(' -- '), `no positional: ${install}`);
    // Forcing a whole-lock install would discard local edits to OTHER artifacts.
    assert.ok(!install.includes('--force'), `never forced: ${install}`);
    // The remedy is install, not update — update would roll the pins forward.
    assert.ok(
      !argvLines(stub).some((l) => l.startsWith('update')),
      'no update ran',
    );
  });

  test('a refused Complete Install neither blocks the action nor skips its refresh', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // grim's locally-modified refusal, aborting the whole scope.
    canned(stub, 'install', {
      error: {
        code: 'data',
        exit: 65,
        forceable: true,
        reason: 'modified',
        message: 'installed artifact was modified locally; rerun with --force to overwrite',
      },
    });
    // A notification the user never clicks. Awaiting this is exactly the bug:
    // it would hold the busy lock and the watcher suspension open indefinitely.
    const window = vscode.window as unknown as { showErrorMessage: unknown };
    const original = window.showErrorMessage;
    window.showErrorMessage = () => new Promise<string | undefined>(() => {});
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({ type: 'complete-install', scope: 'global' });
    } finally {
      window.showErrorMessage = original;
      uncan(stub, 'install');
    }
    // Reaching here at all is the assertion: an awaited dialog times out the test.
    const lines = argvLines(stub);
    const installAt = lines.findIndex((l) => l.startsWith('install'));
    assert.notStrictEqual(installAt, -1, `the install ran: ${lines.join(' | ')}`);
    // The refusal falls through to the refresh it owes rather than returning —
    // grim stops at the first modified artifact, having written the ones before.
    assert.ok(
      lines.slice(installAt + 1).some((l) => l.startsWith('status') || l.startsWith('context')),
      `the refusal still refreshed: ${lines.join(' | ')}`,
    );
  });

  test('complete-install in project scope carries no --global', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'install', { items: [] });
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.sidebar.handleMessage({ type: 'complete-install', scope: 'project' });
    await waitFor(() => argvLines(stub).some((l) => l.startsWith('install')));
    const install = argvLines(stub).find((l) => l.startsWith('install'));
    assert.ok(install && !install.includes('--global'), `project-scoped: ${install}`);
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
    assert.ok(line.includes('-- skill demo'));
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
    assert.ok(
      line.startsWith('remove ') && line.includes('-- bundle grim-essentials'),
      `argv was: ${line}`,
    );
    assert.ok(line.includes('--global'));
    assert.ok(!argvLines(stub).some((l) => l.startsWith('uninstall')), 'no uninstall was issued');
  });

  // --- switch-to-replacement (package 4) ---
  const SWITCH_MSG = {
    type: 'switch' as const,
    oldKind: 'skill',
    oldName: 'grim-usage',
    replacedBy: 'ghcr.io/grimoire-rs/skills/new-skill',
    scope: 'global' as const,
  };

  /** Installs a modal-confirm/error-toast stub pair; returns a restore fn plus
   *  the captured error-toast text (last shown). `confirm` is the modal answer. */
  function stubSwitchDialogs(confirm: 'Switch' | undefined): {
    restore: () => void;
    lastError: () => string;
  } {
    const window = vscode.window as unknown as {
      showWarningMessage: unknown;
      showErrorMessage: unknown;
    };
    const originalWarn = window.showWarningMessage;
    const originalError = window.showErrorMessage;
    let error = '';
    window.showWarningMessage = async () => confirm;
    window.showErrorMessage = async (message: string) => {
      error = message;
      return undefined;
    };
    return {
      restore: () => {
        window.showWarningMessage = originalWarn;
        window.showErrorMessage = originalError;
      },
      lastError: () => error,
    };
  }

  /** Restores the shared add/uninstall stubs to their happy defaults after a
   *  test canned a failure into one of them. */
  function restoreAddUninstall(): void {
    canned(stub, 'add', { kind: 'skill', name: 'demo', pinned: 'x@sha256:1', status: 'added' });
    fs.rmSync(path.join(stub.dir, 'uninstall.json'), { force: true });
  }

  test('sidebar switch installs the replacement, then uninstalls the old, in that order', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', {
      kind: 'skill',
      name: 'new-skill',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    canned(stub, 'uninstall', { kind: 'skill', name: 'grim-usage', status: 'uninstalled' });
    const dialogs = stubSwitchDialogs('Switch');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage(SWITCH_MSG);
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    const lines = argvLines(stub);
    const addIdx = lines.findIndex((l) => l.startsWith('add '));
    const rmIdx = lines.findIndex((l) => l.startsWith('uninstall '));
    assert.ok(addIdx >= 0, `add ran: ${lines.join(' | ')}`);
    assert.ok(rmIdx >= 0, `uninstall ran: ${lines.join(' | ')}`);
    assert.ok(addIdx < rmIdx, 'add precedes uninstall');
    assert.ok(lines[addIdx]?.includes('ghcr.io/grimoire-rs/skills/new-skill'));
    assert.ok(lines[addIdx]?.includes('--global'), 'replacement installed in the same scope');
    assert.ok(lines[rmIdx]?.includes('skill grim-usage'));
    assert.ok(lines[rmIdx]?.includes('--global'), 'old removed from the same scope');
  });

  test('switch aborts (no uninstall) when the replacement install fails', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', { error: { code: 'unavailable', exit: 69, message: 'registry down' } });
    const dialogs = stubSwitchDialogs('Switch');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage(SWITCH_MSG);
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.ok(
      argvLines(stub).some((l) => l.startsWith('add ')),
      'the add was attempted',
    );
    assert.ok(
      !argvLines(stub).some((l) => l.startsWith('uninstall ')),
      'nothing is torn down after an add failure',
    );
    assert.ok(dialogs.lastError().includes('registry down'), 'the add error is surfaced');
  });

  test('switch shows a partial toast when the old artifact cannot be removed', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', {
      kind: 'skill',
      name: 'new-skill',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    canned(stub, 'uninstall', { error: { code: 'io', exit: 74, message: 'disk full' } });
    const dialogs = stubSwitchDialogs('Switch');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage(SWITCH_MSG);
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.ok(
      argvLines(stub).some((l) => l.startsWith('add ')),
      'the replacement was installed',
    );
    assert.ok(
      argvLines(stub).some((l) => l.startsWith('uninstall ')),
      'the remove was attempted',
    );
    const error = dialogs.lastError();
    assert.ok(
      error.includes('installed ghcr.io/grimoire-rs/skills/new-skill'),
      `partial toast names the installed replacement: ${error}`,
    );
    assert.ok(
      error.includes('could not remove grim-usage'),
      `partial toast names the old artifact to remove by hand: ${error}`,
    );
  });

  test('switch reports a name-collision (exit 64) distinctly and runs no uninstall', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', { error: { code: 'usage', exit: 64, message: 'name conflict' } });
    const dialogs = stubSwitchDialogs('Switch');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage(SWITCH_MSG);
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.ok(
      !argvLines(stub).some((l) => l.startsWith('uninstall ')),
      'a collision tears nothing down',
    );
    const error = dialogs.lastError();
    assert.ok(
      error.includes('already installed under a different source'),
      `collision toast is distinct: ${error}`,
    );
    assert.ok(
      error.includes('Resolve it manually'),
      `collision toast points at manual fix: ${error}`,
    );
  });

  test('a declined switch modal runs no grim at all', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubSwitchDialogs(undefined);
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage(SWITCH_MSG);
    } finally {
      dialogs.restore();
    }
    const lines = argvLines(stub);
    assert.ok(
      !lines.some(
        (l) => l.startsWith('add ') || l.startsWith('uninstall ') || l.startsWith('remove '),
      ),
      `declining the modal spawns no mutating grim call: ${lines.join(' | ')}`,
    );
  });

  test('details uninstall of a bundle-held member notifies without a panel error', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // Isolated: these drive real details actions on a shared repo, and an
    // un-isolated cache is both read from and written to by every run.
    isolateCache(api);
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

  test('pickVersion wiring: a forceable refusal offers Overwrite and retries with --force (third funnel)', async function () {
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
    canned(stub, 'add', {
      error: {
        code: 'data',
        exit: 65,
        message: 'installed artifact was modified locally',
        reason: 'modified',
        forceable: true,
      },
    });
    canned(stub, 'add-force', {
      kind: 'skill',
      name: 'grim-usage',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const originalQuickPick = window.showQuickPick;
    window.showQuickPick = async () => '1.4.2';
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'pickVersion',
        repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
      });
      await waitFor(() => argvLines(stub).some((l) => l.includes('--force')));
    } finally {
      window.showQuickPick = originalQuickPick;
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'add-force.json'), { force: true });
      restoreAddUninstall();
    }
    const adds = argvLines(stub).filter((l) => l.startsWith('add'));
    assert.ok(
      adds.some((l) => l.includes('--force')),
      `a forced retry ran: ${adds.join(' | ')}`,
    );
    assert.strictEqual(dialogs.warningCalls.length, 1, 'the Overwrite confirm was shown');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'no error toast for a confirmed forced retry');
  });

  test('pickVersion wiring: a plain refusal falls through to the normal error toast', async function () {
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
    canned(stub, 'add', { error: { code: 'data', exit: 65, message: 'registry unreachable' } });
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const originalQuickPick = window.showQuickPick;
    window.showQuickPick = async () => '1.4.2';
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'pickVersion',
        repo: 'ghcr.io/grimoire-rs/skills/grim-usage',
      });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('add')));
    } finally {
      window.showQuickPick = originalQuickPick;
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.strictEqual(dialogs.warningCalls.length, 0, 'no dialog for a plain refusal');
    assert.strictEqual(dialogs.errorCalls.length, 1, 'the plain error toast was shown');
    assert.ok(
      dialogs.errorCalls[0]?.message.includes('registry unreachable'),
      `the toast names the failure: ${dialogs.errorCalls[0]?.message}`,
    );
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

  test('a forceable updateAll refusal routes to the dialog AND lets the other scope run (H12b)', async () => {
    // The wiring nothing covered. Two claims, and the second is the one that
    // matters: the refusal used to be AWAITED inside runWithStatusProgress
    // inside suspendWhile, so a project-scope refusal held the global update,
    // the closing refresh, the busy lock and watcher delivery hostage behind a
    // notification that does not auto-dismiss. Refusals are collected now and
    // shown once everything has settled.
    canned(stub, 'context', contextDoc({ config_exists: true }));
    canned(stub, 'update', {
      error: {
        code: 'data',
        exit: 65,
        message: 'demo is locally modified; rerun with --force',
        reason: 'modified',
        forceable: true,
      },
    });
    canned(stub, 'status', { items: [] });
    const window = vscode.window as unknown as { showErrorMessage: unknown };
    const original = window.showErrorMessage;
    // Snapshotted AT DIALOG TIME, per dialog. This is the assertion that
    // actually pins the fix: a stub that returns immediately would let the old
    // awaited-in-place code pass a "both scopes ran by the end" check, because
    // the block it caused only lasts as long as a real human ignores the
    // notification. What the stub CAN see is ordering — with the refusal
    // awaited inside the command, only the project update had been issued (and
    // the closing refresh had not run) when the dialog opened.
    const calls: { items: string[]; updates: number; searches: number }[] = [];
    window.showErrorMessage = async (message: string, ...items: string[]) => {
      const lines = argvLines(stub);
      calls.push({
        items: [message, ...items],
        updates: lines.filter(isFullUpdate).length,
        searches: lines.filter((l) => l.startsWith('search')).length,
      });
      return undefined; // dismissed
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await vscode.commands.executeCommand('grimoire.updateAll');
    } finally {
      window.showErrorMessage = original;
      canned(stub, 'context', contextDoc());
      canned(stub, 'update', { items: [] });
    }

    // Both scopes ran. Before the fix the project refusal returned out of the
    // whole command with the global update never issued.
    const updates = argvLines(stub).filter(isFullUpdate);
    assert.strictEqual(updates.length, 2, `both scopes still update: ${updates.join(' | ')}`);
    assert.ok(updates.some((l) => l.includes('--global')));

    assert.strictEqual(
      calls[0]?.updates,
      2,
      'the dialog waits until both scopes have run — it no longer blocks the command',
    );
    assert.ok((calls[0]?.searches ?? 0) > 0, 'and until the closing refreshAll has run');

    // S-008: one dialog per refusing scope, sequentially, project first. The
    // snapshot holds no modified rows, so both take the unnamed form (S-009's
    // documented degradation) — which is also what makes them distinguishable
    // by scope here. The named `Open <name>` form is covered directly above.
    const messages = calls.map((c) => c.items[0] ?? '');
    assert.strictEqual(calls.length, 2, `one dialog per refusal: ${messages.join(' | ')}`);
    assert.ok(messages[0]?.includes('update (project) stopped'), `project first: ${messages[0]}`);
    assert.ok(messages[1]?.includes('update (global) stopped'), `global second: ${messages[1]}`);
    assert.ok(
      messages.every((m) => m.includes('demo is locally modified')),
      `each carries grim's own message: ${messages.join(' | ')}`,
    );
    // The named dialog, never the plain toast — which reads
    // "grim update (<scope>): <message>" and offers nothing to act on.
    assert.ok(
      !messages.some((m) => m.includes('grim update (')),
      `no plain error toast for a forceable refusal: ${messages.join(' | ')}`,
    );
    assert.ok(
      !calls.some((c) => c.items.some((i) => i.toLowerCase().includes('overwrite'))),
      'never a one-click force for a whole-scope run',
    );
  });

  test('updateAll toasts when a row reaps or keeps-modified a client output', async () => {
    canned(stub, 'update', {
      items: [
        {
          kind: 'skill',
          name: 'code-review',
          old: 'sha256:old1',
          new: 'sha256:new1',
          action: 'updated',
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
    const window = vscode.window as unknown as { showInformationMessage: unknown };
    const original = window.showInformationMessage;
    const messages: string[] = [];
    window.showInformationMessage = async (message: string) => {
      messages.push(message);
      return undefined;
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await vscode.commands.executeCommand('grimoire.updateAll');
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('update')));
    } finally {
      window.showInformationMessage = original;
      canned(stub, 'update', { items: [] });
    }
    const toast = messages.find((m) => m.startsWith('Grimoire: update'));
    assert.ok(toast, `a reap/kept-modified toast was shown: ${messages.join(' | ')}`);
    assert.ok(toast.includes('code-review'), `toast names the reaped artifact: ${toast}`);
    assert.ok(toast.includes('edited-rule'), `toast names the kept-modified artifact: ${toast}`);
    assert.ok(toast.includes('--force'), `toast points at the --force follow-up: ${toast}`);
  });

  test('a refused update names the modified artifact and offers to open it', async () => {
    // The error-document shape: a locally modified artifact aborts the whole
    // scope with exit 65 + forceable (`grim install`, and `grim update` before
    // 0.13.0 moved its refusal onto a normal report). The artifact is named from
    // the snapshot, never scraped out of grim's message.
    const scopes = {
      cachedSnapshot: () => ({
        global: {
          status: [
            { kind: 'skill', name: 'demo', state: 'modified', pinned: null, outputs: [] },
            { kind: 'skill', name: 'fine', state: 'installed', pinned: null, outputs: [] },
          ],
          declared: { 'skill:demo': 'ghcr.io/o/skills/demo:1.0.0' },
        },
      }),
    } as unknown as ScopeService;
    const window = vscode.window as unknown as { showErrorMessage: unknown };
    const original = window.showErrorMessage;
    const calls: string[][] = [];
    window.showErrorMessage = async (message: string, ...items: string[]) => {
      calls.push([message, ...items]);
      return undefined; // dismissed — never executes the open command here
    };
    try {
      await offerModifiedRefusal(
        scopes,
        'global',
        'update',
        { message: 'demo is locally modified; rerun with --force' },
      );
    } finally {
      window.showErrorMessage = original;
    }
    const [call] = calls;
    assert.ok(call, 'an error was surfaced');
    assert.ok(call[0]?.includes('demo is locally modified'), `carries grim's message: ${call[0]}`);
    assert.ok(call.includes('Open demo'), `offers to open the artifact: ${call.join(' | ')}`);
    // Never a one-click force: that would overwrite every modified artifact in
    // the scope while grim named only the one it stopped on.
    assert.ok(!call.some((c) => c.toLowerCase().includes('overwrite')));
  });

  test('a refused update with several modified artifacts names them all, offers no open', async () => {
    const scopes = {
      cachedSnapshot: () => ({
        project: {
          status: [
            { kind: 'skill', name: 'one', state: 'modified', pinned: null, outputs: [] },
            { kind: 'rule', name: 'two', state: 'modified', pinned: null, outputs: [] },
          ],
          declared: {
            'skill:one': 'ghcr.io/o/skills/one:1.0.0',
            'rule:two': 'ghcr.io/o/rules/two:1.0.0',
          },
        },
      }),
    } as unknown as ScopeService;
    const window = vscode.window as unknown as { showErrorMessage: unknown };
    const original = window.showErrorMessage;
    const calls: string[][] = [];
    window.showErrorMessage = async (message: string, ...items: string[]) => {
      calls.push([message, ...items]);
      return undefined;
    };
    try {
      await offerModifiedRefusal(
        scopes,
        'project',
        'update',
        { message: 'one is locally modified; rerun with --force' },
      );
    } finally {
      window.showErrorMessage = original;
    }
    const [call] = calls;
    assert.ok(call?.[0]?.includes('one, two'), `names every modified artifact: ${call?.[0]}`);
    assert.ok(!call?.some((c) => c.startsWith('Open ')), 'no single artifact to open');
  });

  // --- Complete Install's refusal (offerInstallRefusal) ---

  /** A scope with exactly one locally-modified artifact, enough for the
   *  named-and-openable branch. */
  function modifiedScopes(): ScopeService {
    return {
      cachedSnapshot: () => ({
        project: {
          status: [{ kind: 'skill', name: 'demo', state: 'modified', pinned: null, outputs: [] }],
          declared: { 'skill:demo': 'ghcr.io/o/skills/demo:1.0.0' },
        },
      }),
    } as unknown as ScopeService;
  }

  function captureErrors(): { calls: string[][]; restore: () => void } {
    const window = vscode.window as unknown as { showErrorMessage: unknown };
    const original = window.showErrorMessage;
    const calls: string[][] = [];
    window.showErrorMessage = async (message: string, ...items: string[]) => {
      calls.push([message, ...items]);
      return undefined;
    };
    return { calls, restore: () => (window.showErrorMessage = original) };
  }

  const forceableInstallRefusal = {
    ok: false as const,
    kind: 'error' as const,
    code: 'data',
    exitCode: 65,
    reason: 'modified',
    forceable: true,
    message: 'installed artifact was modified locally; rerun with --force to overwrite',
  };

  test('offerInstallRefusal handles a refused Complete Install: logs, names it, says "install"', async () => {
    const lines: string[] = [];
    const output = { appendLine: (l: string) => lines.push(l) } as unknown as vscode.OutputChannel;
    const errors = captureErrors();
    let handled: boolean;
    try {
      handled = offerInstallRefusal(
        forceableInstallRefusal,
        installArgs(),
        'project',
        modifiedScopes(),
        output,
      );
      // The dialog is deliberately not awaited by the caller, so let the
      // fire-and-forget continuation reach showErrorMessage before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      errors.restore();
    }
    assert.strictEqual(handled, true, 'the refusal is handled, not a fall-through');
    // Returning true skips the caller's reportGrimFailure, so this helper owes
    // the output line its own "Show Output" button sends the user to.
    assert.ok(
      lines.some((l) => l.includes('grim install --project') && l.includes('modified locally')),
      `logged the failure itself: ${JSON.stringify(lines)}`,
    );
    const [call] = errors.calls;
    assert.ok(call, 'an error was surfaced');
    // "install stopped", never "update stopped" — the operation verb is the
    // whole reason offerModifiedRefusal takes one.
    assert.ok(call[0]?.includes('install stopped'), `names the operation: ${call[0]}`);
    assert.ok(call.includes('Open demo'), `offers to open the artifact: ${call.join(' | ')}`);
    // The BUTTONS, not the message — grim's own text says "rerun with --force
    // to overwrite" and is quoted verbatim on purpose.
    assert.ok(
      !call.slice(1).some((c) => c.toLowerCase().includes('overwrite')),
      'still no one-click force for a scope-wide call',
    );
  });

  test('offerInstallRefusal declines everything that is not a forceable install', async () => {
    const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
    const errors = captureErrors();
    const scopes = modifiedScopes();
    let update: boolean;
    let plain: boolean;
    try {
      // Right refusal, wrong verb: `grim update`'s own refusal belongs to
      // extension.ts's updateAll handler, which passes operation:'update'.
      update = offerInstallRefusal(
        forceableInstallRefusal,
        updateArgs(),
        'project',
        scopes,
        output,
      );
      // Right verb, ordinary failure: no forceable flag, so this is not the
      // locally-modified refusal and must reach the plain error toast.
      plain = offerInstallRefusal(
        { ok: false, kind: 'error', code: 'data', exitCode: 65, message: 'registry unreachable' },
        installArgs(),
        'project',
        scopes,
        output,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      errors.restore();
    }
    assert.strictEqual(update, false, 'a non-install argv falls through');
    assert.strictEqual(plain, false, 'a non-forceable install failure falls through');
    assert.deepStrictEqual(errors.calls, [], 'neither case opened a dialog');
  });

  test('updateAll stays silent when no row reaps or keeps-modified a client output (autodetect)', async () => {
    canned(stub, 'update', {
      items: [
        {
          kind: 'skill',
          name: 'code-review',
          old: 'sha256:old1',
          new: 'sha256:new1',
          action: 'updated',
          reaped_clients: [],
          kept_modified_clients: [],
        },
      ],
    });
    const window = vscode.window as unknown as { showInformationMessage: unknown };
    const original = window.showInformationMessage;
    let called = false;
    window.showInformationMessage = async () => {
      called = true;
      return undefined;
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await vscode.commands.executeCommand('grimoire.updateAll');
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('update')));
    } finally {
      window.showInformationMessage = original;
      canned(stub, 'update', { items: [] });
    }
    assert.strictEqual(
      called,
      false,
      'no toast when every row has empty reaped/kept-modified arrays',
    );
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
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => isFullUpdate(l)));
    } finally {
      window.showWarningMessage = originalWarn;
      window.showErrorMessage = originalError;
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(
      updates.some((l) => updatesArtifact(l, 'demo')),
      `per-name update ran: ${updates.join(' | ')}`,
    );
    const full = updates.find((l) => isFullUpdate(l));
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
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => updatesArtifact(l, 'demo')));
    } finally {
      window.showWarningMessage = originalWarn;
      window.showErrorMessage = originalError;
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(
      updates.some((l) => updatesArtifact(l, 'demo')),
      'the per-name update ran',
    );
    assert.ok(!updates.some(isFullUpdate), `no full update ran: ${updates.join(' | ')}`);
    assert.ok(errored, 'the plain error toast was shown');
    assert.ok(!warned, 'no stale-lock warning for a non-stale error');
  });

  test('details stale-lock update offers a full re-resolve without a panel error', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // Isolated: these drive real details actions on a shared repo, and an
    // un-isolated cache is both read from and written to by every run.
    isolateCache(api);
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
      await waitFor(() => argvLines(stub).some((l) => isFullUpdate(l)));
    } finally {
      window.showWarningMessage = originalWarn;
      window.showErrorMessage = originalError;
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(
      updates.some((l) => isFullUpdate(l)),
      'a bare full update ran',
    );
    assert.ok(warned, 'the stale-lock warning was shown');
    assert.ok(!errored, 'no error toast for the stale-lock refusal');
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered (busy cleared) after the recovery',
    );
  });

  // --- force-confirm / anchor-escape dialogs (offerForcedRetry) ---
  //
  // These exercise offerForcedRetry directly against the activated
  // extension's real ScopeService (backed by the stub binary) instead of
  // routing through handleMessage/onMessage — the same shape as the
  // stale-lock suite above, minus the host plumbing. The wiring into
  // sidebar.ts's runActionInner and details.ts's actionInner is covered
  // separately, in the host-wiring suite below.

  interface DialogCall {
    message: string;
    options?: vscode.MessageOptions;
    items: string[];
  }

  /** Captures showWarningMessage/showErrorMessage calls in full — message,
   *  MessageOptions (when passed), and the offered action items — unlike
   *  stubSwitchDialogs above, which returns a canned answer without
   *  inspecting its arguments (so a regression that silently dropped
   *  `modal: true` would pass there today). `answer` is returned from both
   *  dialogs; a real caller only ever triggers one of the two per call. */
  function stubForceDialogs(answer: string | undefined): {
    restore: () => void;
    warningCalls: DialogCall[];
    errorCalls: DialogCall[];
  } {
    const window = vscode.window as unknown as {
      showWarningMessage: (...args: unknown[]) => Promise<string | undefined>;
      showErrorMessage: (...args: unknown[]) => Promise<string | undefined>;
    };
    const originalWarn = window.showWarningMessage;
    const originalError = window.showErrorMessage;
    const warningCalls: DialogCall[] = [];
    const errorCalls: DialogCall[] = [];
    const record =
      (calls: DialogCall[]) =>
      async (...args: unknown[]): Promise<string | undefined> => {
        const [message, second, ...rest] = args;
        const hasOptions = typeof second === 'object' && second !== null;
        calls.push({
          message: message as string,
          // exactOptionalPropertyTypes: omit the key entirely for a non-modal
          // call instead of assigning `options: undefined`.
          ...(hasOptions ? { options: second as vscode.MessageOptions } : {}),
          items: (hasOptions ? rest : [second, ...rest].filter((x) => x !== undefined)) as string[],
        });
        return answer;
      };
    window.showWarningMessage = record(warningCalls);
    window.showErrorMessage = record(errorCalls);
    return {
      restore: () => {
        window.showWarningMessage = originalWarn;
        window.showErrorMessage = originalError;
      },
      warningCalls,
      errorCalls,
    };
  }

  type FailedGrimResult = Extract<GrimResult<unknown>, { ok: false; kind: 'error' }>;

  /** `grim add`/`update`'s "modified" refusal — forceable, with grim's
   *  message left exactly as documented in the plan (install_error.rs:74-77),
   *  since the confirm dialog's detail must display it verbatim. */
  function forceableRefusal(): FailedGrimResult {
    return {
      ok: false,
      kind: 'error',
      code: 'data',
      exitCode: 65,
      reason: 'modified',
      forceable: true,
      message:
        'installed artifact was modified locally: recorded sha256:aaa…, found sha256:bbb…; ' +
        'rerun with --force to overwrite',
    };
  }

  /** An anchor-escape refusal. Never forceable — per the contract the key is
   *  omitted entirely rather than sent as a bare `false`. */
  function anchorEscapeRefusal(): FailedGrimResult {
    return {
      ok: false,
      kind: 'error',
      code: 'data',
      exitCode: 65,
      reason: 'anchor-escape',
      message: 'resolved path escapes its anchor root (anchor: claude-root)',
    };
  }

  test('force-confirm: confirming re-issues the original argv with --force appended, modal, Overwrite only', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', {
      kind: 'skill',
      name: 'code-review',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    const refusal = forceableRefusal();
    let handled: boolean;
    let onDoneCalled = false;
    try {
      handled = await offerForcedRetry(
        refusal,
        addArgs('ghcr.io/grimoire-rs/code-review'),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {
          onDoneCalled = true;
        },
      );
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.strictEqual(handled, true, 'a confirmed retry is handled');
    const lines = argvLines(stub);
    assert.strictEqual(lines.length, 1, `exactly one retry call: ${lines.join(' | ')}`);
    assert.strictEqual(
      lines[0],
      'add --force --format json -- ghcr.io/grimoire-rs/code-review --global',
      'the same argv is reissued with --force appended, in the same scope',
    );
    assert.ok(onDoneCalled, 'onDone refreshes after a successful forced retry');
    const call = dialogs.warningCalls[0];
    assert.ok(call, 'the confirm dialog was shown');
    assert.strictEqual(call.options?.modal, true, 'the force-confirm dialog is modal');
    assert.deepStrictEqual(call.items, ['Overwrite'], 'Overwrite is the only offered action');
    const detail = call.options?.detail ?? '';
    assert.ok(
      detail.includes(refusal.message),
      `the detail carries grim's message byte-identical, never parsed or truncated: ${detail}`,
    );
    assert.ok(
      detail.startsWith('Reinstalling discards your local changes'),
      `the consequence sentence leads, since that's what the user is deciding on: ${detail}`,
    );
  });

  test('force-confirm: retrying preserves project scope (no --global)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', {
      kind: 'skill',
      name: 'demo',
      pinned: 'y@sha256:2',
      status: 'updated',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await offerForcedRetry(
        forceableRefusal(),
        updateArgs(['demo']),
        'project',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const lines = argvLines(stub);
    assert.strictEqual(lines.length, 1, `exactly one retry call: ${lines.join(' | ')}`);
    assert.strictEqual(
      lines[0],
      'update --force --format json -- demo',
      'project scope carries no --global prefix',
    );
  });

  test('force-confirm: declining runs no second grim call and shows no error toast', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs(undefined); // Cancel / dismiss
    fs.rmSync(stub.argvLog, { force: true });
    let handled: boolean;
    let onDoneCalled = false;
    try {
      handled = await offerForcedRetry(
        forceableRefusal(),
        addArgs('ghcr.io/grimoire-rs/code-review'),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {
          onDoneCalled = true;
        },
      );
    } finally {
      dialogs.restore();
    }
    assert.strictEqual(
      handled,
      true,
      'a declined confirm is still "handled" — the refusal is expected, not an error',
    );
    assert.strictEqual(argvLines(stub).length, 0, 'declining issues no second grim call');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'declining shows no error toast');
    assert.strictEqual(onDoneCalled, false, 'nothing changed, so no refresh is triggered');
  });

  test("force-confirm dialog names the artifact by the ref's last path segment, not the full path", async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', {
      kind: 'skill',
      name: 'code-review',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await offerForcedRetry(
        forceableRefusal(),
        addArgs('ghcr.io/grimoire-rs/code-review'),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    const call = dialogs.warningCalls[0];
    assert.ok(call, 'the confirm dialog was shown');
    assert.ok(call.message.includes('code-review'), `dialog names the artifact: ${call.message}`);
    assert.ok(
      !call.message.includes('ghcr.io/grimoire-rs/code-review'),
      `dialog uses the last path segment, not the full ref: ${call.message}`,
    );
  });

  test('force-confirm dialog names the artifact directly for a bare-name ref (grim update)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', {
      kind: 'skill',
      name: 'demo',
      pinned: 'y@sha256:2',
      status: 'updated',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await offerForcedRetry(
        forceableRefusal(),
        updateArgs(['demo']),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const call = dialogs.warningCalls[0];
    assert.ok(call, 'the confirm dialog was shown');
    assert.ok(call.message.includes('demo'), `dialog names the artifact: ${call.message}`);
  });

  test("force-confirm dialog strips a trailing tag from the ref, matching grim's id.name() rule", async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', {
      kind: 'skill',
      name: 'code-review',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await offerForcedRetry(
        forceableRefusal(),
        addArgs('ghcr.io/grimoire-rs/code-review:1.2.3'),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    const call = dialogs.warningCalls[0];
    assert.ok(call, 'the confirm dialog was shown');
    assert.ok(call.message.includes('`code-review`'), `dialog names the artifact: ${call.message}`);
    assert.ok(
      !call.message.includes('code-review:1.2.3'),
      `the tag is stripped, exactly like grim's own id.name() binding rule: ${call.message}`,
    );
  });

  test('force-confirm: --force is appended only for add/update, never for another subcommand', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'uninstall', { kind: 'skill', name: 'demo', status: 'uninstalled' });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    let handled: boolean;
    try {
      // Uninstall never actually produces a forceable refusal in practice
      // (grim uninstall has no --force flag at all) — this pins the argv
      // builder's own defensiveness, not a real-world scenario. A dialog
      // offering to overwrite when the subcommand can't carry --force would
      // just fail again identically, so eligibility is gated on args[0] too:
      // no dialog, no retry, fall through to the caller's plain error toast.
      handled = await offerForcedRetry(
        forceableRefusal(),
        ['uninstall', 'skill', 'demo'],
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'uninstall.json'), { force: true });
    }
    assert.strictEqual(
      handled,
      false,
      'a forceable refusal on a non-add/update subcommand falls through',
    );
    assert.strictEqual(
      dialogs.warningCalls.length,
      0,
      '--force is only ever appended for add/update',
    );
    assert.strictEqual(argvLines(stub).length, 0, 'no retry is issued for an unhandled refusal');
  });

  test('anchor-escape: shows a non-modal notice with only Show Output, never offers --force', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs('Show Output');
    fs.rmSync(stub.argvLog, { force: true });
    let handled: boolean;
    try {
      handled = await offerForcedRetry(
        anchorEscapeRefusal(),
        ['update', 'code-review'],
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
    }
    assert.strictEqual(handled, true, 'an anchor-escape refusal is handled, not a fall-through');
    assert.strictEqual(
      dialogs.warningCalls.length,
      0,
      'no modal confirm — this is a security refusal',
    );
    assert.strictEqual(dialogs.errorCalls.length, 1, 'a non-modal error notice was shown');
    const call = dialogs.errorCalls[0];
    assert.ok(call, 'the notice was shown');
    assert.strictEqual(call.options, undefined, 'non-modal: no MessageOptions object is passed');
    assert.deepStrictEqual(
      call.items,
      ['Show Output'],
      'no override control of any kind is ever offered on a security refusal',
    );
    assert.ok(
      !argvLines(stub).some((l) => l.includes('--force')),
      'a security refusal must never be retried with --force',
    );
  });

  test('anchor-escape on a scope-wide call names the scope, never empty backticks or a flag', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs('Show Output');
    try {
      // `grim install` — the one builder with neither a `--` separator nor a
      // positional. Naming it off argv used to render an empty `` pair.
      await offerForcedRetry(
        anchorEscapeRefusal(),
        installArgs(),
        'project',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
      // `grim init --registry <url>` — no separator either, but args[1] is a
      // flag, which would otherwise be presented to the user as the artifact.
      await offerForcedRetry(
        anchorEscapeRefusal(),
        initArgs({ registry: 'https://example.test/r' }),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
    }
    const [install, init] = dialogs.errorCalls.map((c) => c.message);
    assert.ok(install?.includes('the project scope'), `install names the scope: ${install}`);
    assert.ok(init?.includes('the global scope'), `init names the scope: ${init}`);
    for (const message of [install, init]) {
      assert.ok(!message?.includes('``'), `no empty backtick pair: ${message}`);
      assert.ok(!message?.includes('--registry'), `no flag presented as a name: ${message}`);
    }
  });

  test('a plain refusal (neither forceable nor anchor-escape) falls through untouched', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    const plain: FailedGrimResult = {
      ok: false,
      kind: 'error',
      code: 'data',
      exitCode: 65,
      message: 'some other refusal',
    };
    let handled: boolean;
    try {
      handled = await offerForcedRetry(
        plain,
        ['add', 'demo'],
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
    }
    assert.strictEqual(handled, false, 'the caller must fall through to its own error toast');
    assert.strictEqual(dialogs.warningCalls.length, 0);
    assert.strictEqual(dialogs.errorCalls.length, 0);
    assert.strictEqual(argvLines(stub).length, 0, 'no retry is issued for an unhandled refusal');
  });

  test('offerForcedRetry falls through untouched for a not-found result (no error kind)', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    const notFound: Extract<GrimResult<unknown>, { ok: false }> = { ok: false, kind: 'not-found' };
    let handled: boolean;
    try {
      handled = await offerForcedRetry(
        notFound,
        ['add', 'demo'],
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
    }
    assert.strictEqual(
      handled,
      false,
      'a not-found result is never a refusal offerForcedRetry can act on',
    );
    assert.strictEqual(dialogs.warningCalls.length, 0);
    assert.strictEqual(dialogs.errorCalls.length, 0);
    assert.strictEqual(argvLines(stub).length, 0);
  });

  test('force-confirm: a failed forced retry falls through to the normal error path', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'add', { error: { code: 'data', exit: 65, message: 'still refused' } });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    const lines: string[] = [];
    let handled: boolean;
    let onDoneCalled = false;
    try {
      handled = await offerForcedRetry(
        forceableRefusal(),
        addArgs('ghcr.io/grimoire-rs/code-review'),
        'global',
        api.scopes,
        recordingOutput(lines),
        async () => {
          onDoneCalled = true;
        },
      );
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.strictEqual(handled, true, 'a confirmed retry is handled even when it fails again');
    assert.ok(
      lines.some((l) => l.includes('still refused')),
      `the retry failure is logged: ${lines.join(' | ')}`,
    );
    assert.strictEqual(
      dialogs.errorCalls.length,
      1,
      'the retry failure surfaces the normal error toast',
    );
    assert.ok(
      dialogs.errorCalls[0]?.message.includes('still refused'),
      `the toast names the failure: ${dialogs.errorCalls[0]?.message}`,
    );
    assert.strictEqual(onDoneCalled, true, 'onDone still refreshes after a failed retry');
  });

  test('anchor-escape: Show Output dispatches the real grimoire.showOutput command', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs('Show Output');
    const commands = vscode.commands as unknown as {
      executeCommand: (command: string, ...rest: unknown[]) => Thenable<unknown>;
    };
    const original = commands.executeCommand;
    const dispatched: string[] = [];
    commands.executeCommand = (command: string, ...rest: unknown[]) => {
      dispatched.push(command);
      return original.call(vscode.commands, command, ...rest);
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await offerForcedRetry(
        anchorEscapeRefusal(),
        ['update', 'code-review'],
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      commands.executeCommand = original;
      dialogs.restore();
    }
    // A typo'd command id would reject (VS Code has no such command) and throw
    // out of offerForcedRetry — reaching this assertion at all is part of the
    // proof, alongside naming the exact id dispatched.
    assert.deepStrictEqual(
      dispatched,
      ['grimoire.showOutput'],
      'the real command id is dispatched, not a typo',
    );
  });

  test('precedence: a refusal carrying both forceable AND anchor-escape takes the security branch', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // If the modal ever showed, answering 'Overwrite' would wrongly confirm it —
    // the assertions below are what actually prove it never showed.
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    const both: FailedGrimResult = {
      ok: false,
      kind: 'error',
      code: 'data',
      exitCode: 65,
      reason: 'anchor-escape',
      forceable: true,
      message: 'resolved path escapes its anchor root (anchor: claude-root)',
    };
    let handled: boolean;
    try {
      handled = await offerForcedRetry(
        both,
        ['update', 'code-review'],
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
    }
    assert.strictEqual(handled, true);
    assert.strictEqual(
      dialogs.warningCalls.length,
      0,
      'no modal confirm — anchor-escape wins over forceable',
    );
    assert.strictEqual(dialogs.errorCalls.length, 1, 'the security notice was shown instead');
    assert.strictEqual(
      argvLines(stub).length,
      0,
      'a refusal tagged anchor-escape is never retried with --force, forceable or not',
    );
  });

  test('a case/whitespace variant of the anchor-escape reason still takes the security branch, never the override', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // Regression test for the byte-exact `===` comparison this pins against:
    // a spelling variant paired with forceable:true must not fall through to
    // the Overwrite modal. If it ever did, answering 'Overwrite' below would
    // wrongly confirm it — the assertions are what actually prove it never showed.
    for (const variant of ['Anchor-Escape', ' anchor-escape ']) {
      const dialogs = stubForceDialogs('Overwrite');
      fs.rmSync(stub.argvLog, { force: true });
      const spelledDifferently: FailedGrimResult = {
        ok: false,
        kind: 'error',
        code: 'data',
        exitCode: 65,
        reason: variant,
        forceable: true,
        message: 'resolved path escapes its anchor root (anchor: claude-root)',
      };
      let handled: boolean;
      try {
        handled = await offerForcedRetry(
          spelledDifferently,
          ['update', 'code-review'],
          'global',
          api.scopes,
          recordingOutput([]),
          async () => {},
        );
      } finally {
        dialogs.restore();
      }
      assert.strictEqual(handled, true, `variant ${JSON.stringify(variant)} is still handled`);
      assert.strictEqual(
        dialogs.warningCalls.length,
        0,
        `no modal confirm for reason ${JSON.stringify(variant)} — spelling must not bypass the security branch`,
      );
      assert.strictEqual(
        dialogs.errorCalls.length,
        1,
        `the security notice was shown for ${JSON.stringify(variant)}`,
      );
      assert.strictEqual(
        argvLines(stub).length,
        0,
        `reason ${JSON.stringify(variant)} must never be retried with --force`,
      );
    }
  });

  test('an unknown forceable reason still gets the Overwrite modal — the client gatekeeps on `forceable`, not on a reason allow-list', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    // Pins the design decision (declined alternative: hardcoding grim's
    // reason taxonomy into an allow-list). `forceable` is the single derived
    // signal from grim; a reason this client has never heard of must still
    // reach the confirm dialog as long as forceable:true is set and the
    // reason isn't anchor-escape. Do not "harden" this into an allow-list —
    // that would silently drop the dialog for any future forceable reason
    // until the extension ships a matching update.
    canned(stub, 'add', {
      kind: 'skill',
      name: 'code-review',
      pinned: 'y@sha256:2',
      status: 'added',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    const futureReason: FailedGrimResult = {
      ok: false,
      kind: 'error',
      code: 'data',
      exitCode: 65,
      reason: 'some-future-reason',
      forceable: true,
      message: 'a refusal grim added after this client shipped',
    };
    let handled: boolean;
    try {
      handled = await offerForcedRetry(
        futureReason,
        addArgs('ghcr.io/grimoire-rs/code-review'),
        'global',
        api.scopes,
        recordingOutput([]),
        async () => {},
      );
    } finally {
      dialogs.restore();
      restoreAddUninstall();
    }
    assert.strictEqual(handled, true, 'an unrecognized-but-forceable refusal is still handled');
    assert.strictEqual(
      dialogs.warningCalls.length,
      1,
      'the Overwrite modal is shown for an unknown reason',
    );
    assert.strictEqual(dialogs.errorCalls.length, 0, 'this is not the security branch');
    const lines = argvLines(stub);
    assert.strictEqual(lines.length, 1, `exactly one retry call: ${lines.join(' | ')}`);
    assert.ok(lines[0]?.includes('--force'), `the confirmed retry appends --force: ${lines[0]}`);
  });

  // --- force-confirm / anchor-escape host wiring (sidebar.ts / details.ts) ---
  //
  // The suite above exercises offerForcedRetry directly; these route through
  // handleMessage/onMessage instead, covering the actual call sites
  // (sidebar.ts's runActionInner, details.ts's actionInner) the way a real
  // webview message would.

  test('sidebar update wiring: a forceable refusal offers Overwrite and retries with --force', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', {
      error: {
        code: 'data',
        exit: 65,
        message: 'installed artifact was modified locally',
        reason: 'modified',
        forceable: true,
      },
    });
    canned(stub, 'update-force', {
      kind: 'skill',
      name: 'demo',
      pinned: 'y@sha256:2',
      status: 'updated',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => l.includes('--force')));
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
      fs.rmSync(path.join(stub.dir, 'update-force.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(
      updates.some((l) => updatesArtifact(l, 'demo') && !l.includes('--force')),
      `the per-name update ran first: ${updates.join(' | ')}`,
    );
    assert.ok(
      updates.some((l) => l.includes('--force')),
      `a forced retry ran: ${updates.join(' | ')}`,
    );
    assert.strictEqual(dialogs.warningCalls.length, 1, 'the Overwrite confirm was shown');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'no error toast for a confirmed forced retry');
  });

  test('sidebar update wiring: an anchor-escape refusal shows a non-modal notice, no retry', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', {
      error: {
        code: 'data',
        exit: 65,
        message: 'resolved path escapes its anchor root (anchor: claude-root)',
        reason: 'anchor-escape',
      },
    });
    const dialogs = stubForceDialogs('Show Output');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => updatesArtifact(l, 'demo')));
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    assert.strictEqual(dialogs.warningCalls.length, 0, 'no modal confirm for a security refusal');
    assert.strictEqual(dialogs.errorCalls.length, 1, 'a non-modal notice was shown');
    assert.ok(
      !argvLines(stub).some((l) => l.includes('--force')),
      'an anchor-escape refusal is never retried with --force',
    );
  });

  test('details update wiring: a forceable refusal offers Overwrite and retries with --force', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // Isolated: these drive real details actions on a shared repo, and an
    // un-isolated cache is both read from and written to by every run.
    isolateCache(api);
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
      error: {
        code: 'data',
        exit: 65,
        message: 'installed artifact was modified locally',
        reason: 'modified',
        forceable: true,
      },
    });
    canned(stub, 'update-force', {
      kind: 'skill',
      name: 'grim-usage',
      pinned: 'y@sha256:2',
      status: 'updated',
    });
    const dialogs = stubForceDialogs('Overwrite');
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
      await waitFor(() => argvLines(stub).some((l) => l.includes('--force')));
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
      fs.rmSync(path.join(stub.dir, 'update-force.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.ok(
      updates.some((l) => l.includes('--force')),
      `a forced retry ran: ${updates.join(' | ')}`,
    );
    assert.strictEqual(dialogs.warningCalls.length, 1, 'the Overwrite confirm was shown');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'no error toast for a confirmed forced retry');
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered (busy cleared) after the recovery',
    );
  });

  test('details update wiring: an anchor-escape refusal shows a non-modal notice, no retry', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // Isolated: these drive real details actions on a shared repo, and an
    // un-isolated cache is both read from and written to by every run.
    isolateCache(api);
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
      error: {
        code: 'data',
        exit: 65,
        message: 'resolved path escapes its anchor root (anchor: claude-root)',
        reason: 'anchor-escape',
      },
    });
    const dialogs = stubForceDialogs('Show Output');
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
      await waitFor(() => argvLines(stub).some((l) => updatesArtifact(l, 'grim-usage')));
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    assert.strictEqual(dialogs.warningCalls.length, 0, 'no modal confirm for a security refusal');
    assert.strictEqual(dialogs.errorCalls.length, 1, 'a non-modal notice was shown');
    assert.ok(
      !argvLines(stub).some((l) => l.includes('--force')),
      'an anchor-escape refusal is never retried with --force',
    );
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered (busy cleared) after the notice',
    );
  });

  test('details update wiring: a plain refusal (neither stale-lock, forceable, nor anchor-escape) keeps the panel error toast', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // Isolated: these drive real details actions on a shared repo, and an
    // un-isolated cache is both read from and written to by every run.
    isolateCache(api);
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
      error: { code: 'data', exit: 65, message: 'some other update failure' },
    });
    const dialogs = stubForceDialogs('Overwrite');
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
      await waitFor(() => argvLines(stub).some((l) => updatesArtifact(l, 'grim-usage')));
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    assert.strictEqual(dialogs.warningCalls.length, 0, 'no dialog for a plain refusal');
    assert.strictEqual(dialogs.errorCalls.length, 1, 'the plain error toast was shown');
    assert.ok(
      dialogs.errorCalls[0]?.message.includes('some other update failure'),
      `the toast names the failure: ${dialogs.errorCalls[0]?.message}`,
    );
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered (busy cleared) after the failure',
    );
    // A first-step failure refreshes the other views too, not just this panel.
    // The old gate ran onDidChange only when an EARLIER step had succeeded, so
    // this exact input — one step, failing — left the sidebar untouched while
    // the same failure through the sidebar host refreshed unconditionally.
    // `search` is the discriminator, not status/context: postVM rebuilds this
    // panel's own VM and spawns those two by itself either way. Only the sidebar
    // refresh onDidChange drives runs a catalog search.
    const lines = argvLines(stub);
    const failedAt = lines.findIndex((l) => updatesArtifact(l, 'grim-usage'));
    assert.ok(
      lines.slice(failedAt + 1).some((l) => l.startsWith('search')),
      `the failure still refreshed the other views: ${lines.join(' | ')}`,
    );
  });

  // --- C-018 / R-3: the click-to-vote wiring. castVote is pinned in isolation
  // --- by rating.test.ts; the panel that CALLS it was pinned nowhere, so a
  // --- message-name typo or a dropped await passed the whole suite.

  test('details vote wiring: the panel votes with the right argv and renders the ANSWER', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/rated';
    const token = 'gho_INTEGRATION_must_never_be_logged';
    canned(stub, 'search', {
      items: [{ ...searchItem(repo), rating: { up: 21, url: 'https://forge.example/d/1' } }],
    });
    canned(stub, 'describe', { error: { code: 'usage', exit: 64, message: 'no describe' } });
    // The forge DISAGREES with the request: the click was an upvote, the answer
    // is "removed" with a count nothing here could have guessed. GitLab's
    // awardEmojiToggle really does toggle, so this is the shipping case, not a
    // contrived one — and a stub that always agrees cannot tell "read the
    // answer" apart from "assume it worked". One canned doc serves both calls;
    // castVote reads only provider/host off the handshake.
    canned(stub, 'rate', {
      ref: repo,
      action: 'removed',
      up: 12,
      url: 'https://forge.example/d/1',
      provider: 'github',
      host: 'api.github.com',
      viewer_up: null,
    });

    const auth = vscode.authentication as unknown as { getAccounts: unknown; getSession: unknown };
    const window = vscode.window as unknown as { showWarningMessage: unknown };
    const originalAccounts = auth.getAccounts;
    const originalSession = auth.getSession;
    const originalWarn = window.showWarningMessage;
    let disclosures = 0;
    try {
      const account = { id: 'a', label: 'octocat' };
      auth.getAccounts = async () => [account];
      auth.getSession = async () => ({ id: 's', accessToken: token, account, scopes: [] });
      window.showWarningMessage = async () => {
        disclosures += 1;
        return 'Vote';
      };
      await api.providers.sidebar.refresh(); // loads the rated row into the catalog
      fs.rmSync(stub.argvLog, { force: true });
      const { panel, posts } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'vote', remove: false });

      // 1. Nothing is posted publicly before the user is asked (C-018).
      assert.strictEqual(disclosures, 1, 'the disclosure did not fire exactly once');

      // 2. The argv a vote actually needs: an uncredentialed handshake, then a
      //    mutation declaring the host that handshake named.
      const rates = argvLines(stub).filter((l) => l.startsWith('rate'));
      assert.strictEqual(rates.length, 2, `expected handshake + mutation: ${rates.join(' | ')}`);
      assert.ok(rates[0]?.includes('--dry-run'), `the handshake runs first: ${rates[0]}`);
      assert.ok(!rates[0]?.includes('--token-stdin'), 'the handshake asked for a credential');
      assert.ok(!rates[1]?.includes('--dry-run'), `the second call mutates: ${rates[1]}`);
      assert.ok(rates[1]?.includes('--up'), `a vote, not a retraction: ${rates[1]}`);
      // The extension owns the prompt, so grim's own must never fire.
      assert.ok(rates[1]?.includes('--yes'), `--yes missing: ${rates[1]}`);
      assert.ok(rates[1]?.includes('--token-stdin'), 'the credential did not go over stdin');
      assert.ok(
        rates[1]?.includes('--token-host api.github.com'),
        `the piped credential declared no host: ${rates[1]}`,
      );
      assert.ok(!fs.readFileSync(stub.argvLog, 'utf8').includes(token), 'the token reached argv');

      // 3. R-3: the panel renders what the forge SAID, not what was clicked. A
      //    wiring that echoed the request would read 'voted' and 22 here.
      const rated = posts.filter((vm) => vm.repo === repo && vm.rating);
      const last = rated[rated.length - 1];
      assert.ok(last, 'the panel never re-rendered after the vote');
      assert.strictEqual(last.rating?.vote, 'not-voted', 'the panel echoed the click');
      assert.strictEqual(last.rating?.up, 12, 'the panel invented a count');
    } finally {
      auth.getAccounts = originalAccounts;
      auth.getSession = originalSession;
      window.showWarningMessage = originalWarn;
      canned(stub, 'search', { items: [] });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // --- refused-update wiring (grim >= 0.13.0's normal-report refusal) ---
  //
  // The refusal moved off the error document and onto the report: exit 65 with
  // `{"items":[…]}` and `refused: true` on the row. parseReport reads that as a
  // plain success, so before offerRefusedRetry both hosts showed the user
  // NOTHING — the branches above are all on the `!ok` path.

  /** grim >= 0.13.0's per-artifact refused update: a normal report, one row,
   *  `action` still reporting the lock diff because the pin did roll forward. */
  function refusedReport(name: string): unknown {
    return {
      items: [
        {
          kind: 'skill',
          name,
          old: 'sha256:old',
          new: 'sha256:new',
          action: 'updated',
          reaped_clients: [],
          kept_modified_clients: [],
          refused: true,
        },
      ],
    };
  }

  test('sidebar update wiring: a refused report offers Overwrite and retries with --force', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', refusedReport('demo'));
    const restoreExit = cannedExit(stub, 'update-name', 65);
    canned(stub, 'update-force', {
      kind: 'skill',
      name: 'demo',
      pinned: 'y@sha256:2',
      status: 'updated',
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => l.includes('--force')));
    } finally {
      dialogs.restore();
      restoreExit();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
      fs.rmSync(path.join(stub.dir, 'update-force.json'), { force: true });
    }
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.strictEqual(dialogs.warningCalls.length, 1, 'the Overwrite confirm was shown');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'no error toast — the report parsed as ok');
    assert.ok(
      updates.some((l) => l === 'update --force --format json -- demo --global'),
      `the same argv is reissued with --force: ${updates.join(' | ')}`,
    );
    const call = dialogs.warningCalls[0];
    assert.strictEqual(call?.options?.modal, true, 'the confirm is modal');
    assert.deepStrictEqual(call?.items, ['Overwrite'], 'Overwrite is the only offered action');
    const detail = call?.options?.detail ?? '';
    assert.ok(detail.includes('demo'), `the detail names the artifact: ${detail}`);
    assert.ok(
      detail.includes('lock pin moved on'),
      `the detail says the pin moved — the half of the split outcome the old wording denied: ${detail}`,
    );
    assert.ok(
      detail.includes('pruned lock entries and stale client output'),
      `--force on an update authorizes more than the overwrite, and says so: ${detail}`,
    );
  });

  test('sidebar update wiring: declining a refused report runs no second call and still refreshes', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', refusedReport('demo'));
    const restoreExit = cannedExit(stub, 'update-name', 65);
    const dialogs = stubForceDialogs(undefined); // Cancel / dismiss
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => l.startsWith('search')));
    } finally {
      dialogs.restore();
      restoreExit();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    const lines = argvLines(stub);
    assert.strictEqual(dialogs.warningCalls.length, 1, 'the confirm was still offered');
    assert.ok(!lines.some((l) => l.includes('--force')), 'declining issues no second grim call');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'declining shows no error toast');
    // The refusal is PARTIAL: the pin rolled forward whatever the user answers,
    // so the views must repaint even on a decline. This is why offerRefusedRetry
    // takes no onDone — the host's own trailing refresh owns it.
    const refusedAt = lines.findIndex((l) => updatesArtifact(l, 'demo'));
    assert.ok(
      lines.slice(refusedAt + 1).some((l) => l.startsWith('search')),
      `a declined refusal still refreshes the pin that moved: ${lines.join(' | ')}`,
    );
  });

  test('sidebar update wiring: a report with no refused row never prompts', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    canned(stub, 'update-name', {
      items: [
        {
          kind: 'skill',
          name: 'demo',
          old: 'sha256:old',
          new: 'sha256:new',
          action: 'updated',
          reaped_clients: [],
          kept_modified_clients: [],
          refused: false,
        },
      ],
    });
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.handleMessage({
        type: 'update',
        kind: 'skill',
        name: 'demo',
        scope: 'global',
      });
      await waitFor(() => argvLines(stub).some((l) => updatesArtifact(l, 'demo')));
    } finally {
      dialogs.restore();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
    }
    assert.strictEqual(dialogs.warningCalls.length, 0, 'a clean update prompts nothing');
    assert.ok(
      !argvLines(stub).some((l) => l.includes('--force')),
      'and never forces anything on its own',
    );
  });

  test('details update wiring: a refused report offers Overwrite and retries with --force', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // Isolated like its neighbours: real details actions on a shared repo.
    isolateCache(api);
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
    canned(stub, 'update-name', refusedReport('grim-usage'));
    const restoreExit = cannedExit(stub, 'update-name', 65);
    canned(stub, 'update-force', {
      kind: 'skill',
      name: 'grim-usage',
      pinned: 'y@sha256:2',
      status: 'updated',
    });
    const dialogs = stubForceDialogs('Overwrite');
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
      await waitFor(() => argvLines(stub).some((l) => l.includes('--force')));
    } finally {
      dialogs.restore();
      restoreExit();
      fs.rmSync(path.join(stub.dir, 'update-name.json'), { force: true });
      fs.rmSync(path.join(stub.dir, 'update-force.json'), { force: true });
      uncan(stub, 'describe');
    }
    // Asserted in both hosts, not just one: they have drifted on identical
    // input before (details.ts's post-failure refresh gate).
    const updates = argvLines(stub).filter((l) => l.startsWith('update'));
    assert.strictEqual(dialogs.warningCalls.length, 1, 'the Overwrite confirm was shown');
    assert.strictEqual(dialogs.errorCalls.length, 0, 'no error toast — the report parsed as ok');
    assert.ok(
      updates.some((l) => l === 'update --force --format json -- grim-usage --global'),
      `the same argv is reissued with --force: ${updates.join(' | ')}`,
    );
    const detail = dialogs.warningCalls[0]?.options?.detail ?? '';
    assert.ok(detail.includes('grim-usage'), `the detail names the artifact: ${detail}`);
    assert.ok(
      detail.includes('pruned lock entries and stale client output'),
      `and discloses what --force additionally authorizes on an update: ${detail}`,
    );
    assert.ok(
      posted.some((m) => m.type === 'artifact'),
      'the panel re-rendered (busy cleared) after the recovery',
    );
  });

  test('a scope-wide refused update is never offered a one-click Overwrite', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const dialogs = stubForceDialogs('Overwrite');
    fs.rmSync(stub.argvLog, { force: true });
    let handled: boolean;
    try {
      // A BARE `grim update` — no positional. Forcing it would discard the
      // user's edits to every other modified artifact in the scope while the
      // dialog named one. Update All routes to offerModifiedRefusal instead.
      handled = await offerRefusedRetry(
        { items: [{ kind: 'skill', name: 'demo', action: 'updated', refused: true }] },
        updateArgs(),
        'global',
        api.scopes,
        recordingOutput([]),
      );
    } finally {
      dialogs.restore();
    }
    assert.strictEqual(handled, false, 'declined, so the caller keeps its own handling');
    assert.strictEqual(dialogs.warningCalls.length, 0, 'no scope-wide Overwrite confirm');
    assert.strictEqual(argvLines(stub).length, 0, 'and no forced retry');
  });

  test('updateAll: a refused row is named from the report, not from the snapshot', async () => {
    // The assertion that pins the names to grim's own rows: `grim status`
    // reports NOTHING modified here, so the cachedSnapshot() heuristic — which
    // is all the error-document path ever had — would name no artifact at all.
    canned(stub, 'context', contextDoc({ config_exists: true }));
    canned(stub, 'status', { items: [] });
    canned(stub, 'update', {
      items: [
        {
          kind: 'skill',
          name: 'clean',
          old: 'sha256:a',
          new: 'sha256:b',
          action: 'updated',
          reaped_clients: [],
          kept_modified_clients: [],
          refused: false,
        },
        {
          kind: 'rule',
          name: 'edited',
          old: 'sha256:c',
          new: 'sha256:d',
          action: 'updated',
          reaped_clients: [],
          // Co-occurring on the refused row: suppressed, so the user gets one
          // notification for one modified file, not two.
          kept_modified_clients: ['claude'],
          refused: true,
        },
      ],
    });
    const restoreExit = cannedExit(stub, 'update', 65);
    const window = vscode.window as unknown as {
      showErrorMessage: unknown;
      showInformationMessage: unknown;
    };
    const originalError = window.showErrorMessage;
    const originalInfo = window.showInformationMessage;
    const errors: string[] = [];
    const infos: string[] = [];
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    window.showInformationMessage = async (message: string) => {
      infos.push(message);
      return undefined;
    };
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await vscode.commands.executeCommand('grimoire.updateAll');
    } finally {
      window.showErrorMessage = originalError;
      window.showInformationMessage = originalInfo;
      restoreExit();
      canned(stub, 'context', contextDoc());
      canned(stub, 'update', { items: [] });
    }
    // Exit 65 is not a failure here: the run completed, so both scopes still go.
    const updates = argvLines(stub).filter(isFullUpdate);
    assert.strictEqual(updates.length, 2, `both scopes still update: ${updates.join(' | ')}`);
    assert.strictEqual(errors.length, 2, `one dialog per refusing scope: ${errors.join(' | ')}`);
    assert.ok(
      errors.every((m) => m.includes('edited')),
      `each names the refused artifact grim reported: ${errors.join(' | ')}`,
    );
    assert.ok(
      errors.every((m) => !m.includes('clean')),
      `and never the rows that updated fine: ${errors.join(' | ')}`,
    );
    assert.ok(
      errors.every((m) => !m.includes('stopped')),
      `never "stopped" — under 0.13 the run continued and the pin moved: ${errors.join(' | ')}`,
    );
    assert.ok(
      !infos.some((m) => m.includes('kept locally-modified client output')),
      `the kept-modified toast is suppressed for a refused row: ${infos.join(' | ')}`,
    );
  });

  test('a nonzero exit code alone never demotes a normal report', async () => {
    // The one claim the <cmd>.exit companion exists for. Detection reads the
    // payload, never the code — but runJson's execFile callback DOES see a real
    // nonzero exit as an error, and it special-cases only ENOENT. Pinned end to
    // end through a stub that actually exits 65, since every other "exit 65" in
    // this suite is fiction parseReport re-derives from the JSON body.
    const api = await activateExtension();
    canned(stub, 'update', refusedReport('demo'));
    const restoreExit = cannedExit(stub, 'update', 65);
    try {
      const result = await api.scopes.run<ItemsEnvelope<UpdateEntry>>(updateArgs(), 'global');
      assert.ok(result.ok, 'a real exit 65 with a report body is still an ok result');
      assert.deepStrictEqual(refusedNames(result.value), ['demo']);
    } finally {
      restoreExit();
      canned(stub, 'update', { items: [] });
    }
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
    // Isolated like its neighbours. Without this the assertions run against the
    // runner profile's persistent cache (.vscode-test/user-data/…/globalStorage),
    // which survives across runs and carries real entries from F5 sessions — a
    // genuine grim-usage entry merges its own tags in. It passed only because
    // the post-action hook used to DELETE that entry; the hook expires instead
    // now, so the leak shows.
    isolateCache(api);
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
    assert.ok(lines.some((l) => invokes(l, 'fetch', 'ghcr.io/grimoire-rs/skills/grim-usage')));
    assert.ok(lines.some((l) => l.startsWith('describe')));
  });

  test('v2 has_description:false skips the companion entirely (no --description fetch)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/plain';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:1',
      kind: 'skill',
      name: 'plain',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'rich',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'rich', has_description: true, digest: 'sha256:art1' }),
    );
    // One report, every member inline; README + CHANGELOG both carry image refs.
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
      files: [
        {
          path: 'README.md',
          size: 40,
          content: '# Rich\n\n![logo](./logo.png)\n\ninline-readme-marker',
        },
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

  test('a failed companion re-probe keeps the cached logo and marks the entry incomplete', async function () {
    // The reported bug: logos show after opening the details panel, then vanish
    // from the browse list. A re-probe whose companion fetch failed used to
    // overwrite the good snapshot with nulls AND stamp it fresh for six hours.
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/flaky';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'flaky',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'flaky', has_description: true, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
      files: [{ path: 'logo.png', size: 4, content: 'QUJD', encoding: 'base64' }],
    });
    try {
      await api.providers.details.buildVM(repo);
      const cache = new DetailsCache(dir);
      const good = await cache.load(repo);
      assert.strictEqual(good?.logoUri, 'data:image/png;base64,QUJD', 'logo cached first');
      assert.strictEqual(good?.complete, true, 'a whole probe is complete');

      // The companion tag stops answering; everything else still works.
      canned(stub, 'fetch-description', {
        error: { code: 'network', exit: 75, message: 'registry unreachable', retryable: true },
      });
      await api.providers.details.prefetchInto(repo);
      const after = await cache.load(repo);
      assert.strictEqual(after?.logoUri, good?.logoUri, 'logo NOT withdrawn by a failed probe');
      assert.strictEqual(after?.complete, false, 'entry marked incomplete');
      assert.strictEqual(after?.artifactDigest, null, 'no digest to short-circuit a retry on');
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-description.json'), { force: true });
    }
  });

  // A1 / C-002 — the eight-row contentUnchanged table. Each row seeds one cache
  // entry, cans the live describe (plus whatever the companion digest probe
  // would answer) and drives the background sweep, then reads the outcome off
  // the stub's argv log: a content fetch means the full pipeline ran
  // ("changed"), none means the metadata-only short circuit took it
  // ("unchanged"). The probe count is asserted on every row, because the return
  // value alone cannot tell a short circuit that skipped the probe from one that
  // ran it and ignored the answer — rows 5-8 must spawn nothing at all.
  const contentUnchangedRows: Array<{
    row: number;
    why: string;
    cachedArtifact: string | null;
    cachedCompanion: string | null;
    liveDigest: string;
    hasDescription: boolean;
    /** What the companion digest probe answers; null = it fails to run. */
    probeAnswer: string | null;
    expected: 'unchanged' | 'changed';
    probes: number;
  }> = [
    {
      row: 1,
      why: 'both digests still match → unchanged',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: 'sha256:comp1',
      liveDigest: 'sha256:art1',
      hasDescription: true,
      probeAnswer: 'sha256:comp1',
      expected: 'unchanged',
      probes: 1,
    },
    {
      row: 2,
      why: 'a FAILED companion probe with no cached companion digest → changed (H2: null proved nothing)',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: null,
      liveDigest: 'sha256:art1',
      hasDescription: true,
      probeAnswer: null,
      expected: 'changed',
      probes: 1,
    },
    {
      row: 3,
      why: 'a FAILED companion probe against a cached companion digest → changed',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: 'sha256:comp1',
      liveDigest: 'sha256:art1',
      hasDescription: true,
      probeAnswer: null,
      expected: 'changed',
      probes: 1,
    },
    {
      row: 4,
      why: 'a companion digest that moved → changed',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: 'sha256:comp1',
      liveDigest: 'sha256:art1',
      hasDescription: true,
      probeAnswer: 'sha256:comp2',
      expected: 'changed',
      probes: 1,
    },
    {
      row: 5,
      why: 'no companion and none cached (the common case) → unchanged, zero probes',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: null,
      liveDigest: 'sha256:art1',
      hasDescription: false,
      probeAnswer: 'sha256:comp1',
      expected: 'unchanged',
      probes: 0,
    },
    {
      row: 6,
      why: 'a companion removed upstream (cached digest, none live) → changed, zero probes',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: 'sha256:comp1',
      liveDigest: 'sha256:art1',
      hasDescription: false,
      probeAnswer: 'sha256:comp1',
      expected: 'changed',
      probes: 0,
    },
    {
      row: 7,
      why: 'a null cached artifact digest → changed before any probe',
      cachedArtifact: null,
      cachedCompanion: 'sha256:comp1',
      liveDigest: 'sha256:art1',
      hasDescription: true,
      probeAnswer: 'sha256:comp1',
      expected: 'changed',
      probes: 0,
    },
    {
      row: 8,
      why: 'an artifact digest that moved → changed before any probe',
      cachedArtifact: 'sha256:art1',
      cachedCompanion: 'sha256:comp1',
      liveDigest: 'sha256:art2',
      hasDescription: true,
      probeAnswer: 'sha256:comp1',
      expected: 'changed',
      probes: 0,
    },
  ];

  for (const row of contentUnchangedRows) {
    test(`A1 / C-002 row ${row.row}: ${row.why}`, async function () {
      this.timeout(20000);
      const api = await activateExtension();
      const dir = isolateCache(api);
      const name = `cu-row${row.row}`;
      const repo = `ghcr.io/grimoire-rs/skills/${name}`;
      const cache = new DetailsCache(dir);
      // No `complete` key: a legacy entry, so an unchanged row also shows the
      // metadata-only writer promoting it off the short window (C-009).
      await cache.save(repo, {
        version: CACHE_VERSION,
        repo,
        artifactDigest: row.cachedArtifact,
        companionDigest: row.cachedCompanion,
        savedAt: new Date().toISOString(),
        describe: null,
        fetch: null,
        readme: 'cached-readme-marker',
        logoUri: null,
        changelog: null,
      });
      canned(
        stub,
        'describe',
        describeDoc(repo, { name, has_description: row.hasDescription, digest: row.liveDigest }),
      );
      canned(stub, 'fetch', {
        ref: `${repo}:latest`,
        digest: row.liveDigest,
        kind: 'skill',
        name,
        vendor: 'canonical',
        content: '# Descriptor',
        files: [],
      });
      // Canned on every row, including the four that must never ask: a probe
      // that fires anyway then gets a plausible answer instead of falling
      // through to the artifact fetch, so the count is the only thing that moves.
      canned(
        stub,
        'fetch-desc-digest',
        row.probeAnswer === null
          ? { error: { code: 'network', exit: 75, message: 'registry unreachable' } }
          : { ref: `${repo}:__grimoire`, digest: row.probeAnswer },
      );
      // What the full pipeline gets when a row reaches it.
      canned(stub, 'fetch-description', {
        ref: `${repo}:__grimoire`,
        digest: 'sha256:comp2',
        kind: 'desc',
        files: [{ path: 'README.md', size: 20, content: 'fresh-readme-marker' }],
      });
      fs.rmSync(stub.argvLog, { force: true });
      try {
        await api.providers.details.prefetchInto(repo);
        const fetches = argvLines(stub).filter((l) => l.startsWith('fetch'));
        const probes = fetches.filter((l) => l.includes('--digest-only'));
        const content = fetches.filter((l) => !l.includes('--digest-only'));
        assert.strictEqual(
          probes.length,
          row.probes,
          `companion digest probes spawned: ${fetches.join(' | ')}`,
        );
        const after = await cache.load(repo);
        if (row.expected === 'unchanged') {
          assert.strictEqual(content.length, 0, `no content fetch: ${fetches.join(' | ')}`);
          assert.strictEqual(after?.readme, 'cached-readme-marker', 'cached content kept');
          assert.strictEqual(after?.complete, true, 'a digest match is proof of completeness');
        } else {
          assert.ok(content.length > 0, `the full pipeline ran: ${fetches.join(' | ')}`);
        }
      } finally {
        for (const f of ['fetch-desc-digest', 'fetch-description']) {
          fs.rmSync(path.join(stub.dir, `${f}.json`), { force: true });
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('A2 / S-001: a partly-failed revalidate keeps PAINTING the cached README and logo', async function () {
    // The shape whose absence let B1 ship: the cache was repaired by the fold
    // and the open panel was repainted from the raw probe, so the user watched
    // the README and logo vanish from a panel that had just shown them. Every
    // assertion here is on what reached the webview, not on what is on disk.
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/keeps-paint';
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'keeps-paint',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'keeps-paint', has_description: true, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
      files: [
        { path: 'README.md', size: 20, content: 'cached-readme-marker' },
        { path: 'logo.png', size: 4, content: 'QUJD', encoding: 'base64' },
      ],
    });
    try {
      await api.providers.details.buildVM(repo); // a complete entry: README + logo
      // The artifact rolls forward (so the revalidate takes the full pipeline)
      // and the companion tag stops answering (so the fresh probe carries nulls
      // for both docs).
      canned(
        stub,
        'describe',
        describeDoc(repo, {
          name: 'keeps-paint',
          has_description: true,
          digest: 'sha256:art2',
          tags: ['1.0.0', '2.0.0', 'latest'],
        }),
      );
      canned(stub, 'fetch', {
        ref: `${repo}:latest`,
        digest: 'sha256:art2',
        kind: 'skill',
        name: 'keeps-paint',
        vendor: 'canonical',
        content: '# Descriptor',
        files: [],
      });
      canned(stub, 'fetch-description', {
        error: { code: 'network', exit: 75, message: 'registry unreachable' },
      });
      const { panel, posts, revalidates } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.match(
        posts[0]?.readmeMarkdown ?? '',
        /cached-readme-marker/,
        'the panel opened showing the cached README',
      );
      const last = posts[posts.length - 1];
      // The new tag pins this to the repost the partly-failed probe produced —
      // without it, an unrelated install-row repost of the untouched cached
      // entry would satisfy the content assertions below for the wrong reason.
      assert.ok(last?.tags?.includes('2.0.0'), `the last post is the fresh one: ${last?.tags}`);
      assert.match(
        last?.readmeMarkdown ?? '',
        /cached-readme-marker/,
        'the README the panel already showed is still painted',
      );
      assert.strictEqual(
        last?.logoUri,
        'data:image/png;base64,QUJD',
        'the logo the panel already showed is still painted',
      );
      assert.deepStrictEqual(
        revalidates,
        ['checking', 'done'],
        'a partly-failed probe settles done — the content is whole',
      );
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-description.json'), { force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('A3 / S-002: an incomplete retry that recovers a logo reposts it', async function () {
    // Both the cached entry and the retry are incomplete, so BOTH carry a null
    // artifactDigest: the old digest-comparison repost gate compared null to
    // null, called it unchanged and left the worse paint on screen while the
    // cache quietly improved. paintSignature compares what the user sees.
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/recovers';
    const cache = new DetailsCache(dir);
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'recovers', has_description: false, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'recovers',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [
        { path: 'logo.png', size: 70 },
        { path: 'CHANGELOG.md', size: 12 },
      ],
    });
    const flaky = { error: { code: 'network', exit: 75, message: 'flaky' } };
    canned(stub, 'fetch-logo', flaky);
    canned(stub, 'fetch-changelog', flaky);
    try {
      await api.providers.details.buildVM(repo);
      const before = await cache.load(repo);
      assert.strictEqual(before?.logoUri, null, 'the first probe missed the logo');
      assert.strictEqual(before?.artifactDigest, null, 'an incomplete probe pins no digest');
      // The logo comes back; the changelog still fails, so this retry is
      // incomplete too — and describe/fetch are byte-identical to the cached
      // ones, so the logo is the ONLY thing that differs.
      canned(stub, 'fetch-logo', {
        ref: `${repo}:latest`,
        digest: 'sha256:art1',
        kind: 'skill',
        name: 'recovers',
        vendor: 'canonical',
        path: 'logo.png',
        content: LOGO_B64,
        encoding: 'base64',
      });
      const { panel, posts, revalidates } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(posts.length >= 2, 'the recovered logo triggered a repost');
      assert.strictEqual(posts[0]?.logoUri ?? null, null, 'the cached paint had no logo');
      assert.strictEqual(
        posts[posts.length - 1]?.logoUri,
        `data:image/png;base64,${LOGO_B64}`,
        'the recovered logo reached the panel',
      );
      const after = await cache.load(repo);
      assert.strictEqual(after?.complete, false, 'still incomplete — the changelog is still gone');
      assert.strictEqual(after?.artifactDigest, null, 'so it stays on the short retry window');
      assert.deepStrictEqual(revalidates, ['checking', 'done']);
    } finally {
      for (const f of ['fetch-logo', 'fetch-changelog']) {
        fs.rmSync(path.join(stub.dir, `${f}.json`), { force: true });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A5 / C-004: complete is true exactly when artifactDigest is not null', async function () {
    // The third case of the invariant — a folded entry is never complete — is
    // the failed-companion test above, which asserts complete:false with a null
    // digest after a merge.
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const cache = new DetailsCache(dir);
    const whole = 'ghcr.io/grimoire-rs/skills/whole-probe';
    canned(
      stub,
      'describe',
      describeDoc(whole, { name: 'whole-probe', has_description: false, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch', {
      ref: `${whole}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'whole-probe',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    try {
      await api.providers.details.buildVM(whole);
      const good = await cache.load(whole);
      assert.strictEqual(good?.complete, true, 'a probe that resolved everything is complete');
      assert.strictEqual(good?.artifactDigest, 'sha256:art1', 'and pins the digest it saw');

      // grim types FetchResult.digest as a string, but the extension never
      // assumes a field is present. An entry with no digest has nothing a later
      // revalidate could short-circuit on, so calling it complete would park
      // unverifiable content on the six-hour window.
      const digestless = 'ghcr.io/grimoire-rs/skills/no-digest';
      canned(
        stub,
        'describe',
        describeDoc(digestless, {
          name: 'no-digest',
          has_description: false,
          digest: 'sha256:art1',
        }),
      );
      canned(stub, 'fetch', {
        ref: `${digestless}:latest`,
        kind: 'skill',
        name: 'no-digest',
        vendor: 'canonical',
        content: '# Descriptor',
        files: [],
      });
      await api.providers.details.buildVM(digestless);
      const entry = await cache.load(digestless);
      assert.strictEqual(entry?.artifactDigest, null, 'no digest to pin');
      assert.strictEqual(entry?.complete, false, 'and therefore never complete');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A6 / C-010+C-011+C-012: a probe that failed outright cools down; forget clears it', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/cooling';
    const down = { error: { code: 'network', exit: 75, message: 'registry unreachable' } };
    canned(stub, 'describe', down);
    canned(stub, 'fetch', down);
    try {
      await api.providers.details.prefetchInto(repo);
      assert.strictEqual(
        await new DetailsCache(dir).load(repo),
        null,
        'a total failure writes no entry',
      );
      // Nothing on disk to age, so without a cooldown the very next viewport
      // report re-queues this repo — and under a 429 the retries are what keep
      // the 429 coming.
      assert.strictEqual(
        await api.providers.details.isFresh(repo),
        true,
        'the sweep skips a cooling repo',
      );
      // A cooldown that silenced something the user just asked for would be a
      // bug, not a saving: only the sweep consults isFresh.
      fs.rmSync(stub.argvLog, { force: true });
      const { panel } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(
        argvLines(stub).some((l) => invokes(l, 'describe', repo)),
        'a user-initiated open probes immediately regardless',
      );
      assert.strictEqual(
        await api.providers.details.isFresh(repo),
        true,
        'that open failed too, so the repo is still cooling',
      );
      await api.providers.details.expire(repo);
      assert.strictEqual(
        await api.providers.details.isFresh(repo),
        false,
        'forget clears the cooldown — the next sweep probes again',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A7 / C-009: a metadata-only revalidate stamps complete, promoting a legacy entry', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/legacy-entry';
    const cache = new DetailsCache(dir);
    // An entry written before the `complete` field existed: no verdict, so it
    // reads incomplete and re-arms the 10-minute window on every single visit.
    await cache.save(repo, {
      version: CACHE_VERSION,
      repo,
      artifactDigest: 'sha256:art1',
      companionDigest: null,
      savedAt: new Date().toISOString(),
      describe: describeDoc(repo, {
        name: 'legacy-entry',
        has_description: false,
        digest: 'sha256:art1',
      }) as unknown as DescribeResult,
      fetch: null,
      readme: 'legacy-readme-marker',
      logoUri: null,
      changelog: null,
    });
    assert.strictEqual((await cache.load(repo))?.complete, undefined, 'seeded with no verdict');
    // Same manifest digest, one new tag → the metadata-only branch.
    canned(
      stub,
      'describe',
      describeDoc(repo, {
        name: 'legacy-entry',
        has_description: false,
        digest: 'sha256:art1',
        tags: ['1.0.0', '1.1.0', 'latest'],
      }),
    );
    try {
      const { panel } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      const after = await cache.load(repo);
      assert.strictEqual(after?.complete, true, 'the digest match is the proof');
      assert.strictEqual(after?.readme, 'legacy-readme-marker', 'content untouched');
      // The verdict is what buys the six-hour window: aged an hour, this entry
      // now reads fresh where an incomplete one is re-queued in minutes.
      const name = fs.readdirSync(dir).find((f) => f.endsWith('.json')) as string;
      const file = path.join(dir, name);
      const aged = {
        ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>),
        savedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };
      fs.writeFileSync(file, JSON.stringify(aged));
      assert.strictEqual(
        await api.providers.details.isFresh(repo),
        true,
        'promoted onto the six-hour window',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('C-006: an action keeps the cache, so a partly-failed post-action probe holds content', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/keeps-content';
    const cache = new DetailsCache(dir);
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'keeps-content',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'keeps-content', has_description: true, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
      files: [
        { path: 'README.md', size: 30, content: 'post-action-readme-marker' },
        { path: 'logo.png', size: 4, content: 'QUJD', encoding: 'base64' },
      ],
    });
    canned(stub, 'uninstall', { kind: 'skill', name: 'keeps-content', status: 'removed' });
    try {
      await api.providers.details.buildVM(repo);
      assert.strictEqual(
        (await cache.load(repo))?.logoUri,
        'data:image/png;base64,QUJD',
        'content cached before the action',
      );
      // Now the companion tag stops answering — everything else still works, so
      // the post-action probe is a PARTIAL failure, not a total one.
      canned(stub, 'fetch-description', {
        error: { code: 'network', exit: 75, message: 'registry unreachable', retryable: true },
      });
      const { panel, posts } = fakePanel();
      await api.providers.details.onMessage(repo, panel, {
        type: 'uninstall',
        kind: 'skill',
        name: 'keeps-content',
        scope: 'global',
      });
      const vm = posts.at(-1);
      assert.ok(vm, 'the panel was repainted after the action');
      // Evicting the entry first — which this path used to do — leaves
      // mergeEntry nothing to fold, and both of these come back null.
      assert.match(vm.readmeMarkdown ?? '', /post-action-readme-marker/);
      assert.strictEqual(vm.logoUri, 'data:image/png;base64,QUJD', 'logo survived the action');
      assert.strictEqual((await cache.load(repo))?.complete, false, 'and it knows it is partial');
    } finally {
      uncan(stub, 'describe', 'fetch', 'fetch-description', 'uninstall');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('expire keeps the content and only ages the entry out', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/expiring';
    const cache = new DetailsCache(dir);
    await cache.save(repo, {
      version: CACHE_VERSION,
      repo,
      artifactDigest: 'sha256:a',
      companionDigest: null,
      savedAt: new Date().toISOString(),
      describe: null,
      fetch: null,
      readme: 'expire-readme-marker',
      logoUri: 'data:image/png;base64,BBBB',
      changelog: null,
      complete: true,
    });
    try {
      assert.strictEqual(await api.providers.details.isFresh(repo), true, 'fresh to begin with');
      await api.providers.details.expire(repo);
      // Stale, so the next sweep re-resolves it — the whole point of the hook.
      assert.strictEqual(await api.providers.details.isFresh(repo), false, 'aged out');
      // But still present, so a re-probe that partly fails has a merge base.
      const after = await cache.load(repo);
      assert.strictEqual(after?.readme, 'expire-readme-marker', 'content kept');
      assert.strictEqual(after?.logoUri, 'data:image/png;base64,BBBB', 'logo kept');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isFresh trusts a complete snapshot for hours, an incomplete one for minutes', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const dir = isolateCache(api);
    const cache = new DetailsCache(dir);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const entry = (repo: string, complete: boolean, savedAt = anHourAgo): DetailsCacheEntry => ({
      version: CACHE_VERSION,
      repo,
      artifactDigest: 'sha256:a',
      companionDigest: null,
      savedAt,
      describe: null,
      fetch: null,
      readme: null,
      logoUri: null,
      changelog: null,
      complete,
    });
    await cache.save('ghcr.io/o/skills/whole', entry('ghcr.io/o/skills/whole', true));
    await cache.save('ghcr.io/o/skills/partial', entry('ghcr.io/o/skills/partial', false));
    // Edge 5: a future-dated savedAt (a clock skew, a hand-edited file) used to
    // read fresh until the clock caught up — immortal for as long as the skew.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await cache.save('ghcr.io/o/skills/future', entry('ghcr.io/o/skills/future', true, tomorrow));
    assert.strictEqual(await api.providers.details.isFresh('ghcr.io/o/skills/whole'), true);
    assert.strictEqual(
      await api.providers.details.isFresh('ghcr.io/o/skills/partial'),
      false,
      'a failed probe is re-queued in minutes, not hours',
    );
    assert.strictEqual(
      await api.providers.details.isFresh('ghcr.io/o/skills/future'),
      false,
      'a future-dated entry reads stale, not immortal',
    );
  });

  test('describe without has_description fetches no companion — in-tree content only', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/older';
    // Artifact ships an in-tree README (fetched via --path); no companion exists.
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:1',
      kind: 'skill',
      name: 'older',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [{ path: 'older/README.md', size: 20 }],
    });
    canned(stub, 'fetch-readme', {
      ref: `${repo}:latest`,
      digest: 'sha256:1',
      kind: 'skill',
      name: 'older',
      vendor: 'canonical',
      content: 'in-tree-readme-marker',
      files: [],
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'warm',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    // describe's manifest digest matches the cached fetch digest (the warm probe
    // compares live describe.digest against the cached artifact digest).
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'warm', has_description: true, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
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
      assert.ok(
        lines.some((l) => l.startsWith('describe')),
        'a live describe probe ran',
      );
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'moved',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'moved', has_description: true, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
      files: [{ path: 'README.md', size: 20, content: 'old-readme-marker' }],
    });
    canned(stub, 'fetch-desc-digest', { ref: `${repo}:__grimoire`, digest: 'sha256:comp1' });
    try {
      await api.providers.details.buildVM(repo); // populate cache at art1/comp1
      // The artifact rolled forward: describe now reports the art2 manifest digest,
      // and the content fetches carry new digests + a new README.
      canned(
        stub,
        'describe',
        describeDoc(repo, { name: 'moved', has_description: true, digest: 'sha256:art2' }),
      );
      canned(stub, 'fetch', {
        ref: `${repo}:latest`,
        digest: 'sha256:art2',
        kind: 'skill',
        name: 'moved',
        vendor: 'canonical',
        content: '# Descriptor',
        files: [],
      });
      canned(stub, 'fetch-description', {
        ref: `${repo}:__grimoire`,
        digest: 'sha256:comp2',
        kind: 'desc',
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'flip',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    // First: no companion.
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'flip', has_description: false, digest: 'sha256:art1' }),
    );
    try {
      await api.providers.details.buildVM(repo);
      // Companion published later; the artifact manifest is untouched (art1).
      canned(
        stub,
        'describe',
        describeDoc(repo, { name: 'flip', has_description: true, digest: 'sha256:art1' }),
      );
      canned(stub, 'fetch-description', {
        ref: `${repo}:__grimoire`,
        digest: 'sha256:comp1',
        kind: 'desc',
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'tagged',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, {
        name: 'tagged',
        has_description: false,
        digest: 'sha256:art1',
        tags: ['1.0.0', 'latest'],
      }),
    );
    try {
      await api.providers.details.buildVM(repo);
      // Same manifest digest, but a new tag appeared in describe.
      canned(
        stub,
        'describe',
        describeDoc(repo, {
          name: 'tagged',
          has_description: false,
          digest: 'sha256:art1',
          tags: ['1.0.0', '1.1.0', 'latest'],
        }),
      );
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'emptyreadme',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'emptyreadme', has_description: true, digest: 'sha256:art1' }),
    );
    // README member ships NO content (omit-empty) — must not TypeError.
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
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
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'broken',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'broken', has_description: true, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch-description', {
      ref: `${repo}:__grimoire`,
      digest: 'sha256:comp1',
      kind: 'desc',
      files: [{ path: 'README.md', size: 20, content: 'cached-readme-marker' }],
    });
    try {
      await api.providers.details.buildVM(repo); // populate cache
      // Second open: describe reports a changed digest (forces the full pipeline),
      // but the content fetch now fails → entry null → keep-cached + failed.
      canned(
        stub,
        'describe',
        describeDoc(repo, { name: 'broken', has_description: true, digest: 'sha256:art2' }),
      );
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
      ref: 'x:latest',
      digest: 'sha256:1',
      kind: 'skill',
      name: 'x',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    fs.rmSync(stub.argvLog, { force: true });
    try {
      await api.providers.sidebar.refresh();
      await waitFor(() => {
        const lines = argvLines(stub);
        return [a, b].every((r) => lines.some((l) => invokes(l, 'fetch', r)));
      });
      const lines = argvLines(stub);
      assert.ok(
        [a, b].every((r) => lines.some((l) => invokes(l, 'describe', r))),
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
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'pf-open', has_description: false, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'pf-open',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
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
      assert.ok(
        lines.some((l) => invokes(l, 'describe', repo)),
        'revalidate described',
      );
      assert.ok(
        !lines.some((l) => invokes(l, 'fetch', repo)),
        `no content fetch on a cached open: ${lines.join(' | ')}`,
      );
      assert.deepStrictEqual(revalidates, ['checking', 'done'], 'cached paint → checking/done');
    } finally {
      canned(stub, 'search', { items: [] });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a logo cached by a details open pops into the browse cards', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/logo-open';
    // Prefetch OFF, so the only path that can cache this logo is the panel open —
    // exactly the case that used to leave the card on its codicon tile until an
    // unrelated refresh happened by (only the prefetcher reported landed logos).
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('prefetchDetails', false, vscode.ConfigurationTarget.Global);
    canned(stub, 'search', { items: [searchItem(repo)] });
    cannedWithLogo(stub, repo, 'sha256:art1');
    const { view, states } = fakeView();
    api.providers.sidebar.resolveWebviewView(view);
    try {
      await api.providers.sidebar.refresh();
      const before = states[states.length - 1];
      assert.strictEqual(before?.items[0]?.logoUri ?? null, null, 'card starts logo-less');
      const { panel } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      await waitFor(() => (states[states.length - 1]?.items[0]?.logoUri ?? null) !== null);
    } finally {
      await vscode.workspace
        .getConfiguration('grimoire')
        .update('prefetchDetails', undefined, vscode.ConfigurationTarget.Global);
      canned(stub, 'search', { items: [] });
      fs.rmSync(path.join(stub.dir, 'fetch-logo.json'), { force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a stale cache entry is re-prefetched and picks up a later-published logo', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/late-logo';
    canned(stub, 'search', { items: [searchItem(repo)] });
    // v1 of the artifact ships no logo.
    canned(stub, 'describe', describeDoc(repo, { has_description: false, digest: 'sha256:art1' }));
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'late-logo',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    try {
      await api.providers.sidebar.refresh();
      await waitFor(() => fs.readdirSync(cacheDir).some((f) => f.endsWith('.json')));
      const name = fs.readdirSync(cacheDir).find((f) => f.endsWith('.json')) as string;
      const entryFile = path.join(cacheDir, name);
      // A FRESH entry is still skipped outright — no probe per browse refresh.
      fs.rmSync(stub.argvLog, { force: true });
      await api.providers.sidebar.refresh();
      await new Promise((r) => setTimeout(r, 300)); // give any prefetch a chance to fire
      assert.ok(
        !argvLines(stub).some((l) => invokes(l, 'describe', repo)),
        'a fresh entry is not re-probed',
      );
      // Age it past the TTL, then publish a logo under a new digest.
      const aged = {
        ...(JSON.parse(fs.readFileSync(entryFile, 'utf8')) as Record<string, unknown>),
        savedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      };
      fs.writeFileSync(entryFile, JSON.stringify(aged));
      cannedWithLogo(stub, repo, 'sha256:art2');
      await api.providers.sidebar.refresh();
      await waitFor(() => {
        const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8')) as { logoUri: string | null };
        return entry.logoUri !== null;
      });
    } finally {
      canned(stub, 'search', { items: [] });
      fs.rmSync(path.join(stub.dir, 'fetch-logo.json'), { force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a failed doc fetch is not pinned to the digest — the next open retries', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/flaky-readme';
    canned(stub, 'describe', describeDoc(repo, { has_description: false, digest: 'sha256:art1' }));
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'flaky-readme',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [{ path: 'README.md', size: 12 }],
    });
    canned(stub, 'fetch-readme', { error: { code: 'network', exit: 70, message: 'flaky' } });
    try {
      const first = fakePanel();
      await api.providers.details.onMessage(repo, first.panel, { type: 'ready', repo });
      assert.strictEqual(
        first.posts[first.posts.length - 1]?.readmeMarkdown ?? null,
        null,
        'the README fetch failed, so nothing rendered',
      );
      // The README now lands, under the SAME artifact digest. Caching the failure
      // as "ships no README" would let revalidate short-circuit on the matching
      // digest and hide it for good.
      canned(stub, 'fetch-readme', {
        ref: `${repo}:latest`,
        digest: 'sha256:art1',
        kind: 'skill',
        name: 'flaky-readme',
        vendor: 'canonical',
        path: 'README.md',
        content: '# real-readme-marker',
      });
      const second = fakePanel();
      await api.providers.details.onMessage(repo, second.panel, { type: 'ready', repo });
      assert.match(
        second.posts[second.posts.length - 1]?.readmeMarkdown ?? '',
        /real-readme-marker/,
        'the retried README landed',
      );
    } finally {
      fs.rmSync(path.join(stub.dir, 'fetch-readme.json'), { force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('a warm open paints from cache before any context/status spawn (zero-spawn paint)', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    const cacheDir = isolateCache(api);
    const repo = 'ghcr.io/grimoire-rs/skills/instant';
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'instant', has_description: false, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'instant',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
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
    canned(
      stub,
      'describe',
      describeDoc(repo, { name: 'rows', has_description: false, digest: 'sha256:art1' }),
    );
    canned(stub, 'fetch', {
      ref: `${repo}:latest`,
      digest: 'sha256:art1',
      kind: 'skill',
      name: 'rows',
      vendor: 'canonical',
      content: '# Descriptor',
      files: [],
    });
    try {
      await api.providers.details.buildVM(repo); // stale snapshot: project not configured
      // Between sessions the project becomes configured → install rows differ.
      canned(stub, 'context', contextDoc({ config_exists: true }));
      const { panel, posts } = fakePanel();
      await api.providers.details.onMessage(repo, panel, { type: 'ready', repo });
      assert.ok(posts.length >= 2, 'instant stale paint + a fresh install repost');
      assert.strictEqual(
        posts[0]?.scopes.projectConfigured,
        false,
        'first paint used the stale snapshot',
      );
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
    await waitFor(() => argvLines(stub).some((l) => invokes(l, 'fetch', a)));
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
    await waitFor(() => argvLines(stub).some((l) => invokes(l, 'fetch', previewRepo)));
    fs.rmSync(stub.argvLog, { force: true });
    await api.providers.details.refreshOpenPanels();
    assert.ok(
      argvLines(stub).some((l) => invokes(l, 'fetch', previewRepo)),
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
    assert.ok(
      lines[addIndex]?.includes('grim-usage:1.4.2'),
      `pins the picked tag: ${lines[addIndex]}`,
    );
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
      vscode.Uri.parse(
        `vscode://grimoire-rs.grimoire-vscode/open?repo=${encodeURIComponent(repo)}`,
      ),
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

  // --- add-registry deep link (a WRITE reachable from any web page) ---

  function addRegistryUri(query: string): vscode.Uri {
    return vscode.Uri.parse(`vscode://grimoire-rs.grimoire-vscode/add-registry?${query}`);
  }

  /** Answers the confirmation modal with `confirm` and records every prompt, so
   *  a test can assert both what the user was shown and — for a rejected link —
   *  that they were never asked at all. */
  function stubAddRegistryModal(confirm: string | undefined): {
    restore: () => void;
    prompts: { message: string; detail: string }[];
  } {
    const window = vscode.window as unknown as { showWarningMessage: unknown };
    const original = window.showWarningMessage;
    const prompts: { message: string; detail: string }[] = [];
    window.showWarningMessage = async (message: string, options?: { detail?: string }) => {
      prompts.push({ message, detail: options?.detail ?? '' });
      return confirm;
    };
    return {
      restore: () => {
        window.showWarningMessage = original;
      },
      prompts,
    };
  }

  const INDEX_QUERY = `index=${encodeURIComponent('https://index.grimoire.rs')}&alias=grimoire`;

  test('add-registry deep link writes only after a modal naming the index and alias', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'config', {
      action: 'registry-added',
      key: 'grimoire',
      value: 'https://index.grimoire.rs/',
      scope: 'project',
      dry_run: false,
    });
    fs.rmSync(stub.argvLog, { force: true });
    const modal = stubAddRegistryModal('Add Registry');
    try {
      await api.handleUri(addRegistryUri(INDEX_QUERY));
    } finally {
      modal.restore();
      fs.rmSync(path.join(stub.dir, 'config.json'), { force: true });
    }
    assert.strictEqual(modal.prompts.length, 1, 'confirmed exactly once');
    assert.ok(modal.prompts[0]?.detail.includes('https://index.grimoire.rs/'), 'names the index');
    assert.ok(modal.prompts[0]?.detail.includes('grimoire'), 'names the alias');
    const lines = argvLines(stub);
    const add = lines.find((l) => l.startsWith('config registry add'));
    assert.ok(add, `registry add ran: ${lines.join(' | ')}`);
    assert.ok(add.includes('--index=https://index.grimoire.rs/'), `index locator: ${add}`);
    assert.ok(add.endsWith('-- grimoire'), `alias stays positional after --: ${add}`);
    assert.ok(!add.includes('--global'), 'project scope, the workspace fixture being open');
  });

  test('declining the add-registry modal writes nothing', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    const modal = stubAddRegistryModal(undefined);
    try {
      await api.handleUri(addRegistryUri(INDEX_QUERY));
    } finally {
      modal.restore();
    }
    assert.strictEqual(modal.prompts.length, 1, 'the user was asked');
    assert.deepStrictEqual(
      argvLines(stub).filter((l) => l.startsWith('config')),
      [],
      'no grim config call at all',
    );
  });

  test('add-registry deep link rejects http, junk and unsafe aliases without asking', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    fs.rmSync(stub.argvLog, { force: true });
    const modal = stubAddRegistryModal('Add Registry');
    const https = encodeURIComponent('https://index.grimoire.rs');
    try {
      for (const query of [
        `index=${encodeURIComponent('http://index.grimoire.rs')}&alias=grimoire`,
        `index=${encodeURIComponent('file:///etc/passwd')}&alias=grimoire`,
        `index=${encodeURIComponent('not a url')}&alias=grimoire`,
        `index=${encodeURIComponent('https://user:token@index.grimoire.rs')}&alias=grimoire`,
        'alias=grimoire',
        https,
        `index=${https}&alias=${encodeURIComponent('--default')}`,
        `index=${https}&alias=${encodeURIComponent('a"] \n evil')}`,
      ]) {
        await api.handleUri(addRegistryUri(query));
      }
    } finally {
      modal.restore();
    }
    assert.deepStrictEqual(modal.prompts, [], 'a rejected link never reaches the modal');
    assert.deepStrictEqual(
      argvLines(stub).filter((l) => l.startsWith('config')),
      [],
    );
  });

  /** A link carrying one include and one exclude pattern — DISTINCT, so a
   *  swapped passthrough shows up in the argv assertions below. */
  const FILTER_QUERY =
    `${INDEX_QUERY}&include=${encodeURIComponent('acme/platform/**')}` +
    `&exclude=${encodeURIComponent('acme/platform/legacy/**')}`;

  /** Re-cans `grim context` with `version` and refreshes, so the snapshot the
   *  deep-link gate reads reports that grim. Returns the restore. */
  async function withGrimVersion(api: GrimoireApi, version: string): Promise<() => Promise<void>> {
    canned(stub, 'context', contextDoc({ version }));
    await api.refresh();
    return async () => {
      canned(stub, 'context', contextDoc());
      await api.refresh();
    };
  }

  test('a filtered link writes each pattern on the flag the modal showed it under', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    canned(stub, 'config', {
      action: 'registry-added',
      key: 'grimoire',
      value: 'https://index.grimoire.rs/',
      scope: 'project',
      dry_run: false,
    });
    const restoreVersion = await withGrimVersion(api, REGISTRY_EDIT_GRIM_VERSION);
    fs.rmSync(stub.argvLog, { force: true });
    const modal = stubAddRegistryModal('Add Registry');
    let lines: string[] | undefined;
    try {
      await api.handleUri(addRegistryUri(FILTER_QUERY));
      lines = argvLines(stub); // read before the restoring refresh spawns its own
    } finally {
      modal.restore();
      fs.rmSync(path.join(stub.dir, 'config.json'), { force: true });
      await restoreVersion();
    }
    assert.ok(lines);
    const detail = modal.prompts[0]?.detail ?? '';
    assert.ok(detail.includes('acme/platform/**'), `modal names the include: ${detail}`);
    assert.ok(detail.includes('acme/platform/legacy/**'), `modal names the exclude: ${detail}`);
    const add = lines.find((l) => l.startsWith('config registry add'));
    assert.ok(add, `registry add ran: ${lines.join(' | ')}`);
    // The modal authorizing one list while grim writes the other is the whole
    // failure this asserts against — hence both directions.
    assert.ok(add.includes('--include=acme/platform/**'), `include flag: ${add}`);
    assert.ok(add.includes('--exclude=acme/platform/legacy/**'), `exclude flag: ${add}`);
    assert.ok(!add.includes('--include=acme/platform/legacy/**'), `lists not swapped: ${add}`);
    assert.ok(!add.includes('--exclude=acme/platform/**'), `lists not swapped: ${add}`);
  });

  test('a filtered link is refused BEFORE the modal on a grim without the flags', async function () {
    this.timeout(20000);
    const api = await activateExtension();
    // The default fixture reports the version floor, which predates the two
    // pattern flags; re-assert it so an earlier test's context cannot decide
    // this one's outcome.
    const restoreVersion = await withGrimVersion(api, MINIMUM_GRIM_VERSION);
    fs.rmSync(stub.argvLog, { force: true });
    const modal = stubAddRegistryModal('Add Registry');
    const window = vscode.window as unknown as { showErrorMessage: unknown };
    const originalError = window.showErrorMessage;
    const errors: string[] = [];
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    let lines: string[] | undefined;
    try {
      await api.handleUri(addRegistryUri(FILTER_QUERY));
      lines = argvLines(stub); // read before the restoring refresh spawns its own
    } finally {
      modal.restore();
      window.showErrorMessage = originalError;
      await restoreVersion();
    }
    assert.ok(lines);
    assert.deepStrictEqual(modal.prompts, [], 'never confirms a write that cannot succeed');
    assert.deepStrictEqual(
      lines.filter((l) => l.startsWith('config')),
      [],
      'nothing written',
    );
    assert.ok(
      errors.some((e) => e.includes(REGISTRY_EDIT_GRIM_VERSION)),
      `the refusal names the version needed: ${errors.join(' | ')}`,
    );
    // A link carrying NO patterns is unaffected on this same grim — see
    // 'add-registry deep link writes only after a modal naming the index and
    // alias', which runs against the default (pre-0.13) context fixture.
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
    const search = argvLines(stub).find((l) => l.startsWith('search') && l.includes('oci-cli-tag'));
    assert.ok(search, 'Browse searched for the clicked tag');
  });
});

// Static contributes-shape check (no extension host needed): keeps the
// sidebar toolbar down to the feedback submenu + conditional Update All
// icon, with refresh/check-updates/update-all/settings overflowing into
// VS Code's native "..." menu.
suite('view/title toolbar contributions (package.json)', () => {
  interface MenuEntry {
    command?: string;
    submenu?: string;
    group?: string;
    when?: string;
  }
  interface PackageJson {
    activationEvents: string[];
    contributes: {
      views: { grimoire: { id: string; when?: string }[] };
      menus: {
        'view/title': MenuEntry[];
        'grimoire.feedback': MenuEntry[];
        commandPalette: { command: string; when?: string }[];
      };
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
  ) as PackageJson;

  test('navigation holds the feedback submenu, Update All, and the view toggles; feedback submenu lists both commands', () => {
    const navEntries = pkg.contributes.menus['view/title'].filter((entry) =>
      (entry.group ?? '').startsWith('navigation'),
    );
    assert.deepStrictEqual(
      navEntries.map((entry) => entry.submenu ?? entry.command),
      [
        'grimoire.feedback',
        'grimoire.updateAll',
        // Each toggle is a PAIR of commands under opposite `when` clauses — the
        // workbench has no toggled state for a title-bar action, so the icon and
        // title name the state the click switches TO. Exactly one of each pair
        // is ever visible.
        'grimoire.showCompactRows',
        'grimoire.showComfortableCards',
        'grimoire.showTreeView',
        'grimoire.showFlatList',
        'grimoire.groupArtifacts',
        'grimoire.ungroupArtifacts',
        'grimoire.expandAll',
        'grimoire.collapseAll',
      ],
    );
    // The pairs must be mutually exclusive, or both icons show at once.
    const when = (command: string): string =>
      navEntries.find((entry) => entry.command === command)?.when ?? '';
    for (const [a, b, key] of [
      ['grimoire.showCompactRows', 'grimoire.showComfortableCards', 'grimoire.view.compact'],
      ['grimoire.showTreeView', 'grimoire.showFlatList', 'grimoire.view.tree'],
      ['grimoire.groupArtifacts', 'grimoire.ungroupArtifacts', 'grimoire.view.grouped'],
    ] as const) {
      assert.ok(when(a).includes(`!${key}`), `${a} shows only while !${key}`);
      assert.ok(when(b).includes(key) && !when(b).includes(`!${key}`), `${b} is its complement`);
    }
    // Expand/collapse-all are tree-only and are themselves a complementary
    // pair on grimoire.view.expanded, so the tree shows exactly ONE icon in
    // that slot — the same count the list shows for grouping. A slot whose
    // occupancy changed with the mode shifted every icon beside it.
    const treeOnly = ['grimoire.expandAll', 'grimoire.collapseAll'];
    const listOnly = ['grimoire.groupArtifacts', 'grimoire.ungroupArtifacts'];
    for (const command of treeOnly) {
      assert.ok(when(command).includes('&& grimoire.view.tree'), `${command} is tree-only`);
    }
    for (const command of listOnly) {
      assert.ok(when(command).includes('!grimoire.view.tree'), `${command} is list-only`);
    }
    assert.ok(when('grimoire.expandAll').includes('!grimoire.view.expanded'));
    assert.ok(
      when('grimoire.collapseAll').includes('&& grimoire.view.expanded'),
      'collapse-all is the complement, not a second always-on button',
    );
    // All four share ONE slot, so the icon count never changes with the mode.
    const slots = new Set(
      [...treeOnly, ...listOnly].map(
        (command) => navEntries.find((entry) => entry.command === command)?.group,
      ),
    );
    assert.deepStrictEqual([...slots], ['navigation@5'], 'one shared slot');
    // Updates neither trees nor groups, so every control that shapes structure
    // is gated on the active tab having one. Density is NOT — Updates honours
    // it, and a toggle that works everywhere should not blink out on one tab.
    for (const command of [...treeOnly, ...listOnly, 'grimoire.showTreeView', 'grimoire.showFlatList']) {
      assert.ok(
        when(command).includes('grimoire.view.structured'),
        `${command} only shows on a tab that has a structure`,
      );
    }
    for (const command of ['grimoire.showCompactRows', 'grimoire.showComfortableCards']) {
      assert.ok(
        !when(command).includes('grimoire.view.structured'),
        `${command} applies on every tab`,
      );
    }
    assert.deepStrictEqual(
      pkg.contributes.menus['grimoire.feedback'].map((entry) => entry.command),
      ['grimoire.reportBug', 'grimoire.requestFeature'],
    );
  });

  test('the container holds exactly one view, and activation is eager', () => {
    // A second view in the container splits the folded header back out, so the
    // title icons stop being permanently visible. Eager activation is what
    // computes the count in a window nobody has opened Grimoire in — and with
    // it `grimoire.updatesAvailable`, the key gating the Update All icon.
    assert.deepStrictEqual(
      pkg.contributes.views.grimoire.map((v) => v.id),
      ['grimoire.marketplace'],
    );
    assert.ok(pkg.activationEvents.includes('onStartupFinished'));
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
      'skill:grim-usage': 'ghcr.io/grimoire-rs/skills/grim-usage:1.4.2',
      'mcp:grim': 'ghcr.io/grimoire-rs/mcp/grim:latest',
    });
  });

  test('one name in two tables keeps both refs', () => {
    // grim identifies an artifact by (kind, name), and grimoire.toml is five
    // tables of names — so `code-review` can be a skill AND an agent, with two
    // different repos. Keyed by name alone one silently overwrote the other.
    const declared = parseDeclaredRefs(`
[skills]
code-review = "ghcr.io/acme/skills/code-review:1.0"

[agents]
code-review = "ghcr.io/acme/agents/code-review:2.0"
`);
    assert.deepStrictEqual(declared, {
      'skill:code-review': 'ghcr.io/acme/skills/code-review:1.0',
      'agent:code-review': 'ghcr.io/acme/agents/code-review:2.0',
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

suite('projectSearchable', () => {
  // projectSearchable only reads config_exists off this, but it lives on the
  // full grim context shape, so build a minimal-but-complete fixture.
  function contextWith(configExists: boolean): ContextInfo {
    return {
      version: '0.9.0',
      scope: 'project',
      workspace: '/ws',
      config_path: '/ws/grimoire.toml',
      config_exists: configExists,
      lock_path: '/ws/grimoire.lock',
      lock_exists: false,
      grim_home: '/home/user/.grimoire',
      offline: false,
      clients: [],
      registries: [],
      default_registry: null,
    };
  }

  test('project config exists -> searchable', () => {
    const snapshot: Snapshot = {
      grimMissing: false,
      project: { context: contextWith(true), status: [], declared: {} },
    };
    assert.strictEqual(projectSearchable(snapshot), true);
  });

  test('folder open, probe failed -> searchable (surfaces the failure instead of a silent global fallback)', () => {
    const snapshot: Snapshot = {
      grimMissing: false,
      projectFolder: '/ws',
      projectProbeFailed: true,
    };
    assert.strictEqual(projectSearchable(snapshot), true);
  });

  test('folder open, probe ok, no grimoire.toml -> not searchable', () => {
    const snapshot: Snapshot = {
      grimMissing: false,
      project: { context: contextWith(false), status: [], declared: {} },
    };
    assert.strictEqual(projectSearchable(snapshot), false);
  });

  test('no project data and no probe failure -> not searchable', () => {
    const snapshot: Snapshot = { grimMissing: false };
    assert.strictEqual(projectSearchable(snapshot), false);
  });
});

suite('isProjectNotDiscovered', () => {
  test('true for the NotDiscovered shape grim reports (code "not-found", exit 79)', () => {
    assert.strictEqual(
      isProjectNotDiscovered({
        ok: false,
        kind: 'error',
        code: 'not-found',
        exitCode: 79,
        message: '/ws: no grimoire.toml found by walking up from the working directory',
      }),
      true,
    );
  });

  test('false for a different error code (a genuine transient failure)', () => {
    assert.strictEqual(
      isProjectNotDiscovered({
        ok: false,
        kind: 'error',
        code: 'no-permission',
        exitCode: 77,
        message: 'permission denied',
      }),
      false,
    );
  });

  test('false for the grim-binary-missing kind (a different failure class entirely)', () => {
    assert.strictEqual(isProjectNotDiscovered({ ok: false, kind: 'not-found' }), false);
  });

  test('false for a successful probe', () => {
    assert.strictEqual(
      isProjectNotDiscovered({
        ok: true,
        value: {
          version: '0.9.0',
          scope: 'project',
          workspace: '/ws',
          config_path: '/ws/grimoire.toml',
          config_exists: true,
          lock_path: '/ws/grimoire.lock',
          lock_exists: false,
          grim_home: '/home/user/.grimoire',
          offline: false,
          clients: [],
          registries: [],
          default_registry: null,
        },
      }),
      false,
    );
  });
});

// snapshot()'s flag-setting branch and the init gate need per-scope outcomes
// the shell stub can't fake (it cans one context.json for BOTH scopes), so
// these override run() on the instance — the seam every spawn goes through.
suite('project probe failure (run override)', () => {
  function probeContext(configExists: boolean): ContextInfo {
    return {
      // At the floor — a pre-floor version short-circuits the snapshot before
      // status ever runs (see the "grim version floor" suite).
      version: MINIMUM_GRIM_VERSION,
      scope: 'project',
      workspace: '/ws',
      config_path: '/nonexistent/grimoire.toml',
      config_exists: configExists,
      lock_path: '/nonexistent/grimoire.lock',
      lock_exists: false,
      grim_home: path.join(os.tmpdir(), 'grim-probe-home'),
      offline: false,
      clients: [],
      registries: [],
      default_registry: null,
    };
  }

  function scopedRun(project: GrimResult<ContextInfo>) {
    return async <T>(_args: string[], scope: Scope): Promise<GrimResult<T>> =>
      (scope === 'project' ? project : { ok: true, value: probeContext(false) }) as GrimResult<T>;
  }

  const probeError: GrimResult<ContextInfo> = {
    ok: false,
    kind: 'error',
    code: 'internal',
    exitCode: 70,
    message: 'transient probe failure',
  };

  // grim's real shape for "no grimoire.toml anywhere up the tree": `context`
  // itself fails (ConfigError::NotDiscovered) rather than succeeding with
  // config_exists:false — verified live against grim 0.9.0. code/exitCode
  // are the structural signal isProjectNotDiscovered reads; never string-match
  // `message` (it's a real, path-specific grim string).
  const notDiscovered: GrimResult<ContextInfo> = {
    ok: false,
    kind: 'error',
    code: 'not-found',
    exitCode: 79,
    message: '/ws: no grimoire.toml found by walking up from the working directory',
  };

  test('snapshot() sets projectProbeFailed on a project probe error, keeping it searchable', async () => {
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput([]));
    scopes.run = scopedRun(probeError);
    const snap = await scopes.snapshot();
    assert.strictEqual(snap.projectProbeFailed, true);
    assert.strictEqual(snap.project, undefined, 'a failed probe yields no project snapshot');
    assert.strictEqual(projectSearchable(snap), true);
  });

  test('snapshot() does NOT set projectProbeFailed on NotDiscovered — it must read as plain unconfigured', async () => {
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput([]));
    scopes.run = scopedRun(notDiscovered);
    const snap = await scopes.snapshot();
    assert.strictEqual(snap.projectProbeFailed, undefined);
    assert.strictEqual(snap.project, undefined);
    // The behavioral crux of the fix: unlike a genuine probe error, this must
    // fall back to global (browse) rather than re-querying an unconfigured
    // project and surfacing grim's raw "no grimoire.toml found by walking
    // up..." message.
    assert.strictEqual(projectSearchable(snap), false);
  });

  test('projectNeedsInit: only a positive "no config" probe triggers init', async () => {
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput([]));
    // Probe failed → no init: init writes at the cwd while discovery walks up,
    // so initializing on a transient failure could shadow a parent config.
    scopes.run = scopedRun(probeError);
    assert.strictEqual(await scopes.projectNeedsInit(), false);
    scopes.run = scopedRun({ ok: true, value: probeContext(false) });
    assert.strictEqual(await scopes.projectNeedsInit(), true);
    scopes.run = scopedRun({ ok: true, value: probeContext(true) });
    assert.strictEqual(await scopes.projectNeedsInit(), false);
  });

  test('projectNeedsInit: NotDiscovered also triggers init (the common real-world shape)', async () => {
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput([]));
    scopes.run = scopedRun(notDiscovered);
    assert.strictEqual(await scopes.projectNeedsInit(), true);
  });

  test('snapshot() surfaces a failed status as snapshot.error instead of silently emptying installs', async () => {
    const scopes = new ScopeService(vscode.Uri.file(os.tmpdir()), recordingOutput([]));
    // The real-world shape: a stale grim binary rejecting `status --check`
    // (clap usage error, exit 64). The old behavior mapped this to status: []
    // — every card then lied "Install" for artifacts that are installed.
    scopes.run = (async <T>(args: string[]): Promise<GrimResult<T>> => {
      if (args[0] === 'context') {
        return { ok: true, value: probeContext(true) } as GrimResult<T>;
      }
      return {
        ok: false,
        kind: 'error',
        code: 'usage',
        exitCode: 64,
        message: "unexpected argument '--check' found",
      } as GrimResult<T>;
    }) as typeof scopes.run;
    const snap = await scopes.snapshot({ check: true });
    assert.ok(snap.global, 'the scope snapshot itself survives a status failure');
    // null, not []: "we could not find out" and "nothing is installed" are
    // different claims, and [] is the one that flips installed cards to Install.
    assert.strictEqual(snap.global.status, null, 'install state is unknown, never fabricated');
    assert.strictEqual(snap.global.statusUnknownReason, 'status-failed');
    assert.ok(
      snap.error?.includes("unexpected argument '--check'"),
      `snapshot.error carries the status failure: ${snap.error}`,
    );
  });
});

suite('executable resolution', () => {
  test('whichGrim: executable file on PATH found; empty/dir-only PATH rejected', function () {
    if (isWindows) {
      this.skip(); // exe-bit + PATHEXT semantics; resolution order is covered via the seam below
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-path-'));
    fs.writeFileSync(path.join(dir, 'grim'), '#!/bin/sh\n', { mode: 0o755 });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-path-empty-'));
    // A DIRECTORY named grim must not count as an executable (X_OK passes on dirs).
    const dirTrap = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-path-trap-'));
    fs.mkdirSync(path.join(dirTrap, 'grim'));
    // The ABSOLUTE hit, never a bare name: it is what gets spawned (a bare name
    // resolves against cwd before PATH on Windows) and what the too-old message
    // prints, so "which grim ran?" is answerable from the toast alone.
    assert.strictEqual(whichGrim({ PATH: dir }), path.join(dir, 'grim'));
    assert.strictEqual(
      whichGrim({ PATH: `${empty}${path.delimiter}${dir}` }),
      path.join(dir, 'grim'),
      'an earlier empty PATH entry is skipped, not fatal',
    );
    assert.strictEqual(whichGrim({ PATH: empty }), undefined);
    assert.strictEqual(whichGrim({ PATH: dirTrap }), undefined);
    assert.strictEqual(whichGrim({}), undefined);
  });

  test('whichGrim: a RELATIVE PATH entry still yields an absolute path', function () {
    if (isWindows) {
      this.skip(); // exe bit; the resolution rule itself is platform-independent
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-path-rel-'));
    fs.writeFileSync(path.join(dir, 'grim'), '#!/bin/sh\n', { mode: 0o755 });
    // `.`, `bin`, `./tools` are all legal PATH entries. Handed back relative,
    // they get resolved against the SPAWN's cwd — the workspace folder — which
    // is the same hole as spawning a bare `grim`: a repository shipping its own
    // grim wins over the user's.
    const relative = path.relative(process.cwd(), dir);
    assert.ok(!path.isAbsolute(relative), 'the PATH entry under test is relative');
    const hit = whichGrim({ PATH: relative });
    assert.strictEqual(hit, path.join(dir, 'grim'));
    assert.ok(hit !== undefined && path.isAbsolute(hit), 'never a workspace-relative executable');
  });

  test('resolveExecutable: PATH grim wins over the bundled copy; bundled is the no-PATH fallback', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-storage-'));
    const scopes = new ScopeService(vscode.Uri.file(storage), recordingOutput([]));
    fs.mkdirSync(path.dirname(scopes.bundledExecutablePath()), { recursive: true });
    fs.writeFileSync(scopes.bundledExecutablePath(), '#!/bin/sh\n', { mode: 0o755 });
    const onPath = path.join(storage, 'path-grim');
    // The resolution under test is the default-setting branch — park any
    // explicit executable another suite left in the global setting.
    const cfg = vscode.workspace.getConfiguration('grimoire');
    const prev = cfg.inspect<string>('path.executable')?.globalValue;
    await cfg.update('path.executable', undefined, vscode.ConfigurationTarget.Global);
    try {
      scopes.pathGrim = () => onPath;
      assert.strictEqual(
        scopes.resolveExecutable(),
        onPath,
        'a user-managed PATH grim must win over the extension-managed copy, named absolutely',
      );
      assert.notStrictEqual(
        scopes.resolveExecutable(),
        DEFAULT_EXECUTABLE,
        'never the bare name: run() spawns with cwd set, where Windows resolves it against the repo first',
      );
      scopes.pathGrim = () => undefined;
      assert.strictEqual(
        scopes.resolveExecutable(),
        scopes.bundledExecutablePath(),
        'without a PATH grim the bundled copy is the fallback',
      );
    } finally {
      await cfg.update('path.executable', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('resolveExecutable: an explicit path.executable wins even when PATH has a grim', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-storage-'));
    const scopes = new ScopeService(vscode.Uri.file(storage), recordingOutput([]));
    fs.mkdirSync(path.dirname(scopes.bundledExecutablePath()), { recursive: true });
    fs.writeFileSync(scopes.bundledExecutablePath(), '#!/bin/sh\n', { mode: 0o755 });
    const explicit = path.join(storage, 'explicit-grim');
    const cfg = vscode.workspace.getConfiguration('grimoire');
    const prev = cfg.inspect<string>('path.executable')?.globalValue;
    await cfg.update('path.executable', explicit, vscode.ConfigurationTarget.Global);
    try {
      // The setting is the top of the chain: neither a PATH grim nor the
      // bundled copy may override what the user pointed at explicitly.
      scopes.pathGrim = () => path.join(storage, 'path-grim');
      assert.strictEqual(scopes.resolveExecutable(), explicit);
      scopes.pathGrim = () => undefined;
      assert.strictEqual(scopes.resolveExecutable(), explicit);
    } finally {
      await cfg.update('path.executable', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('managedExecutable: true only for the bundled copy at the default setting', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-storage-'));
    const scopes = new ScopeService(vscode.Uri.file(storage), recordingOutput([]));
    fs.mkdirSync(path.dirname(scopes.bundledExecutablePath()), { recursive: true });
    fs.writeFileSync(scopes.bundledExecutablePath(), '#!/bin/sh\n', { mode: 0o755 });
    const cfg = vscode.workspace.getConfiguration('grimoire');
    const prev = cfg.inspect<string>('path.executable')?.globalValue;
    await cfg.update('path.executable', undefined, vscode.ConfigurationTarget.Global);
    try {
      scopes.pathGrim = () => undefined;
      assert.strictEqual(scopes.managedExecutable(), true, 'bundled fallback is ours to replace');
      scopes.pathGrim = () => path.join(storage, 'path-grim');
      assert.strictEqual(scopes.managedExecutable(), false, 'a PATH grim is user-managed');
      // Pointing the setting AT the bundled path is still a user's explicit
      // choice — the update toast must not offer to overwrite it.
      await cfg.update(
        'path.executable',
        scopes.bundledExecutablePath(),
        vscode.ConfigurationTarget.Global,
      );
      scopes.pathGrim = () => undefined;
      assert.strictEqual(scopes.managedExecutable(), false, 'an explicit setting is user-managed');
    } finally {
      await cfg.update('path.executable', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('resolvedExecutable pins each origin (incl. missing) and stays in parity with resolveExecutable', async function () {
    if (isWindows) {
      this.skip(); // the PATH-hit assertions rely on a bare `grim` file (no .exe)
      return;
    }
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-storage-resolved-'));
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-resolved-path-'));
    fs.writeFileSync(path.join(pathDir, 'grim'), '#!/bin/sh\n', { mode: 0o755 });
    const scopes = new ScopeService(vscode.Uri.file(storage), recordingOutput([]));
    const bundled = scopes.bundledExecutablePath();
    const cfg = vscode.workspace.getConfiguration('grimoire');
    const prevExec = cfg.inspect<string>('path.executable')?.globalValue;
    const prevEnv = cfg.inspect<Record<string, string>>('extraEnv')?.globalValue;
    // The spawn and the naming resolution are ONE derivation now: whatever
    // resolvedExecutable() reports is exactly what resolveExecutable() spawns,
    // PATH branch included (it used to hand the OS a bare `grim` there).
    try {
      await cfg.update('path.executable', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('extraEnv', { PATH: pathDir }, vscode.ConfigurationTarget.Global);

      // PATH: the real scan, through the default seam — the absolute hit
      // whichGrim found, never bare `grim`.
      fs.rmSync(bundled, { force: true });
      const onPath = scopes.resolvedExecutable();
      assert.strictEqual(onPath.origin, 'PATH');
      assert.strictEqual(onPath.path, path.join(pathDir, 'grim'));
      assert.notStrictEqual(onPath.path, DEFAULT_EXECUTABLE, 'PATH names the hit, not bare grim');
      assert.strictEqual(scopes.resolveExecutable(), onPath.path);

      // missing: no setting, no PATH grim, no bundled copy — reported as missing,
      // never mislabelled PATH (the bug: a full scan only to name a nowhere binary).
      scopes.pathGrim = () => undefined;
      const missing = scopes.resolvedExecutable();
      assert.strictEqual(missing.origin, 'missing');
      assert.strictEqual(missing.path, DEFAULT_EXECUTABLE);
      assert.strictEqual(scopes.resolveExecutable(), missing.path);

      // bundled: no PATH grim but the extension-managed copy exists.
      fs.mkdirSync(path.dirname(bundled), { recursive: true });
      fs.writeFileSync(bundled, '#!/bin/sh\n', { mode: 0o755 });
      const bundledRes = scopes.resolvedExecutable();
      assert.strictEqual(bundledRes.origin, 'bundled');
      assert.strictEqual(bundledRes.path, bundled);
      assert.strictEqual(scopes.resolveExecutable(), bundledRes.path);

      // setting: an explicit path wins over a PATH grim and the bundled copy alike.
      const explicit = path.join(storage, 'explicit-grim');
      await cfg.update('path.executable', explicit, vscode.ConfigurationTarget.Global);
      scopes.pathGrim = () => path.join(pathDir, 'grim');
      const setting = scopes.resolvedExecutable();
      assert.strictEqual(setting.origin, 'setting');
      assert.strictEqual(setting.path, explicit);
      assert.strictEqual(scopes.resolveExecutable(), setting.path);
    } finally {
      await cfg.update('path.executable', prevExec, vscode.ConfigurationTarget.Global);
      await cfg.update('extraEnv', prevEnv, vscode.ConfigurationTarget.Global);
      fs.rmSync(storage, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });
});

/** The version floor, end to end through the REAL resolveExecutable + execFile
 *  chain (not a scopes.run override), because that chain is what decides which
 *  binary answers — a stale grim on PATH is the case that regressed. */
suite('grim version floor', () => {
  let stub: Stub;
  let previous: string | undefined;

  suiteSetup(async function () {
    if (isWindows) {
      this.skip();
    }
    stub = writeStub();
    canned(stub, 'search', { items: [] });
    canned(stub, 'status', { items: [] });
    const cfg = vscode.workspace.getConfiguration('grimoire');
    previous = cfg.inspect<string>('path.executable')?.globalValue;
    await cfg.update('path.executable', stub.executable, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    if (isWindows) {
      return;
    }
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', previous, vscode.ConfigurationTarget.Global);
  });

  test('a grim below the floor fails the snapshot with an actionable message and never runs status', async function () {
    this.timeout(15000);
    canned(stub, 'context', contextDoc({ version: '0.9.1', config_exists: true }));
    const scopes = new ScopeService(
      vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'grim-floor-'))),
      recordingOutput([]),
    );
    fs.rmSync(stub.argvLog, { force: true });
    const snapshot = await scopes.snapshot({ check: true });
    assert.strictEqual(snapshot.grimMissing, false, 'the binary exists — it is merely too old');
    assert.ok(snapshot.error, 'a pre-floor grim must fail the snapshot');
    assert.ok(snapshot.error.includes('0.9.1'), `names the version that ran: ${snapshot.error}`);
    assert.ok(
      snapshot.error.includes(stub.executable),
      `names the binary that ran, so "which grim is this?" is answerable: ${snapshot.error}`,
    );
    assert.ok(snapshot.error.includes(MINIMUM_GRIM_VERSION), 'names the required version');
    // The whole point of gating on `context`: a pre-floor grim never sees a
    // flag it would reject with an opaque clap usage error (exit 64).
    assert.deepStrictEqual(
      argvLines(stub).filter((l) => l.startsWith('status')),
      [],
      'status must not run against a grim below the floor',
    );
  });

  test('a grim at the floor passes and runs status normally', async function () {
    this.timeout(15000);
    canned(stub, 'context', contextDoc({ version: MINIMUM_GRIM_VERSION, config_exists: true }));
    const scopes = new ScopeService(
      vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'grim-floor-ok-'))),
      recordingOutput([]),
    );
    fs.rmSync(stub.argvLog, { force: true });
    const snapshot = await scopes.snapshot();
    assert.strictEqual(snapshot.error, undefined, 'the floor version itself is supported');
    assert.ok(
      argvLines(stub).some((l) => l.startsWith('status')),
      'status runs once the floor is met',
    );
  });

  test('a too-old grim still reports config_exists, so browse keeps its scope', async function () {
    this.timeout(15000);
    if (!vscode.workspace.workspaceFolders?.length) {
      this.skip(); // project scope is only probed when a folder is open
    }
    canned(stub, 'context', contextDoc({ version: '0.9.1', config_exists: true }));
    const scopes = new ScopeService(
      vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'grim-floor-scope-'))),
      recordingOutput([]),
    );
    const snapshot = await scopes.snapshot();
    // The floor gates STATUS data (install state stays unknown, not empty), but
    // `config_exists` comes off `grim context`, which any version reports.
    // Dropping the whole scope snapshot used to leave projectSearchable false
    // and silently pin browse to global on a stale binary.
    assert.strictEqual(snapshot.project?.context.config_exists, true);
    assert.strictEqual(snapshot.project?.status, null, 'install state stays unknown, not faked');
    assert.strictEqual(
      snapshot.project?.statusUnknownReason,
      'too-old',
      'the render layer picks its action off the reason, not off the message text',
    );
    assert.strictEqual(
      projectSearchable(snapshot),
      true,
      'a configured project stays searchable even below the floor',
    );
  });
});

/** The activity-bar badge (outdated count). It rolls up into the icon number,
 *  so a stale count reads as "you still have updates" after a successful one. */
suite('update badge', () => {
  // Asserted as the published count rather than the ViewBadge object: the badge
  // hangs off the sidebar's WebviewView, which VS Code only resolves when the
  // view first becomes visible, so the count is the part that exists either way.
  const countOf = (api: GrimoireApi): number => api.providers.sidebar.updateCount();

  /** A run override serving one installed artifact whose status `state` the
   *  caller picks — the field the badge count ultimately derives from on a
   *  plain (no --check) refresh. */
  function statusRun(state: string) {
    return (async <T>(args: string[]): Promise<GrimResult<T>> => {
      if (args[0] === 'context') {
        return { ok: true, value: contextDoc({ config_exists: true }) } as GrimResult<T>;
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          value: {
            items: [
              {
                kind: 'skill',
                name: 'badged',
                source: 'direct',
                pinned: 'ghcr.io/grimoire-rs/skills/badged:1.0.0',
                state,
                outputs: [],
                clients_missing: [],
                clients_extra: [],
                deprecated: null,
                replaced_by: null,
                update_available: null,
              },
            ],
          },
        } as GrimResult<T>;
      }
      return {
        ok: true,
        value: { items: [searchItem('ghcr.io/grimoire-rs/skills/badged')] },
      } as GrimResult<T>;
    }) as ScopeService['run'];
  }

  test('the badge tracks the outdated count and clears once the update lands', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const { view } = fakeView();
    api.providers.sidebar.resolveWebviewView(view);
    const originalRun = api.scopes.run;
    try {
      api.scopes.run = statusRun('outdated');
      await api.providers.sidebar.refresh();
      assert.strictEqual(countOf(api), 1, 'an outdated install badges the activity bar');
      // What `grim update` leaves behind: the same artifact, no longer outdated.
      api.scopes.run = statusRun('installed');
      await api.providers.sidebar.refresh();
      assert.strictEqual(
        countOf(api),
        0,
        'the badge must clear after the update — a stale count reads as "still outdated"',
      );
    } finally {
      api.scopes.run = originalRun;
    }
  });

  test('grim going missing clears the count, unlike an unknown install state', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const { view } = fakeView();
    api.providers.sidebar.resolveWebviewView(view);
    const originalRun = api.scopes.run;
    try {
      api.scopes.run = statusRun('outdated');
      await api.providers.sidebar.refresh();
      assert.strictEqual(countOf(api), 1);
      // The executable disappeared (uninstalled, PATH changed). That is a
      // definite answer, not a degraded one — the count must not survive it
      // pointing at an Updates tab that now renders the no-grim state.
      api.scopes.run = (async <T>(): Promise<GrimResult<T>> =>
        ({
          ok: false,
          kind: 'not-found',
          message: 'grim not found',
        }) as GrimResult<T>) as typeof api.scopes.run;
      await api.providers.sidebar.refresh();
      assert.strictEqual(countOf(api), 0);
    } finally {
      api.scopes.run = originalRun;
    }
  });

  test('a failed status freezes the badge AND the posted cards together, never one without the other', async function () {
    this.timeout(15000);
    const api = await activateExtension();
    const { view, states } = fakeView();
    api.providers.sidebar.resolveWebviewView(view);
    const originalRun = api.scopes.run;
    try {
      api.scopes.run = statusRun('outdated');
      await api.providers.sidebar.refresh();
      assert.strictEqual(countOf(api), 1);
      // Install state is now UNKNOWN, not empty. The badge deliberately holds
      // its last value rather than clearing to a "no updates" claim it cannot
      // make. The Updates tab must not contradict it with a bare 0 either —
      // it renders "Install state is unavailable" off installStateUnknown, and
      // the banner explains the frozen count.
      api.scopes.run = (async <T>(args: string[]): Promise<GrimResult<T>> => {
        if (args[0] === 'status') {
          return {
            ok: false,
            kind: 'error',
            code: 'usage',
            exitCode: 64,
            message: 'stale binary',
          } as GrimResult<T>;
        }
        return statusRun('outdated')(args, 'global') as Promise<GrimResult<T>>;
      }) as typeof api.scopes.run;
      await api.providers.sidebar.refresh();
      const last = states.at(-1);
      assert.ok(last);
      assert.strictEqual(last.phase, 'ready', 'the catalog is fine — browsing stays available');
      assert.strictEqual(countOf(api), 1, 'the badge holds its last known count');
      assert.ok(
        last.installStateUnknown?.includes('stale binary'),
        'the tabs render the reason instead of a count that would contradict the badge',
      );
    } finally {
      api.scopes.run = originalRun;
    }
  });
});

suite('workspace fixture', () => {
  test('fixture workspace has grimoire.toml (project scope available)', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'test workspace folder missing');
    assert.ok(fs.existsSync(path.join(folder.uri.fsPath, 'grimoire.toml')));
  });
});

// The global watchers ($GRIM_HOME grimoire.toml/lock, state/global.json) are
// armed off a `grim context --global` probe. One transient failure of that
// probe used to leave them unarmed — or, worse, disarm a set that was already
// live — for the rest of the session, and every global-scope change made
// outside this extension then went unnoticed. Declared last: it repoints
// grimoire.path.executable at its own stub, so it must not run inside the
// shared suite above.
suite('global watcher arming across a failing probe', () => {
  let dir: string;
  let home: string;
  let executable: string;
  let argvLog: string;

  const failProbe = (): string => path.join(dir, 'fail');

  const argvCount = (): number => {
    try {
      // Count only refresh-round spawns (a snapshot's `context`, then `status`),
      // not any spawn: an unrelated round that merely happened to land must not
      // satisfy the wait for the watcher-driven refresh under test.
      return fs
        .readFileSync(argvLog, 'utf8')
        .split('\n')
        .filter((l) => /(?:^|\s)(?:context|status)(?:\s|$)/.test(l)).length;
    } catch {
      return 0;
    }
  };

  /** Rewrites the lock file until the refresh lands: an out-of-workspace
   *  watcher arms asynchronously, and the production debounce is a full
   *  second, so the writes have to be slower than the debounce (a faster
   *  interval would keep resetting it) and repeated past the arming latency. */
  const touchUntilRefreshed = async (): Promise<void> => {
    const before = argvCount();
    const lock = path.join(home, 'grimoire.lock');
    const writer = setInterval(() => fs.writeFileSync(lock, `lock ${Date.now()}\n`), 2500);
    try {
      fs.writeFileSync(lock, `lock ${Date.now()}\n`);
      await waitFor(() => argvCount() > before, 25000);
    } finally {
      clearInterval(writer);
    }
  };

  suiteSetup(function () {
    if (isWindows) {
      this.skip();
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-watch-stub-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-watch-home-'));
    argvLog = path.join(dir, 'argv.log');
    executable = path.join(dir, 'grim');
    // The probe flips between working and failing through a marker FILE, so a
    // test can break it without a configuration change (which would itself
    // re-run rebuildWatchers and mask what is being measured).
    const context = JSON.stringify(contextDoc({ grim_home: home }));
    fs.writeFileSync(
      executable,
      `#!/bin/sh
echo "$@" >> "${argvLog}"
if [ -f "${dir}/fail" ]; then
  echo '{"error":{"code":"failure","exit":70,"message":"transient probe failure"}}'
  exit 0
fi
if [ "$1" = "--global" ]; then shift; fi
if [ "$1" = "context" ]; then
  echo '${context}'
else
  echo '{"items":[]}'
fi
`,
      { mode: 0o755 },
    );
  });

  suiteTeardown(async () => {
    if (isWindows) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('grimoire');
    await cfg.update('path.executable', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('checkForUpdates', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('a refresh arms the global watchers from its own snapshot when the probe failed', async function () {
    this.timeout(60000);
    const api = await activateExtension();
    fs.writeFileSync(failProbe(), '');
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', executable, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500)); // let the failed round settle
    // The binary recovers with no configuration change, so nothing re-runs the
    // probe — only the refresh's own re-arm, off the snapshot it just took,
    // can get this grim home watched.
    fs.rmSync(failProbe(), { force: true });
    await api.refresh();
    await touchUntilRefreshed();
  });

  test('a later failing probe does not disarm the global watchers a refresh armed', async function () {
    this.timeout(60000);
    const api = await activateExtension();
    fs.rmSync(failProbe(), { force: true });
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', executable, vscode.ConfigurationTarget.Global);
    await api.refresh(); // armed on this grim home
    await new Promise((r) => setTimeout(r, 1000));
    // A configuration change re-runs the probe, and this time it fails. The
    // failure knows nothing new about the grim home — re-arming with
    // `undefined` throws away watchers that are working.
    fs.writeFileSync(failProbe(), '');
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('checkForUpdates', false, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 2000));
    fs.rmSync(failProbe(), { force: true }); // transient: the next call works again
    await touchUntilRefreshed();
  });

  // rev-quality#6: a fan-out participant throwing must NOT skip the post-fan-out
  // self-heal that arms the freshly-resolved grim home — an install→refresh where
  // sidebar.refresh throws used to leave the new grim unwatched. Promise.allSettled
  // runs every participant to completion, so the self-heal after it always runs.
  test('a throwing fan-out participant still lets the refresh re-arm the global watchers', async function () {
    this.timeout(60000);
    const api = await activateExtension();
    // Break the probe so neither activation nor the config-change's rebuildWatchers
    // can arm `home`: only the refresh's own self-heal can get it watched.
    fs.writeFileSync(failProbe(), '');
    await vscode.workspace
      .getConfiguration('grimoire')
      .update('path.executable', executable, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500)); // let the failed round settle
    fs.rmSync(failProbe(), { force: true }); // probe works again; nothing re-runs it
    // Seed the cached snapshot the self-heal reads (home), independent of which
    // participant snapshots — so this pins the self-heal, not snapshot timing.
    await api.scopes.snapshot();
    // Make the sidebar participant throw for this round. Under Promise.all the
    // rejection aborts before the self-heal; allSettled lets it run anyway.
    const sidebar = api.providers.sidebar;
    const originalRefresh = sidebar.refresh.bind(sidebar);
    sidebar.refresh = async () => {
      throw new Error('sidebar participant blew up');
    };
    try {
      await api.refresh();
    } finally {
      sidebar.refresh = originalRefresh;
    }
    await touchUntilRefreshed();
  });
});
