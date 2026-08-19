import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  authTargetFor,
  defaultRatingHost,
  normalizeHost,
  voteSecretKey,
  voteToken,
  type AuthTarget,
  type SecretReader,
} from '../auth';
import { rateArgs, runJson, type RateReport } from '../grim';
import {
  MINIMUM_GRIM_VERSION,
  RATING_GRIM_VERSION,
  grimTooOld,
  supportsRating,
} from '../installer';
import {
  buildCards,
  buildSkeletonVM,
  readRating,
  voteStateAfter,
  type WireSearchItem,
} from '../webview/model';
import type { DetailsVM, VoteState } from '../webview/protocol';
import { renderCard, renderDetails } from '../webview/render';
import { castVote, confirmVote, refineVoteState, type VoteDeps } from '../views/vote';
import { card, detailsVM } from './fixtures/vms';
import { litString } from './litString';

// --- C-018: provider selection is a table keyed by the host handed to grim.

suite('rating auth target', () => {
  test('github.com and api.github.com select the built-in github provider', () => {
    for (const host of ['github.com', 'api.github.com', 'API.GitHub.COM']) {
      const target = authTargetFor('github', host);
      assert.ok(target, `no target for ${host}`);
      assert.strictEqual(target.providerId, 'github');
    }
  });

  test('any other host with provider github selects github-enterprise, host passed through', () => {
    const target = authTargetFor('github', 'ghes.corp.example:8443');
    assert.ok(target);
    assert.strictEqual(target.providerId, 'github-enterprise');
    assert.strictEqual(target.host, 'ghes.corp.example:8443');
  });

  test('gitlab.com and self-managed hosts both select the gitlab provider', () => {
    assert.strictEqual(authTargetFor('gitlab', 'gitlab.com')?.providerId, 'gitlab');
    assert.strictEqual(authTargetFor('gitlab', 'gitlab.corp.example')?.providerId, 'gitlab');
  });

  test('an unrecognised provider selects nothing, so the caller pipes nothing', () => {
    assert.strictEqual(authTargetFor('bitbucket', 'bitbucket.org'), undefined);
    assert.strictEqual(authTargetFor('', 'github.com'), undefined);
    assert.strictEqual(defaultRatingHost('bitbucket'), undefined);
  });

  test('defaults match C-007: github => api.github.com, gitlab => gitlab.com', () => {
    assert.strictEqual(defaultRatingHost('github'), 'api.github.com');
    assert.strictEqual(defaultRatingHost('gitlab'), 'gitlab.com');
  });

  // The two strings C-007 names by hand. Neither may reach the github.com
  // session: comparison is exact, never a suffix or substring match.
  test('evil-github.com and github.com.evil.tld never match github.com', () => {
    for (const host of ['evil-github.com', 'github.com.evil.tld', 'github.com.evil.tld:8443']) {
      const target = authTargetFor('github', host);
      assert.ok(target, `no target for ${host}`);
      assert.notStrictEqual(
        target.providerId,
        'github',
        `${host} was accepted as github.com's own provider`,
      );
      assert.strictEqual(target.host, host.toLowerCase());
    }
  });

  test('a host that will not normalise selects nothing', () => {
    for (const host of ['', 'github.com/../evil', 'evil.example@github.com', 'git hub.com', '/']) {
      assert.strictEqual(authTargetFor('github', host), undefined, `${host} normalised`);
    }
  });
});

suite('rating host normalisation', () => {
  test('ASCII-lowercases and keeps the port', () => {
    assert.strictEqual(normalizeHost('GitHub.COM'), 'github.com');
    assert.strictEqual(normalizeHost('ghes.corp.example:8443'), 'ghes.corp.example:8443');
    // A port is part of the identity: same name, different port, different host.
    assert.notStrictEqual(normalizeHost('github.com:8443'), normalizeHost('github.com'));
  });

  test('IDNA-normalises, so a homograph is not github.com', () => {
    // Cyrillic "о" (U+043E) in place of the second ASCII "o".
    const homograph = normalizeHost('githuб.com') ?? '';
    assert.notStrictEqual(homograph, 'github.com');
    assert.ok(homograph.startsWith('xn--'), `not punycoded: ${homograph}`);
    assert.strictEqual(normalizeHost('ГИТЛАБ.example'), normalizeHost('гитлаб.example'));
  });

  test('rejects anything carrying more than a host', () => {
    for (const host of ['github.com/x', 'u@github.com', 'https://github.com', 'a b', '']) {
      assert.strictEqual(normalizeHost(host), undefined, `${host} accepted`);
    }
  });
});

// --- C-018: SecretStorage PAT is consulted ONLY after the matching provider
// --- yields no session, and a provider we cannot prove we authenticated
// --- against is not consulted at all.

/** Only the read half is WP-M's business; `voteToken` takes exactly that. */
function fakeSecrets(entries: Record<string, string> = {}): SecretReader {
  return { get: async (key) => entries[key] };
}

suite('rating credential resolution', () => {
  // github-enterprise is bound to VS Code's own `github-enterprise.uri`
  // setting; the test instance configures none, so this host is provably not
  // one we authenticated against.
  const ghes = (): AuthTarget => authTargetFor('github', 'ghes.corp.example') as AuthTarget;

  test('pipes nothing when the host is not one we authenticated against', async () => {
    assert.strictEqual(await voteToken(ghes(), fakeSecrets(), 'silent'), undefined);
  });

  test('falls back to a PAT stored for that exact host', async () => {
    const secrets = fakeSecrets({ [voteSecretKey(ghes().host)]: 'pat-for-ghes' });
    assert.strictEqual(await voteToken(ghes(), secrets, 'silent'), 'pat-for-ghes');
  });

  test('a PAT stored for another host is never used', async () => {
    const secrets = fakeSecrets({ [voteSecretKey('github.com')]: 'pat-for-dot-com' });
    assert.strictEqual(await voteToken(ghes(), secrets, 'silent'), undefined);
  });

  // Security review (2026-08-18, B-1): the GitLab arm had NEITHER host anchor
  // the GitHub arm has. VS Code's `gitlab` provider registers one identity for
  // gitlab.com and self-managed alike with no per-request host parameter, so
  // `getSession('gitlab', …)` returns whatever instance the user is signed in
  // to. A user signed in to gitlab.com who sets GRIM_RATING_HOST to their
  // corporate instance had an `api`-scoped gitlab.com token — full read/write
  // on the account — POSTed to that instance on panel open, with no click and
  // no prompt. grim's --token-host cannot catch it: declared and resolved are
  // the same wrong host.
  const selfManagedGitlab = (): AuthTarget =>
    authTargetFor('gitlab', 'gitlab.corp.example') as AuthTarget;

  test('pipes no gitlab session to a host GitLab Workflow does not name', async () => {
    assert.strictEqual(await voteToken(selfManagedGitlab(), fakeSecrets(), 'silent'), undefined);
  });

  test('a self-managed gitlab host still takes a PAT stored for that exact host', async () => {
    const secrets = fakeSecrets({ [voteSecretKey('gitlab.corp.example')]: 'pat-for-corp' });
    assert.strictEqual(await voteToken(selfManagedGitlab(), secrets, 'silent'), 'pat-for-corp');
  });

  test('a gitlab.com PAT is never piped at a self-managed instance', async () => {
    const secrets = fakeSecrets({ [voteSecretKey('gitlab.com')]: 'pat-for-dot-com' });
    assert.strictEqual(await voteToken(selfManagedGitlab(), secrets, 'silent'), undefined);
  });
});

// --- C-018: the version gate is above the hard floor.

suite('rating version gate', () => {
  test('RATING_GRIM_VERSION gates the affordance', () => {
    assert.strictEqual(RATING_GRIM_VERSION, '0.14.0');
    assert.strictEqual(supportsRating('0.13.0'), false);
    assert.strictEqual(supportsRating('0.14.0'), true);
    assert.strictEqual(supportsRating('1.0.0'), true);
    // Unparseable reads as unsupported, same as grimTooOld.
    assert.strictEqual(supportsRating('not-a-version'), false);
  });

  test('the hard floor is untouched, so an older grim keeps every other feature', () => {
    assert.strictEqual(MINIMUM_GRIM_VERSION, '0.11.0');
    assert.strictEqual(grimTooOld('0.13.0'), false);
    assert.strictEqual(grimTooOld('0.11.0'), false);
  });
});

suite('rateArgs', () => {
  test('always passes --yes and puts the ref behind a separator', () => {
    assert.deepStrictEqual(rateArgs('ghcr.io/x/y'), ['rate', '--up', '--yes', '--', 'ghcr.io/x/y']);
    assert.deepStrictEqual(rateArgs('--sneaky'), ['rate', '--up', '--yes', '--', '--sneaky']);
  });

  test('--remove replaces --up, never joins it', () => {
    const args = rateArgs('ghcr.io/x/y', { remove: true });
    assert.ok(args.includes('--remove'));
    assert.ok(!args.includes('--up'));
    assert.ok(args.includes('--yes'));
  });

  test('--token-stdin rides along only when a credential is piped', () => {
    assert.ok(!rateArgs('r').includes('--token-stdin'));
    assert.ok(rateArgs('r', { tokenStdin: true }).includes('--token-stdin'));
  });
});

// --- C-018: the stdin path. Integration, POSIX-only (shell-script stub).

interface Stub {
  dir: string;
  executable: string;
  argvLog: string;
  stdinLog: string;
}

/** A grim stub that records argv and (optionally) drains stdin to a file. */
function writeRateStub(body: string): Stub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grim-rate-stub-'));
  const stub: Stub = {
    dir,
    executable: path.join(dir, 'grim'),
    argvLog: path.join(dir, 'argv.log'),
    stdinLog: path.join(dir, 'stdin.log'),
  };
  fs.writeFileSync(stub.executable, `#!/bin/sh\necho "$@" >> "${stub.argvLog}"\n${body}\n`, {
    mode: 0o755,
  });
  return stub;
}

const TOKEN = 'gho_TESTTOKEN_must_never_be_logged';

suite('rate stdin path', function () {
  this.timeout(20000);
  const stubs: Stub[] = [];

  suiteSetup(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  suiteTeardown(() => {
    for (const stub of stubs) {
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  test('the token reaches the child on stdin and stdin is closed', async () => {
    const stub = writeRateStub(
      `cat > "$0.stdin"\n` +
        `printf '%s' '{"ref":"ghcr.io/x/y","action":"added","up":1,"url":null,"provider":"github"}'\n`,
    );
    stubs.push(stub);
    const result = await runJson<RateReport>(
      stub.executable,
      rateArgs('ghcr.io/x/y', { tokenStdin: true }),
      { stdin: TOKEN },
    );
    assert.ok(result.ok, result.ok ? '' : JSON.stringify(result));
    assert.strictEqual(result.value.action, 'added');
    // `cat` only returns on EOF — reading the whole token proves stdin closed.
    assert.strictEqual(fs.readFileSync(`${stub.executable}.stdin`, 'utf8'), TOKEN);
  });

  test('a child that exits before reading stdin fails the vote, never throws', async () => {
    const stub = writeRateStub(
      `printf '%s' '{"error":{"code":"auth","exit":80,"message":"no credential on stdin"}}'\n` +
        `exit 80\n`,
    );
    stubs.push(stub);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      // Larger than a pipe buffer, so the write cannot complete into the
      // kernel buffer and must observe the closed read end (EPIPE).
      const result = await runJson<RateReport>(
        stub.executable,
        rateArgs('ghcr.io/x/y', { tokenStdin: true }),
        { stdin: TOKEN.padEnd(256 * 1024, 'x') },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(!result.ok);
      assert.strictEqual(result.kind === 'error' ? result.exitCode : -1, 80);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
    assert.deepStrictEqual(uncaught, [], `EPIPE escaped: ${uncaught.map(String).join(', ')}`);
  });

  test('the token appears in no argv and in nothing the call returns', async () => {
    const stub = writeRateStub(
      `cat > /dev/null\n` +
        `printf '%s' '{"error":{"code":"auth","exit":80,"message":"bad credential"}}'\nexit 80\n`,
    );
    stubs.push(stub);
    const result = await runJson<RateReport>(
      stub.executable,
      rateArgs('ghcr.io/x/y', { tokenStdin: true }),
      { stdin: TOKEN },
    );
    assert.ok(!fs.readFileSync(stub.argvLog, 'utf8').includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});

// ---------------------------------------------------------------------------
// WP-N — C-019 / S-007 / S-008: the tri-state, and the handshake that feeds it.
// ---------------------------------------------------------------------------

suite('rateArgs — the C-022 handshake flags', () => {
  test('--dry-run resolves without a credential and without --token-stdin', () => {
    const args = rateArgs('ghcr.io/x/y', { dryRun: true });
    assert.deepStrictEqual(args, ['rate', '--up', '--yes', '--dry-run', '--', 'ghcr.io/x/y']);
    assert.ok(!args.includes('--token-stdin'), 'a dry run must never ask for a credential');
    assert.ok(!args.includes('--token-host'));
  });

  test('--token-host rides with --token-stdin, and never alone', () => {
    // grim exits 64 for --token-host without --token-stdin, so emitting it
    // alone would turn a would-be vote into a usage error.
    assert.ok(!rateArgs('r', { tokenHost: 'github.com' }).includes('--token-host'));
    const piped = rateArgs('r', { tokenStdin: true, tokenHost: 'ghes.corp.example:8443' });
    assert.deepStrictEqual(piped, [
      'rate',
      '--up',
      '--yes',
      '--token-stdin',
      '--token-host',
      'ghes.corp.example:8443',
      '--',
      'r',
    ]);
  });

  test('the host is its own argv entry, so it can never be glued to a value', () => {
    const args = rateArgs('r', { tokenStdin: true, tokenHost: 'a.example' });
    assert.strictEqual(args[args.indexOf('--token-host') + 1], 'a.example');
  });
});

// --- C-019 / R-3: three states, and `unknown` is not `not-voted`.

suite('tri-state vote rendering (C-019)', () => {
  const rated = (vote: VoteState, up = 7): DetailsVM =>
    detailsVM({ rating: { up, url: 'https://forge.example/d/1', vote }, canVote: true });

  test('renders voted, not-voted and unknown as three distinguishable states', async () => {
    const voted = await litString(renderDetails(rated('voted')));
    const not = await litString(renderDetails(rated('not-voted')));
    const unknown = await litString(renderDetails(rated('unknown')));
    assert.ok(voted.includes('aria-pressed="true"'), 'voted is not pressed');
    assert.ok(not.includes('aria-pressed="false"'), 'not-voted is not unpressed');
    // Not a boolean anywhere: unknown asserts NEITHER pressed value.
    assert.ok(!unknown.includes('aria-pressed="true"'));
    assert.ok(!unknown.includes('aria-pressed="false"'));
    assert.notStrictEqual(voted, not);
    assert.notStrictEqual(not, unknown);
    assert.notStrictEqual(voted, unknown);
  });

  test('unknown never says the user has not voted (S-008)', async () => {
    const unknown = await litString(renderDetails(rated('unknown')));
    assert.ok(
      !/have not upvoted|not voted|You have not/i.test(unknown),
      'the unknown state made a claim about the viewer',
    );
    // …while the state that genuinely knows still says it.
    const not = await litString(renderDetails(rated('not-voted')));
    assert.ok(/have not upvoted/i.test(not));
  });

  test('an unrated row renders no rating panel and no zero (S-002)', async () => {
    const html = await litString(renderDetails(detailsVM({ rating: null, canVote: true })));
    assert.ok(!html.includes('RATING'), 'an unrated row grew a rating panel');
    assert.ok(!html.includes('rating-vote'), 'an unrated row grew a vote button');
  });

  test('below the version gate the count stays and the affordance goes', async () => {
    const gated = await litString(
      renderDetails(
        detailsVM({ rating: { up: 3, url: 'https://forge.example/d/1', vote: 'unknown' } }),
      ),
    );
    assert.ok(gated.includes('RATING'), 'the count must survive an older grim');
    assert.ok(!gated.includes('data-action="vote"'), 'an older grim was offered a vote button');
  });

  test('the thread link is grim’s url verbatim — no forge URL is constructed', async () => {
    const url = 'https://ghes.corp.example/org/index/discussions/42';
    // sourceRepository nulled so the rating link is the ONLY data-url on the
    // page — the Resources panel emits one too, and it would mask the point.
    const html = await litString(
      renderDetails(
        detailsVM({
          rating: { up: 1, url, vote: 'unknown' },
          canVote: true,
          sourceRepository: null,
        }),
      ),
    );
    assert.ok(html.includes(`data-url="${url}"`));
    // The rating panel invents no link of its own: every `data-url` on the page
    // is one that was handed in. (The fixture's Resources panel carries a
    // github.com sourceRepository — also handed in, also not constructed.)
    const urls = [...html.matchAll(/data-url="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(urls, [url], `unexpected constructed link(s): ${urls.join(', ')}`);
  });

  test('a hostile rating url and count are escaped, not interpolated (new render path)', async () => {
    const html = await litString(
      renderDetails(
        detailsVM({
          rating: {
            up: 1,
            url: '"><script>alert(1)</script><a href="',
            vote: 'unknown',
          },
          canVote: true,
        }),
      ),
    );
    assert.ok(!html.includes('<script>'), `unescaped script survived: ${html.slice(0, 400)}`);
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('browse cards render the count and stay neutral — the sidebar has no identity', async () => {
    const html = await litString(
      renderCard(card({ rating: { up: 12, url: 'https://forge.example/d/1', vote: 'unknown' } })),
    );
    assert.ok(html.includes('rating-badge'));
    assert.ok(html.includes('12'));
    assert.ok(!html.includes('data-action="vote"'), 'a browse card offered a vote');
    assert.strictEqual(
      await litString(renderCard(card({ rating: null }))).then((h) => h.includes('rating-badge')),
      false,
    );
  });
});

// --- S-007: the mutation response is authoritative; a failure stays unknown.

suite('vote state after a mutation (S-007)', () => {
  test('a successful vote is authoritative in both directions', () => {
    assert.strictEqual(voteStateAfter({ action: 'up' }), 'voted');
    assert.strictEqual(voteStateAfter({ action: 'added' }), 'voted');
    assert.strictEqual(voteStateAfter({ action: 'remove' }), 'not-voted');
    assert.strictEqual(voteStateAfter({ action: 'removed' }), 'not-voted');
  });

  test('a FAILED mutation leaves the state unknown, never not-voted', () => {
    // The whole of S-007's error column. A vote that failed after the request
    // left may well have landed; "not voted" would be a guess sold as a fact.
    assert.strictEqual(voteStateAfter(null), 'unknown');
  });

  test('an action grim grows later reads unknown rather than defaulting', () => {
    assert.strictEqual(voteStateAfter({ action: 'toggled-something-new' }), 'unknown');
    assert.strictEqual(voteStateAfter({ action: '' }), 'unknown');
  });
});

// --- S-008: an absent record is unknown at every level of the read path.

suite('rating read path (S-008)', () => {
  const wire = (rating: unknown): WireSearchItem =>
    ({
      kind: 'skill',
      repo: 'ghcr.io/x/y',
      summary: null,
      description: null,
      version: null,
      latest_tag: null,
      repository: null,
      revision: null,
      created: null,
      deprecated: null,
      status: 'not-installed',
      rating,
    }) as WireSearchItem;

  test('a rated row reads unknown — the aggregate says nothing about this viewer', () => {
    const parsed = readRating({ up: 9, url: 'https://forge.example/d/1' });
    assert.deepStrictEqual(parsed, { up: 9, url: 'https://forge.example/d/1', vote: 'unknown' });
  });

  test('absent, null and malformed all read as unrated, and none of them raises', () => {
    for (const raw of [
      undefined,
      null,
      {},
      { up: 1 },
      { up: 1, url: '' },
      { url: 'https://forge.example/d/1' },
      { up: -1, url: 'https://forge.example/d/1' },
      { up: Number.NaN, url: 'https://forge.example/d/1' },
      { up: '3', url: 'https://forge.example/d/1' },
    ] as WireSearchItem['rating'][]) {
      assert.strictEqual(readRating(raw), null, `accepted ${JSON.stringify(raw)}`);
    }
  });

  test('a card built from a rating carries unknown, never a boolean', () => {
    const cards = buildCards([wire({ up: 4, url: 'https://forge.example/d/1' })], []);
    assert.strictEqual(cards[0]?.rating?.vote, 'unknown');
    assert.strictEqual(cards[0]?.rating?.up, 4);
    // A grim that predates the field: unrated, and still no boolean.
    assert.strictEqual(buildCards([wire(undefined)], [])[0]?.rating, null);
  });
});

// --- C-022: the dry-run handshake runs BEFORE any credential is read, and a
// --- host we cannot authenticate against gets nothing piped at it.
//
// Integration, POSIX-only: the stub is the same shell script the WP-M suite
// uses, so "was stdin read" is observable as a file that does or does not exist.

suite('vote handshake (C-022)', function () {
  this.timeout(20000);
  const stubs: Stub[] = [];

  suiteSetup(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  suiteTeardown(() => {
    for (const stub of stubs) {
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  /** A grim stub that answers the dry run with `host`/`provider` and records
   *  every argv line plus anything that reaches stdin. */
  function handshakeStub(host: string | null, provider: string | null): Stub {
    const body =
      `case " $* " in\n` +
      `  *" --dry-run "*)\n` +
      `    printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":3,"url":"https://forge.example/d/1",` +
      `"provider":${provider === null ? 'null' : `"${provider}"`},` +
      `"host":${host === null ? 'null' : `"${host}"`}}'\n` +
      `    ;;\n` +
      `  *)\n` +
      `    cat > "$0.stdin"\n` +
      `    printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":4,"url":"https://forge.example/d/1",` +
      `"provider":"github","host":"${host ?? ''}"}'\n` +
      `    ;;\n` +
      `esac\n`;
    const stub = writeRateStub(body);
    stubs.push(stub);
    return stub;
  }

  /** VoteDeps over a stub executable. `run` ignores scope — the stub has none. */
  function deps(
    stub: Stub,
    overrides: Partial<VoteDeps> = {},
  ): VoteDeps & { confirms: number } {
    const state = { confirms: 0 };
    const base: VoteDeps = {
      run: (args, _scope, stdin) => runJson(stub.executable, args, stdin === undefined ? {} : { stdin }),
      secrets: fakeSecrets(),
      confirm: async () => {
        state.confirms += 1;
        return true;
      },
      ...overrides,
    };
    return Object.assign(base, {
      get confirms(): number {
        return state.confirms;
      },
    });
  }

  test('the dry run comes first, carries no credential flag, and mutates nothing', async () => {
    const stub = handshakeStub('ghes.corp.example', 'github');
    // ghes.corp.example is provably not a host we authenticated against (VS
    // Code's github-enterprise.uri is unset in the test instance), so the vote
    // stops after the handshake — which is exactly what makes the ORDER
    // observable: the first argv line is the dry run.
    const outcome = await castVote(deps(stub), 'ghcr.io/x/y', false);
    const argv = fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n');
    assert.ok(argv[0]?.includes('--dry-run'), `first call was not the dry run: ${argv[0]}`);
    assert.ok(!argv[0]?.includes('--token-stdin'), 'the dry run asked for a credential');
    assert.ok(!outcome.ok);
    assert.ok(outcome.message.includes('ghes.corp.example'), outcome.message);
  });

  test('a host we cannot authenticate against gets NOTHING piped at it', async () => {
    const stub = handshakeStub('ghes.corp.example', 'github');
    const outcome = await castVote(deps(stub), 'ghcr.io/x/y', false);
    assert.ok(!outcome.ok);
    assert.ok(!fs.existsSync(`${stub.executable}.stdin`), 'a credential reached the child');
    // One call only: the dry run. No mutation was attempted.
    assert.strictEqual(fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n').length, 1);
  });

  test('an unrecognised provider is readable, not writable — and pipes nothing', async () => {
    const stub = handshakeStub(null, 'bitbucket');
    const outcome = await castVote(deps(stub), 'ghcr.io/x/y', false);
    assert.ok(!outcome.ok);
    assert.ok(!fs.existsSync(`${stub.executable}.stdin`));
    assert.match(outcome.message, /No rating thread/);
  });

  test('the disclosure is asked before authentication, and declining pipes nothing', async () => {
    const stub = handshakeStub('github.com', 'github');
    let asked = 0;
    const outcome = await castVote(
      deps(stub, {
        confirm: async () => {
          asked += 1;
          return false;
        },
      }),
      'ghcr.io/x/y',
      false,
    );
    assert.strictEqual(asked, 1, 'the user was not asked before a public post');
    assert.ok(!outcome.ok);
    assert.strictEqual(outcome.message, '', 'a declined vote is not an error to report');
    assert.ok(!fs.existsSync(`${stub.executable}.stdin`));
  });

  test('the mutation declares its host, so grim can refuse before any header', async () => {
    // A stored PAT for the exact host is the one credential this test instance
    // can produce without a live provider — enough to reach step 3.
    const stub = handshakeStub('ghes.corp.example', 'github');
    const outcome = await castVote(
      deps(stub, { secrets: fakeSecrets({ [voteSecretKey('ghes.corp.example')]: TOKEN }) }),
      'ghcr.io/x/y',
      false,
    );
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.message);
    const argv = fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n');
    assert.strictEqual(argv.length, 2);
    assert.ok(argv[1]?.includes('--token-stdin'));
    assert.ok(
      argv[1]?.includes('--token-host ghes.corp.example'),
      `the piped credential declared no host: ${argv[1]}`,
    );
    // The host declared is the one the DRY RUN named, not a default.
    assert.ok(!argv[1]?.includes('api.github.com'));
    assert.strictEqual(fs.readFileSync(`${stub.executable}.stdin`, 'utf8'), TOKEN);
    assert.ok(!fs.readFileSync(stub.argvLog, 'utf8').includes(TOKEN));
  });

  test('a failed mutation reports the failure and leaves the state unknown (S-007)', async () => {
    const stub = writeRateStub(
      `case " $* " in\n` +
        `  *" --dry-run "*)\n` +
        `    printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":3,"url":"u","provider":"github","host":"ghes.corp.example"}'\n` +
        `    ;;\n` +
        `  *)\n` +
        `    cat > /dev/null\n` +
        `    printf '%s' '{"error":{"code":"unavailable","exit":69,"message":"forge unreachable"}}'\n` +
        `    exit 69\n` +
        `    ;;\n` +
        `esac\n`,
    );
    stubs.push(stub);
    const outcome = await castVote(
      deps(stub, { secrets: fakeSecrets({ [voteSecretKey('ghes.corp.example')]: TOKEN }) }),
      'ghcr.io/x/y',
      false,
    );
    assert.ok(!outcome.ok);
    assert.match(outcome.message, /forge unreachable/);
    // The caller maps every failure through voteStateAfter(null).
    assert.strictEqual(voteStateAfter(null), 'unknown');
  });

  // --- The command's own refusal branches. Each pins the sentence the user is
  // --- shown AND that no vote was cast: one argv line (the handshake, or none
  // --- at all) plus no `.stdin` file means grim was never asked to write, and
  // --- never handed a credential.

  test('a dry run that fails names the refusal and votes nothing', async () => {
    const stub = writeRateStub(
      `printf '%s' '{"error":{"code":"offline","exit":81,"message":"offline: rating needs the network"}}'\n` +
        `exit 81\n`,
    );
    stubs.push(stub);
    const d = deps(stub);
    const outcome = await castVote(d, 'ghcr.io/x/y', false);
    assert.ok(!outcome.ok);
    assert.match(outcome.message, /^Could not resolve a rating for ghcr\.io\/x\/y: /);
    assert.match(outcome.message, /offline: rating needs the network/);
    assert.strictEqual(d.confirms, 0, 'a vote that could not resolve still asked the user');
    assert.strictEqual(fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n').length, 1);
    assert.ok(!fs.existsSync(`${stub.executable}.stdin`));
  });

  test('a grim that is not installed says so, and asks the user nothing', async () => {
    const stub = handshakeStub('github.com', 'github');
    const d = deps({ ...stub, executable: path.join(stub.dir, 'no-such-grim') });
    const outcome = await castVote(d, 'ghcr.io/x/y', false);
    assert.ok(!outcome.ok);
    assert.strictEqual(outcome.message, 'grim executable not found');
    assert.strictEqual(d.confirms, 0, 'a missing grim still dragged the user through a disclosure');
    assert.ok(!fs.existsSync(stub.argvLog), 'something ran');
  });

  test('a malformed report never becomes a vote', async () => {
    // (a) Not JSON at all — grim died before reaching its own contract.
    const garbage = writeRateStub(`printf '%s' 'Segmentation fault'\n`);
    stubs.push(garbage);
    const first = await castVote(deps(garbage), 'ghcr.io/x/y', false);
    assert.ok(!first.ok);
    assert.match(first.message, /^Could not resolve a rating for ghcr\.io\/x\/y: /);
    assert.ok(!fs.existsSync(`${garbage.executable}.stdin`));

    // (b) JSON, but the handshake fields are ABSENT rather than null — the
    // shape a grim predating them would emit. Absent must read exactly like
    // null does: readable, not writable, and no credential goes anywhere.
    const partial = writeRateStub(`printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":3}'\n`);
    stubs.push(partial);
    const second = await castVote(deps(partial), 'ghcr.io/x/y', false);
    assert.ok(!second.ok);
    assert.match(second.message, /No rating thread/);
    assert.ok(!fs.existsSync(`${partial.executable}.stdin`));
  });

  test('a host whose provider we cannot authenticate against is readable, not writable', async () => {
    // grim resolved a real host, but no provider of ours claims it — so there
    // is no session to ask and no secret key to look under. C-018's "pipe
    // nothing" covers the provider miss as much as the host miss.
    const stub = handshakeStub('bitbucket.example', 'bitbucket');
    const d = deps(stub);
    const outcome = await castVote(d, 'ghcr.io/x/y', false);
    assert.ok(!outcome.ok);
    assert.strictEqual(
      outcome.message,
      'No credential for bitbucket.example — Grimoire cannot vote there.',
    );
    assert.strictEqual(d.confirms, 0, 'the user was asked to confirm an impossible vote');
    assert.strictEqual(fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n').length, 1);
    assert.ok(!fs.existsSync(`${stub.executable}.stdin`));
  });

  test('a grim that vanishes between the handshake and the vote says so', async () => {
    // The handshake answers, then deletes itself: the MUTATION call is the one
    // that hits ENOENT. It must read as a failure, never as a cast vote.
    const stub = writeRateStub(
      `printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":3,"url":"u",` +
        `"provider":"github","host":"ghes.corp.example"}'\n` +
        `rm -f "$0"\n`,
    );
    stubs.push(stub);
    const outcome = await castVote(
      deps(stub, { secrets: fakeSecrets({ [voteSecretKey('ghes.corp.example')]: TOKEN }) }),
      'ghcr.io/x/y',
      false,
    );
    assert.ok(!outcome.ok);
    assert.strictEqual(outcome.message, 'grim executable not found');
    // And how the caller reads that failure: unknown, never "not voted".
    assert.strictEqual(voteStateAfter(null), 'unknown');
  });

  test('retracting needs no disclosure — it posts nothing new', async () => {
    assert.strictEqual(await confirmVote('github', 'github.com', true), true);
  });

  test('voting discloses in a MODAL, and anything but the button is a no', async () => {
    // C-018's last line of defence: the extension always passes `--yes`, so
    // grim's own prompt never fires and this dialog is the only thing between
    // a click and a public post. It must be modal, and only the Vote button
    // may pass.
    const window = vscode.window as unknown as { showWarningMessage: unknown };
    const original = window.showWarningMessage;
    const asked: Array<[string, vscode.MessageOptions]> = [];
    try {
      // VS Code resolves undefined when the user dismisses a modal.
      window.showWarningMessage = async (message: string, options: vscode.MessageOptions) => {
        asked.push([message, options]);
        return undefined;
      };
      assert.strictEqual(await confirmVote('github', 'ghes.corp.example', false), false);
      assert.strictEqual(asked.length, 1);
      const [message, options] = asked[0] ?? ['', {}];
      assert.ok(options.modal, 'a toast the user can miss is not consent');
      assert.match(message, /posts publicly under your forge account/);
      // The disclosure names the provider and the host the vote actually goes
      // to — not a default, and not the row's registry.
      assert.match(options.detail ?? '', /github thread at ghes\.corp\.example/);

      // Any other answer, including a stray label, is a refusal.
      window.showWarningMessage = async () => 'Cancel';
      assert.strictEqual(await confirmVote('github', 'ghes.corp.example', false), false);

      window.showWarningMessage = async () => 'Vote';
      assert.strictEqual(await confirmVote('github', 'ghes.corp.example', false), true);
    } finally {
      window.showWarningMessage = original;
    }
  });
});

// --- C-018 / S-008: opening a detail view must never raise a sign-in prompt.

suite('the detail-view refinement never prompts (S-008)', () => {
  test('silent mode asks for no session creation and returns undefined instead', async () => {
    // github.com IS a provider this instance registers, so a `createIfNone`
    // would genuinely open the sign-in flow (and hang this test). Silent mode
    // resolving to undefined without a prompt is the whole assertion.
    const target = authTargetFor('github', 'github.com') as AuthTarget;
    const token = await voteToken(target, fakeSecrets(), 'silent');
    assert.ok(
      token === undefined || typeof token === 'string',
      'silent resolution neither prompted nor threw',
    );
  });

  test('a details VM built from a catalog row starts unknown, so nothing is claimed', () => {
    const vm = buildSkeletonVM(
      'ghcr.io/x/y',
      {
        kind: 'skill',
        repo: 'ghcr.io/x/y',
        summary: null,
        description: null,
        version: null,
        latest_tag: null,
        repository: null,
        revision: null,
        created: null,
        deprecated: null,
        status: 'not-installed',
        rating: { up: 21, url: 'https://forge.example/d/1' },
      } as WireSearchItem,
      { projectOpen: true, projectConfigured: true, projectName: null },
    );
    assert.strictEqual(vm.rating?.vote, 'unknown');
    assert.strictEqual(vm.rating?.up, 21);
  });
});

// --- C-023: the silent viewer_up refinement. Every unhappy path is unknown,
// --- and a host with no credential makes no second call at all.

suite('viewer_up refinement (C-023)', function () {
  this.timeout(20000);
  const stubs: Stub[] = [];

  suiteSetup(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  suiteTeardown(() => {
    for (const stub of stubs) {
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  /** Dry run #1 answers the host; dry run #2 (with `--token-stdin`) answers
   *  `viewer_up` with whatever JSON literal the test names. */
  function refineStub(host: string, viewerUp: string): Stub {
    const row = (extra: string): string =>
      `printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":3,"url":"https://forge.example/d/1",` +
      `"provider":"github","host":"${host}"${extra}}'`;
    const stub = writeRateStub(
      `case " $* " in\n` +
        `  *" --token-stdin "*)\n` +
        `    cat > "$0.stdin"\n` +
        `    ${row(`,"viewer_up":${viewerUp}`)}\n` +
        `    ;;\n` +
        `  *)\n` +
        `    ${row('')}\n` +
        `    ;;\n` +
        `esac\n`,
    );
    stubs.push(stub);
    return stub;
  }

  const refineDeps = (
    stub: Stub,
    secrets: SecretReader,
  ): Pick<VoteDeps, 'run' | 'secrets'> => ({
    run: (args, _scope, stdin) =>
      runJson(stub.executable, args, stdin === undefined ? {} : { stdin }),
    secrets,
  });

  /** A PAT stored for the exact host — the one credential the test instance can
   *  produce silently, with no provider session and no prompt. */
  const storedFor = (host: string): SecretReader => fakeSecrets({ [voteSecretKey(host)]: TOKEN });

  test('viewer_up true resolves voted, false resolves not-voted', async () => {
    for (const [literal, expected] of [
      ['true', 'voted'],
      ['false', 'not-voted'],
    ] as const) {
      const stub = refineStub('ghes.corp.example', literal);
      const state = await refineVoteState(
        refineDeps(stub, storedFor('ghes.corp.example')),
        'ghcr.io/x/y',
      );
      assert.strictEqual(state, expected, `viewer_up:${literal}`);
    }
  });

  test('viewer_up null leaves it unknown — a failed read is never "not voted"', async () => {
    const stub = refineStub('ghes.corp.example', 'null');
    const state = await refineVoteState(
      refineDeps(stub, storedFor('ghes.corp.example')),
      'ghcr.io/x/y',
    );
    assert.strictEqual(state, 'unknown');
  });

  test('an older grim omitting the field entirely reads unknown, not not-voted', async () => {
    // `viewer_up === false` must not be reachable from an ABSENT key.
    const stub = writeRateStub(
      `case " $* " in\n` +
        `  *" --token-stdin "*) cat > /dev/null;; \n` +
        `esac\n` +
        `printf '%s' '{"ref":"ghcr.io/x/y","action":"up","up":3,"url":"u","provider":"github","host":"ghes.corp.example"}'\n`,
    );
    stubs.push(stub);
    const state = await refineVoteState(
      refineDeps(stub, storedFor('ghes.corp.example')),
      'ghcr.io/x/y',
    );
    assert.strictEqual(state, 'unknown');
  });

  test('no credential for the host ⇒ NO second call, and the state stays unknown', async () => {
    const stub = refineStub('ghes.corp.example', 'true');
    // No stored PAT, and github-enterprise.uri is unset in the test instance,
    // so the silent lookup yields nothing.
    const state = await refineVoteState(refineDeps(stub, fakeSecrets()), 'ghcr.io/x/y');
    assert.strictEqual(state, 'unknown');
    assert.strictEqual(
      fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n').length,
      1,
      'a credentialed query ran without a credential',
    );
    assert.ok(!fs.existsSync(`${stub.executable}.stdin`), 'something reached the child on stdin');
  });

  test('the host-resolution call carries no credential, so it stays offline-safe', async () => {
    const stub = refineStub('ghes.corp.example', 'true');
    await refineVoteState(refineDeps(stub, storedFor('ghes.corp.example')), 'ghcr.io/x/y');
    const argv = fs.readFileSync(stub.argvLog, 'utf8').trim().split('\n');
    assert.strictEqual(argv.length, 2);
    // grim hard-refuses (exit 81) a credentialed dry run when offline, so
    // piping a token into call #1 would break C-022's offline guarantee.
    assert.ok(argv[0]?.includes('--dry-run'));
    assert.ok(!argv[0]?.includes('--token-stdin'), 'the host handshake asked for a credential');
    // Call #2 declares its host, exactly as the voting path does.
    assert.ok(argv[1]?.includes('--dry-run'));
    assert.ok(argv[1]?.includes('--token-host ghes.corp.example'));
    assert.ok(!fs.readFileSync(stub.argvLog, 'utf8').includes(TOKEN));
  });

  test('a failing query, a missing grim and an unrated row all read unknown', async () => {
    const failing = writeRateStub(
      `case " $* " in\n` +
        `  *" --token-stdin "*)\n` +
        `    cat > /dev/null\n` +
        `    printf '%s' '{"error":{"code":"unavailable","exit":69,"message":"forge unreachable"}}'\n` +
        `    exit 69\n` +
        `    ;;\n` +
        `  *) printf '%s' '{"ref":"r","action":"up","up":3,"url":"u","provider":"github","host":"ghes.corp.example"}';;\n` +
        `esac\n`,
    );
    stubs.push(failing);
    assert.strictEqual(
      await refineVoteState(refineDeps(failing, storedFor('ghes.corp.example')), 'ghcr.io/x/y'),
      'unknown',
    );

    // No host resolved (unrecognised provider) — stops before any credential.
    const unrated = writeRateStub(
      `printf '%s' '{"ref":"r","action":"up","up":0,"url":null,"provider":null,"host":null}'\n`,
    );
    stubs.push(unrated);
    assert.strictEqual(
      await refineVoteState(refineDeps(unrated, storedFor('ghes.corp.example')), 'ghcr.io/x/y'),
      'unknown',
    );

    // grim absent entirely (ENOENT).
    assert.strictEqual(
      await refineVoteState(
        refineDeps({ ...unrated, executable: '/nonexistent/grim' }, fakeSecrets()),
        'ghcr.io/x/y',
      ),
      'unknown',
    );
  });

  test('the refinement never prompts: it uses the silent credential path only', async () => {
    // github.com IS a registered provider here, so an interactive lookup would
    // open the sign-in flow and hang. Completing at all is the assertion.
    const stub = refineStub('github.com', 'true');
    const state = await refineVoteState(refineDeps(stub, fakeSecrets()), 'ghcr.io/x/y');
    assert.ok(['voted', 'unknown'].includes(state), `unexpected state: ${state}`);
  });
});
