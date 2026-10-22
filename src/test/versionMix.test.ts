// VX-R09: this extension release against the grim releases it meets (spec §13.3).
// Stub grims replay recorded 0.14.3 and 0.15.0 output through the real
// SidebarProvider, CatalogService, ScopeService and runJson spawn. G2, a later
// grim, is G1 plus JSON fields the extension has never seen, and must change nothing.
import * as assert from 'assert';
import childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BACKGROUND_PAGE_SIZE, CatalogService, SEARCH_PAGE_SIZE } from '../catalog';
import { REFRESHING_TIMEOUT_MS } from '../grim';
import { ScopeService } from '../scopes';
import { SidebarProvider, type SidebarDelegate } from '../views/sidebar';
import { DEFAULT_FILTER, DEFAULT_VIEW, foldHostPost, type StagedPosts } from '../webview/model';
import type { HostToSidebar, PagingState, SidebarState } from '../webview/protocol';
import { renderSidebarFooter, renderSidebarResults } from '../webview/render';
import { litString } from './litString';
import { normalizeHtml } from './normalizeHtml';

// src/test/fixtures/grim/ holds stdout of grim 0.14.3 and of the 0.15.0 paging
// build against a local 600-entry index (item lists trimmed to 3 rows, paths
// sanitized to /home/u). The 0.15.0 set is hand-adjusted, not a pure recording:
// context.json names version 0.15.0 by hand, and the 'capped' scenario below adds
// `capped: true` in code. Re-record it when grim's JSON changes shape.

const isWindows = process.platform === 'win32';
const FIXTURES = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'grim');

type Json = Record<string, unknown>;
interface Recorded extends Json {
  items: Json[];
  sources: Json[];
}

function fixture<T = Json>(grim: string, name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, grim, `${name}.json`), 'utf8')) as T;
}

/** The recorded fixtures keep three rows; a catalog clones row 0 under new repos. */
function repoAt(n: number): string {
  return `ghcr.io/acme/skills/pkg-${String(n).padStart(5, '0')}`;
}

function rows(grim: string, name: string, count: number, extra: Json = {}): Json[] {
  const template = fixture<Recorded>(grim, name).items[0];
  assert.ok(template, `${grim}/${name} records a row to clone`);
  return Array.from({ length: count }, (_, n) => ({ ...template, ...extra, repo: repoAt(n) }));
}

const expectedRepos = (count: number): string[] =>
  Array.from({ length: count }, (_, n) => repoAt(n));

// --- The stub grim: a POSIX script that logs each argv line and replays files.

interface Stub {
  dir: string;
  executable: string;
  argvLog: string;
}

/** `files` land in the stub's directory; a JSON object is written the way grim
 *  prints it (2-space indent). A `reject-paging` file makes the stub answer
 *  `--limit`/`--offset` like grim 0.14.3: clap's text on stderr, exit 64. */
function writeStub(files: Record<string, string | Json>): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-vxmix-'));
  const argvLog = path.join(dir, 'argv.log');
  const executable = path.join(dir, 'grim');
  const script = `#!/bin/sh
echo "$@" >> "${argvLog}"
if [ "$1" = "--global" ]; then shift; fi
cmd="$1"
case "$cmd" in
  context | status) cat "${dir}/$cmd.json" ;;
  search)
    off=""; limited=""; prev=""
    for arg in "$@"; do
      case "$arg" in
        --limit | --offset)
          if [ -f "${dir}/reject-paging" ]; then
            echo "error: unexpected argument '$arg' found" >&2
            exit 64
          fi ;;
      esac
      if [ "$prev" = "--offset" ]; then off="$arg"; fi
      if [ "$arg" = "--limit" ]; then limited=1; fi
      prev="$arg"
    done
    if [ -n "$off" ]; then page="search@$off.json"
    elif [ -n "$limited" ]; then page="search-loader.json"
    else page="search.json"; fi
    if [ -f "${dir}/search.err" ]; then cat "${dir}/search.err" >&2; fi
    cat "${dir}/$page" ;;
  *) echo '{"error":{"code":"usage","exit":64,"message":"unknown stub command"}}'; exit 64 ;;
esac
`;
  fs.writeFileSync(executable, script, { mode: 0o755 });
  for (const [name, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
    fs.writeFileSync(path.join(dir, name), text);
  }
  return { dir, executable, argvLog };
}

// --- G0: grim 0.14.3, which cannot page.

/** What grim 0.14.3 returns for a cold, unpaged browse: its first 500 rows. */
const G0_ROWS = 500;

function unpagedStub(sources: Json[], stderr?: string): Stub {
  return writeStub({
    'context.json': fixture('0.14.3', 'context'),
    'status.json': { items: [] },
    'search.json': { items: rows('0.14.3', 'search', G0_ROWS), sources },
    'reject-paging': '',
    ...(stderr !== undefined ? { 'search.err': stderr } : {}),
  });
}

// --- G1 and G2: grim 0.15.0, and a later grim that adds fields.

interface Cell {
  name: string;
  /** What `grim context` reports as its version. */
  grim: string;
  /** Adds fields the extension has never seen at every level it reads. */
  future: boolean;
}

const G1: Cell = { name: 'E2xG1 (grim 0.15.0)', grim: '0.15.0', future: false };
const G2: Cell = {
  name: 'E2xG2 (a later grim adding unknown JSON fields)',
  grim: '0.16.0',
  future: true,
};

/** Nested on purpose: an unknown field may be any JSON, not a scalar. */
function future(cell: Cell, level: string): Json {
  return cell.future
    ? { [`future_${level}`]: { nested: [1, { deep: true }] }, [`future_${level}_flag`]: true }
    : {};
}

const BIG = 20_000;
/** The most cards any one host-to-webview post may carry (VX-R03), pinned here rather
 *  than read from the constant so raising the constant cannot quietly pass. */
const MAX_POST_CARDS = 1_000;
/** Enough for a first page and a short background page, with the loader between. */
const SMALL = SEARCH_PAGE_SIZE + BACKGROUND_PAGE_SIZE + 50;

/** The offsets a walk reads: page one, then a background page each. */
function pageOffsets(total: number): number[] {
  const background: number[] = [];
  for (let offset = SEARCH_PAGE_SIZE; offset < total; offset += BACKGROUND_PAGE_SIZE) {
    background.push(offset);
  }
  return [0, ...background];
}

type ScenarioName = 'complete' | 'loaderDown' | 'pageDown' | 'capped';
const SCENARIOS: ScenarioName[] = ['complete', 'loaderDown', 'pageDown', 'capped'];

interface Scenario {
  total: number;
  /** `sources[]` of the online loader run. */
  loader: Json[];
  /** `sources[]` of every `--offline` page read. */
  page: Json[];
}

function scenario(name: ScenarioName): Scenario {
  const loader = fixture<Recorded>('0.15.0', 'search-loader').sources;
  const page = fixture<Recorded>('0.15.0', 'search-page-first').sources;
  switch (name) {
    case 'complete':
      return { total: BIG, loader, page };
    case 'loaderDown':
      // As recorded: the loader sees `down` fail, the offline read reports it ok.
      return {
        total: SMALL,
        loader: fixture<Recorded>('0.15.0', 'search-loader-source-down').sources,
        page: fixture<Recorded>('0.15.0', 'search-page-source-down').sources,
      };
    case 'pageDown':
      // Not recorded as such: a page read that reports the failed source the loader recorded.
      return {
        total: SMALL,
        loader,
        page: fixture<Recorded>('0.15.0', 'search-loader-source-down').sources,
      };
    case 'capped':
      // Not recorded as such: `hub` stops listing early, and says so on every page.
      return { total: SMALL, loader, page: page.map((source) => ({ ...source, capped: true })) };
  }
}

/** The "down" source of the recorded rig, as the log line names it. */
const DOWN = (() => {
  const down = fixture<Recorded>('0.15.0', 'search-loader-source-down').sources[1];
  return `${String(down?.['alias'])}: ${String(down?.['error'])}`;
})();

function pagedStub(cell: Cell, { total, loader, page }: Scenario): Stub {
  const items = rows('0.15.0', 'search-page-first', total, future(cell, 'item'));
  const sources = (listed: Json[]): Json[] =>
    listed.map((source) => ({ ...source, ...future(cell, 'source') }));
  const files: Record<string, string | Json> = {
    'context.json': {
      ...fixture<Json>('0.15.0', 'context'),
      version: cell.grim,
      ...future(cell, 'context'),
    },
    'status.json': { items: [] },
    'search-loader.json': {
      items: items.slice(0, 1),
      sources: sources(loader),
      total,
      truncated: true,
      ...future(cell, 'envelope'),
    },
  };
  for (const offset of pageOffsets(total)) {
    const limit = offset === 0 ? SEARCH_PAGE_SIZE : BACKGROUND_PAGE_SIZE;
    const slice = items.slice(offset, offset + limit);
    files[`search@${offset}.json`] = {
      items: slice,
      sources: sources(page),
      total,
      // grim sets it on every page past the first, and on a first page that cuts rows.
      truncated: offset > 0 || offset + slice.length < total,
      ...future(cell, 'envelope'),
    };
  }
  return writeStub(files);
}

// --- Driving the real host, and what it did.

interface Spawn {
  /** The argv runJson handed execFile, joined. */
  line: string;
  timeout: number | undefined;
}

/** Records every execFile of `executable` and calls through. `runJson` reads
 *  `execFile` off the module at call time, so this sees its `timeout` option
 *  without a production seam. */
function spyOnSpawns(executable: string): { spawns: Spawn[]; restore: () => void } {
  const spawns: Spawn[] = [];
  const module = childProcess as { execFile: unknown };
  const real = module.execFile as (...args: unknown[]) => unknown;
  module.execFile = (
    file: string,
    args: readonly string[],
    options: { timeout?: number },
    ...rest: unknown[]
  ) => {
    if (file === executable) {
      spawns.push({ line: args.join(' '), timeout: options.timeout });
    }
    return real(file, args, options, ...rest);
  };
  return { spawns, restore: () => (module.execFile = real) };
}

function sidebar(
  scopes: ScopeService,
  catalog: CatalogService,
  output: vscode.OutputChannel,
): { provider: SidebarProvider; posted: HostToSidebar[] } {
  const delegate: SidebarDelegate = {
    openDetails: () => {},
    installGrim: async () => {},
    refreshAll: async () => {},
    pin: async () => {},
    pickVersion: async () => {},
    suspendWhile: (fn) => fn(),
    cachedCardMeta: async () => new Map(),
    expireCached: () => {},
    prefetch: () => {},
  };
  const store = new Map<string, unknown>();
  const memento = {
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as vscode.Memento;
  const posted: HostToSidebar[] = [];
  const view = {
    viewType: 'grimoire.sidebar',
    visible: true,
    show: () => {},
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    badge: undefined,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      // Serialized at the call, as VS Code does: the host keeps growing the arrays it posted.
      postMessage: (message: HostToSidebar) => {
        posted.push(structuredClone(message));
        return Promise.resolve(true);
      },
    },
  } as unknown as vscode.WebviewView;
  const provider = new SidebarProvider(
    vscode.Uri.file(os.tmpdir()),
    scopes,
    catalog,
    delegate,
    output,
    memento,
  );
  provider.resolveWebviewView(view);
  return { provider, posted };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(20);
  }
}

function lastPaging(posted: HostToSidebar[]): PagingState | undefined {
  for (const message of [...posted].reverse()) {
    const paging =
      message.type === 'append'
        ? message.paging
        : message.type === 'state'
          ? message.state.paging
          : undefined;
    if (paging) {
      return paging;
    }
  }
  return undefined;
}

/** The list a webview holds after it handles every post in order, by its own rules. */
function paint(posted: HostToSidebar[]): SidebarState {
  let state: SidebarState | null = null;
  let staged: StagedPosts | null = null;
  for (const message of posted) {
    if (message.type === 'state' || message.type === 'append') {
      const step = foldHostPost(staged, state, message);
      assert.ok(step.staged || step.commit, 'a post continues exactly the list the webview holds');
      staged = step.staged;
      state = step.commit?.state ?? state;
    }
  }
  assert.strictEqual(staged, null, 'the last post closes its run');
  assert.ok(state, 'the host posted a state');
  return state;
}

interface Run {
  posted: HostToSidebar[];
  /** The output channel. */
  lines: string[];
  /** Each process the stub saw, from its own log. */
  argv: string[];
  /** The same processes, with the deadline runJson gave each. */
  spawns: Spawn[];
  /** The webview's list once every post is replayed. */
  state: SidebarState;
}

/** One cold browse: ready, refresh, and every page the host loads after it. */
async function browse(stub: Stub): Promise<Run> {
  const lines: string[] = [];
  const output = {
    appendLine: (line: string) => lines.push(line),
  } as unknown as vscode.OutputChannel;
  const scopes = new ScopeService(vscode.Uri.file(stub.dir), output);
  scopes.projectFolder = () => undefined;
  scopes.resolvedExecutable = () => ({ path: stub.executable, origin: 'setting' });
  const { provider, posted } = sidebar(scopes, new CatalogService(scopes), output);
  const spy = spyOnSpawns(stub.executable);
  try {
    await provider.handleMessage({ type: 'ready' });
    await until(() => lastPaging(posted)?.hasMore !== true, 'the list to finish loading');
    await delay(100);
    const argv = fs
      .readFileSync(stub.argvLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    assert.deepStrictEqual(
      spy.spawns.map((s) => s.line).sort(),
      [...argv].sort(),
      'the spy saw exactly the processes the stub did',
    );
    return { posted, lines, argv, spawns: spy.spawns, state: paint(posted) };
  } finally {
    spy.restore();
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
}

const runs = new Map<string, Promise<Run>>();

/** A scenario's browse, run once per cell and shared by every test that reads it. */
function scenarioRun(cell: Cell, name: ScenarioName): Promise<Run> {
  const key = `${cell.name}/${name}`;
  let run = runs.get(key);
  if (!run) {
    run = browse(pagedStub(cell, scenario(name)));
    runs.set(key, run);
  }
  return run;
}

// --- Reading a run.

const isSearch = (line: string): boolean => line.startsWith('--global search');
const isLoader = (line: string): boolean => isSearch(line) && !line.includes('--offline');
const logged = (run: Run): string[] =>
  run.lines.filter((line) => line.startsWith('sidebar: incomplete results'));
const incomplete = (line: string): string => `sidebar: incomplete results — ${line}`;

/** Every card count a post carries, so no single message can hide a huge list. */
function postedCards(posted: HostToSidebar[]): number[] {
  return posted.flatMap((m) =>
    m.type === 'state'
      ? [m.state.items.length, m.state.installedItems.length]
      : m.type === 'append'
        ? [m.cards.length, m.installed?.length ?? 0]
        : [],
  );
}

const litHtml = async (out: unknown): Promise<string> => normalizeHtml(await litString(out));

/** The footer turns into the "Incomplete results" button, class `footer-alert`. */
async function footerLit(state: SidebarState): Promise<boolean> {
  return (await litHtml(renderSidebarFooter(state))).includes('footer-alert');
}

function skipOnWindows(this: Mocha.Context): void {
  if (isWindows) {
    this.skip();
  }
}

// --- E2 x G0

suite('version mix E2xG0 (grim 0.14.3): works, paging gated off', function () {
  this.timeout(60_000);
  suiteSetup(skipOnWindows);

  test('browse sends no --limit or --offset and lists the unpaged rows, with no paging state', async () => {
    const run = await browse(unpagedStub(fixture<Recorded>('0.14.3', 'search').sources));
    assert.deepStrictEqual(run.argv.filter(isSearch), ['--global search --format json']);
    assert.ok(
      !run.argv.some((line) => /--(limit|offset)/.test(line)),
      'the stub exits 64 on either, so none was sent',
    );
    assert.ok(!run.lines.some((line) => line.includes('exited 64')));
    assert.strictEqual(run.state.phase, 'ready');
    assert.deepStrictEqual(
      run.state.items.map((card) => card.repo),
      expectedRepos(G0_ROWS),
    );
    assert.strictEqual(run.state.paging, undefined, 'no paging state, so no walker and no Retry');
    assert.deepStrictEqual(
      run.posted.filter((m) => m.type === 'append'),
      [],
    );
    assert.strictEqual(run.state.catalogIncomplete, undefined);
    assert.strictEqual(await footerLit(run.state), false);
  });

  test('the unpaged search gets the refreshing deadline', async () => {
    const run = await browse(unpagedStub(fixture<Recorded>('0.14.3', 'search').sources));
    const search = run.spawns.find((s) => isSearch(s.line));
    assert.ok(search, 'a search ran');
    assert.ok((search.timeout ?? 0) >= REFRESHING_TIMEOUT_MS, `${search.line}: ${search.timeout}`);
  });

  test('a source with ok: false lights Incomplete results and is logged', async () => {
    const down = fixture<Recorded>('0.14.3', 'search-source-down').sources;
    const run = await browse(unpagedStub(down));
    assert.strictEqual(run.state.catalogIncomplete, true);
    assert.strictEqual(await footerLit(run.state), true);
    assert.deepStrictEqual(logged(run), [incomplete(DOWN)]);
    assert.strictEqual(run.state.items.length, G0_ROWS, 'the rows that did load still list');
  });

  test('the cap warning on stderr lights Incomplete results: 0.14.x reports the cap nowhere else', async () => {
    const warning = 'WARN catalog listing capped at 500 repositories; results may be incomplete';
    const run = await browse(unpagedStub(fixture<Recorded>('0.14.3', 'search').sources, warning));
    assert.strictEqual(run.state.catalogIncomplete, true);
    assert.strictEqual(await footerLit(run.state), true);
    assert.deepStrictEqual(logged(run), [incomplete(warning)]);
    assert.strictEqual(run.state.items.length, G0_ROWS, 'the rows that did load still list');
  });
});

// --- E2 x G1 and E2 x G2

function describeCell(cell: Cell): void {
  suite(
    `version mix ${cell.name}: windowed list, sources[] verdict, refreshing deadline`,
    function () {
      this.timeout(180_000);
      suiteSetup(skipOnWindows);

      test('a 20,000-row browse asks for a loader, a first page, then background pages', async () => {
        const run = await scenarioRun(cell, 'complete');
        const searches = run.argv.filter(isSearch);
        assert.deepStrictEqual(searches.filter(isLoader), [
          '--global search --limit 1 --format json',
        ]);
        const reads = searches.filter((line) => !isLoader(line));
        const first = `--global search --offline --limit ${SEARCH_PAGE_SIZE} --offset 0 --format json`;
        // Once the loader ends, the host reads page one again; whether that precedes the
        // last page depends on when the loader settled, so only the background reads are ordered.
        assert.ok(reads.includes(first), 'page one');
        assert.deepStrictEqual(
          reads.filter((line) => line !== first),
          pageOffsets(BIG)
            .slice(1)
            .map(
              (offset) =>
                `--global search --offline --limit ${BACKGROUND_PAGE_SIZE} --offset ${offset} --format json`,
            ),
        );
      });

      test('every row loads once, in order, and the list completes', async () => {
        const { state } = await scenarioRun(cell, 'complete');
        assert.deepStrictEqual(
          state.items.map((card) => card.repo),
          expectedRepos(BIG),
        );
        const { loaded, total, lowerBound, hasMore } = state.paging ?? {};
        assert.deepStrictEqual(
          { loaded, total, lowerBound, hasMore },
          { loaded: BIG, total: BIG, lowerBound: false, hasMore: false },
        );
      });

      test(`no host-to-webview post carries more than ${MAX_POST_CARDS} cards`, async () => {
        const { posted } = await scenarioRun(cell, 'complete');
        const sizes = postedCards(posted);
        assert.ok(
          Math.max(...sizes) <= MAX_POST_CARDS,
          `largest post: ${Math.max(...sizes)} cards`,
        );
        assert.ok(
          sizes.filter((n) => n > 0).length >= BIG / MAX_POST_CARDS,
          'precondition: the list did arrive in pieces',
        );
      });

      test('the 20,000-row state renders as a bounded window', async () => {
        const { state } = await scenarioRun(cell, 'complete');
        const html = await litHtml(
          renderSidebarResults(state, DEFAULT_FILTER, DEFAULT_VIEW, new Set<string>()),
        );
        const rendered = html.match(/data-key="/g)?.length ?? 0;
        assert.ok(rendered > 0 && rendered <= 200, `${rendered} rows rendered`);
      });

      test('sources[] that all loaded light nothing', async () => {
        const run = await scenarioRun(cell, 'complete');
        assert.ok(
          run.posted.every((m) =>
            m.type === 'state'
              ? m.state.catalogIncomplete === undefined
              : m.type !== 'append' || m.catalogIncomplete !== true,
          ),
          'no post carries the mark',
        );
        assert.strictEqual(await footerLit(run.state), false);
        assert.deepStrictEqual(logged(run), []);
      });

      test('a source the loader found down lights Incomplete results and is logged once', async () => {
        const run = await scenarioRun(cell, 'loaderDown');
        assert.strictEqual(run.state.items.length, SMALL, 'the rows that did load still list');
        assert.strictEqual(run.state.catalogIncomplete, true);
        assert.strictEqual(await footerLit(run.state), true);
        assert.deepStrictEqual(logged(run), [incomplete(DOWN)]);
      });

      test('a page whose sources[] has ok: false lights Incomplete results', async () => {
        const run = await scenarioRun(cell, 'pageDown');
        assert.strictEqual(run.state.catalogIncomplete, true);
        assert.strictEqual(await footerLit(run.state), true);
        assert.deepStrictEqual(logged(run), [incomplete(DOWN)]);
      });

      test('a capped source lights Incomplete results and makes the total a lower bound', async () => {
        const run = await scenarioRun(cell, 'capped');
        assert.strictEqual(run.state.catalogIncomplete, true);
        assert.strictEqual(await footerLit(run.state), true);
        assert.deepStrictEqual(logged(run), [incomplete('hub: listing incomplete')]);
        assert.strictEqual(run.state.paging?.lowerBound, true);
      });

      // The deadline is read off the execFile options. The loader is held to the spec's
      // floor rather than to LOADER_TIMEOUT_MS, so retuning that constant stays green.
      test('every call that can reach the registries gets at least the refreshing deadline', async () => {
        const { spawns } = await scenarioRun(cell, 'complete');
        const online = spawns.filter((s) => !s.line.includes('--offline'));
        assert.ok(
          online.some((s) => s.line.includes('context')) && online.some((s) => isLoader(s.line)),
          'precondition: the context probe and the loader are among them',
        );
        for (const spawn of online) {
          assert.ok(
            (spawn.timeout ?? 0) >= REFRESHING_TIMEOUT_MS,
            `${spawn.line}: ${spawn.timeout} ms`,
          );
        }
      });
    },
  );
}

describeCell(G1);
describeCell(G2);

// --- G2 against G1

suite('version mix E2xG2 behaves as E2xG1: unknown JSON fields change nothing', function () {
  this.timeout(180_000);
  suiteSetup(skipOnWindows);
  suiteTeardown(() => runs.clear());

  const outcome = (run: Run): unknown => {
    const { loaded, total, lowerBound, hasMore } = run.state.paging ?? {};
    return {
      items: run.state.items,
      paging: { loaded, total, lowerBound, hasMore },
      incomplete: run.state.catalogIncomplete === true,
      logged: logged(run),
      // Distinct, because the re-read after the loader ends may or may not repeat page one.
      requests: [...new Set(run.argv)].sort(),
    };
  };

  for (const name of SCENARIOS) {
    test(`${name}: same rows, same paging, same verdict, same requests`, async () => {
      const g1 = await scenarioRun(G1, name);
      const g2 = await scenarioRun(G2, name);
      assert.deepStrictEqual(outcome(g2), outcome(g1));
    });
  }
});
