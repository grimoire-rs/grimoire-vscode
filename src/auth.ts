// Credential resolution for `grim rate`. grim resolves a credential for the
// host it is about to contact; `--token-stdin` is the one path that bypasses
// that ladder, so the rule sits on the injector instead (design §3.6): the
// extension selects its auth provider from the SAME host it hands to grim, and
// pipes nothing when that host is not one it authenticated against.
import * as vscode from 'vscode';

/** Statistic producer named by the index's `providers.rating`. Deliberately a
 *  plain string, not an enum: the value is index-supplied and an unrecognised
 *  one degrades to "readable, not writable". */
export type RatingProvider = string;

export interface AuthTarget {
  /** VS Code authentication provider id. */
  providerId: 'github' | 'github-enterprise' | 'gitlab';
  /** Normalised host, exactly the one handed to grim. */
  host: string;
  /** Requested verbatim at the call site. `public_repo` is the realistic floor
   *  — classic OAuth has no Discussions-specific scope, and VS Code's built-in
   *  `github` provider is one OAuth App shared by every extension, so asking
   *  for less does not shrink an already-issued session. Disclosed limitation,
   *  not a solved problem (design §7). */
  scopes: readonly string[];
}

/** The read half of {@link vscode.SecretStorage} — all this module needs. The
 *  credential ladder never writes: storing a token is a deliberate user action,
 *  and it lives in views/ratingAuth.ts behind a command. */
export type SecretReader = Pick<vscode.SecretStorage, 'get'>;

/** The write half, for the store/clear commands only. */
export type SecretWriter = Pick<vscode.SecretStorage, 'store' | 'delete'>;

/** C-007's default host per provider. An override for GHES / self-managed
 *  GitLab comes from the user's own grim config and NEVER from index-fetched
 *  content; the caller hands that host in explicitly. */
const DEFAULT_HOSTS: Record<string, string> = {
  github: 'api.github.com',
  gitlab: 'gitlab.com',
};

/** The only two hosts served by VS Code's built-in `github` provider. A set,
 *  not a suffix test: `evil-github.com` and `github.com.evil.tld` must not
 *  reach a github.com session. */
const GITHUB_DOT_COM = new Set(['github.com', 'api.github.com']);

export function defaultRatingHost(provider: RatingProvider): string | undefined {
  return DEFAULT_HOSTS[provider];
}

/** `host[:port]` in comparable form: ASCII-lowercased, IDNA-normalised, port
 *  preserved (a default 443 is dropped, since it names the same host).
 *  Anything carrying more than an authority — a path, userinfo, a scheme,
 *  whitespace — is rejected rather than sanitized, so no input can smuggle a
 *  second authority past `new URL`. Undefined means "no host", which every
 *  caller reads as "pipe nothing". Pure; exported for tests. */
export function normalizeHost(host: string): string | undefined {
  if (host === '' || /[/\\?#@\s]/.test(host)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    return undefined;
  }
  if (url.hostname === '') {
    return undefined;
  }
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/** Which VS Code auth provider covers the host grim is about to contact — the
 *  table from C-018, not a heuristic. Undefined for a provider the extension
 *  cannot authenticate against and for a host that will not normalise; both
 *  mean the caller pipes nothing and reports "no credential for <host>". */
export function authTargetFor(provider: RatingProvider, host: string): AuthTarget | undefined {
  const normalized = normalizeHost(host);
  if (normalized === undefined) {
    return undefined;
  }
  if (provider === 'github') {
    return {
      providerId: GITHUB_DOT_COM.has(normalized) ? 'github' : 'github-enterprise',
      host: normalized,
      scopes: ['public_repo'],
    };
  }
  if (provider === 'gitlab') {
    // gitlab.com and self-managed alike: GitLab Workflow registers one
    // `gitlab` provider. Absent (or refusing) ⇒ the stored PAT.
    return { providerId: 'gitlab', host: normalized, scopes: ['api'] };
  }
  return undefined;
}

/** SecretStorage key for a manually stored PAT. Keyed by host so a credential
 *  for one instance can never be piped at another. */
export function voteSecretKey(host: string): string {
  return `grimoire.rating.token:${host}`;
}

/** True when VS Code's `github-enterprise` provider is pointed at this exact
 *  host. The provider has no per-request host parameter — it authenticates
 *  against whatever `github-enterprise.uri` names — so a session it hands back
 *  for a DIFFERENT instance must not travel to this one. */
function enterpriseUriMatches(host: string): boolean {
  const uri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  if (!uri) {
    return false;
  }
  try {
    return normalizeHost(new URL(uri).host) === host;
  } catch {
    return false;
  }
}

/** True when the GitLab Workflow extension is signed in to this exact host.
 *
 *  Same hazard as {@link enterpriseUriMatches}, and it bit harder: the `gitlab`
 *  provider registers **one** identity for gitlab.com and self-managed alike,
 *  with no per-request host parameter, so `getSession('gitlab', …)` returns
 *  whatever instance the user happens to be signed in to. Without this anchor a
 *  user signed in to gitlab.com who sets `GRIM_RATING_HOST=gitlab.corp.example`
 *  had their gitlab.com `api`-scoped token — full read/write on the account —
 *  POSTed to the corporate instance on **panel open**, with no click and no
 *  prompt, because the refinement path is silent. grim's `--token-host` gate
 *  cannot catch it: declared and resolved are the same wrong host.
 *
 *  GitLab Workflow's instance setting is the only host evidence available, so a
 *  host it does not name falls through to the host-keyed SecretStorage PAT,
 *  which the user stored for that host deliberately. */
function gitlabInstanceMatches(host: string): boolean {
  if (host === DEFAULT_HOSTS.gitlab) {
    return true;
  }
  const config = vscode.workspace.getConfiguration('gitlab');
  const candidates = [config.get<string>('instanceUrl'), config.get<string>('url')].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return candidates.some((value) => {
    try {
      return normalizeHost(new URL(value).host) === host;
    } catch {
      return false;
    }
  });
}

/** Why no credential could be resolved for a host.
 *
 *  A bare "there is none" was the whole of the reported problem: the toast said
 *  "sign in, or store a token" and the extension offered neither, because it
 *  could not tell a MISSING PROVIDER (no GitLab Workflow installed — its
 *  absence makes `getSession` throw) from a provider pointed at a DIFFERENT
 *  instance from a provider that simply has no session. Those need three
 *  different remedies, so the ladder reports which one it hit. */
export type NoCredentialReason =
  /** VS Code has no auth provider with this id — for `gitlab` that means the
   *  GitLab Workflow extension is not installed, which is installable from
   *  here. GitHub's providers are built in, so this cannot be them. */
  | 'provider-missing'
  /** The provider is registered but signed in to another instance. It has no
   *  per-request host parameter, so its session must not travel to this host
   *  (see {@link gitlabInstanceMatches}) — a stored PAT is the way in. */
  | 'instance-mismatch'
  /** Provider present, host matches, nothing came back — the user dismissed the
   *  sign-in, or there is no session and none was created. */
  | 'no-session';

/** The outcome of resolving a rating credential. Every `ok: false` means the
 *  caller pipes NOTHING; the reason only decides what it can offer the user. */
export type VoteCredential =
  | { ok: true; token: string }
  | {
      ok: false;
      reason: NoCredentialReason;
      /** Normalised host the vote would go to. */
      host: string;
      /** On `instance-mismatch`, the instance the provider IS pointed at, so the
       *  message can name both sides. Absent when it cannot be read. */
      instance?: string;
      /** The provider that would have supplied it — drives the "install it"
       *  offer, which only exists for `gitlab`. */
      providerId: AuthTarget['providerId'];
    };

/** The instance a host-anchored provider is actually pointed at, for the
 *  mismatch message. Undefined when the setting is unset or unparsable. */
function configuredInstance(providerId: AuthTarget['providerId']): string | undefined {
  const raw =
    providerId === 'github-enterprise'
      ? vscode.workspace.getConfiguration('github-enterprise').get<string>('uri')
      : (vscode.workspace.getConfiguration('gitlab').get<string>('instanceUrl') ??
        vscode.workspace.getConfiguration('gitlab').get<string>('url'));
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeHost(new URL(raw).host);
  } catch {
    return undefined;
  }
}

/** True when VS Code has no provider registered under this id. `getAccounts` is
 *  the probe: it REJECTS for an unregistered provider and resolves `[]` for a
 *  registered one with no accounts. The blanket try/catch around `getSession`
 *  used to collapse those two into the same silent undefined, which is why "the
 *  GitLab extension is missing" was indistinguishable from "you dismissed the
 *  prompt" and neither could be acted on. */
async function providerMissing(providerId: AuthTarget['providerId']): Promise<boolean> {
  try {
    await vscode.authentication.getAccounts(providerId);
    return false;
  } catch {
    return true;
  }
}

async function ratingSession(
  target: AuthTarget,
  mode: 'interactive' | 'silent',
): Promise<vscode.AuthenticationSession | undefined> {
  const scopes = [...target.scopes];
  try {
    if (mode === 'silent') {
      // No createIfNone, no forceNewSession: opening a detail view must never
      // raise a sign-in prompt. Interactive modes belong to the vote alone.
      return await vscode.authentication.getSession(target.providerId, scopes, { silent: true });
    }
    const accounts = await vscode.authentication.getAccounts(target.providerId);
    if (accounts.length > 1) {
      // A vote posts publicly under one account — ask which, never guess.
      const picked = await vscode.window.showQuickPick(
        accounts.map((account) => ({ label: account.label, account })),
        { title: `Vote as which account?`, placeHolder: target.host },
      );
      if (!picked) {
        return undefined;
      }
      return await vscode.authentication.getSession(target.providerId, scopes, {
        account: picked.account,
        createIfNone: true,
      });
    }
    return await vscode.authentication.getSession(target.providerId, scopes, {
      createIfNone: true,
    });
  } catch {
    // Provider not registered, or the user dismissed the sign-in. Neither is an
    // error here — the caller falls through to the stored PAT, and reports a
    // reason if there is none.
    return undefined;
  }
}

/**
 * The credential to pipe to `grim rate --token-stdin`, or a reason there is
 * none — in which case the caller pipes NOTHING.
 *
 * The host-anchor checks come first and short-circuit the provider entirely: a
 * session for another instance must not travel to this host, whatever the mode.
 * The SecretStorage PAT is consulted only after the matching provider yields no
 * session; it is host-keyed, so it is by construction the credential the user
 * stored for THIS host.
 */
export async function voteToken(
  target: AuthTarget,
  secrets: SecretReader,
  mode: 'interactive' | 'silent',
): Promise<VoteCredential> {
  const anchored =
    target.providerId === 'github-enterprise'
      ? enterpriseUriMatches(target.host)
      : target.providerId === 'gitlab'
        ? gitlabInstanceMatches(target.host)
        : true;
  const session = anchored ? await ratingSession(target, mode) : undefined;
  const token = session?.accessToken ?? (await secrets.get(voteSecretKey(target.host)));
  if (token !== undefined) {
    return { ok: true, token };
  }
  if (!anchored) {
    const instance = configuredInstance(target.providerId);
    return {
      ok: false,
      reason: 'instance-mismatch',
      host: target.host,
      providerId: target.providerId,
      ...(instance !== undefined ? { instance } : {}),
    };
  }
  // Asked last, and only on the failing path: it costs a provider round trip,
  // and it is only ever needed to explain a failure.
  const reason: NoCredentialReason = (await providerMissing(target.providerId))
    ? 'provider-missing'
    : 'no-session';
  return { ok: false, reason, host: target.host, providerId: target.providerId };
}
