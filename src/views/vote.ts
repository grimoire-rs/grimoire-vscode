// Casting a vote through `grim rate`, host side.
//
// The whole reason this is more than one grim call is the HOST HANDSHAKE
// (plan C-022). Nothing the extension already holds names the host grim will
// contact: a GHES or self-managed GitLab host comes from the user's own grim
// config, and `stats.json` deliberately carries none. An extension that
// defaulted to `api.github.com` would pipe a github.com token at a corporate
// GHES instance — the exact leak C-007 and C-018 exist to prevent.
//
// So a vote is three steps, in this order, and the order is the contract:
//
//   1. `grim rate <ref> --dry-run` — resolves the row, the provider and the
//      host, mutates nothing, needs no credential, makes no forge request and
//      works offline. This is where the host comes from.
//   2. Pick the auth provider from THAT host. Not one we authenticated
//      against ⇒ pipe nothing and say "no credential for <host>".
//   3. Pipe the token with `--token-host <host>` alongside `--token-stdin`.
//      grim re-checks it against the host it is about to contact and exits 80
//      naming both, BEFORE the token reaches any header.
//
// Step 3 is not redundant with step 1: it makes the guarantee independent of
// this file being correct. Do not drop it because step 1 "already got it right".
import * as vscode from 'vscode';

import { authTargetFor, voteToken, type SecretReader, type VoteCredential } from '../auth';
import { rateArgs, type GrimResult, type RateReport } from '../grim';
import type { Scope, VoteState } from '../webview/protocol';

/** What a vote attempt resolved to. `report` is null on every failure, which
 *  {@link voteStateAfter} reads as **unknown** — never "not voted" (S-007). */
export type VoteOutcome =
  | { ok: true; report: RateReport }
  | {
      ok: false;
      message: string;
      /** Set only when the failure was "no credential for this host", carrying
       *  WHY. The caller turns it into the matching offer — install the provider
       *  extension, or store a token — instead of a dead-end toast naming two
       *  remedies the extension does not provide. */
      credential?: Extract<VoteCredential, { ok: false }>;
    };

export interface VoteDeps {
  /** Runs grim. `stdin`, when given, carries the credential and nothing else. */
  run: <T>(args: string[], scope: Scope, stdin?: string) => Promise<GrimResult<T>>;
  secrets: SecretReader;
  /** The extension's own disclosure (C-018): the extension always passes
   *  `--yes`, so grim's interactive prompt never fires and THIS is the only
   *  thing standing between a click and a public post. Resolves false when
   *  the user declines. Takes the reference because the click is not always a
   *  click — the /vote deep link reaches here from an attacker-supplied URI,
   *  and consent to post about an unnamed artifact is not consent. */
  confirm: (reference: string, provider: string, host: string, remove: boolean) => Promise<boolean>;
}

/** The one sentence each no-credential reason deserves. Kept beside castVote
 *  rather than in the notification layer so a caller that only logs the outcome
 *  still says something true. */
function noCredentialMessage(credential: Extract<VoteCredential, { ok: false }>): string {
  switch (credential.reason) {
    case 'provider-missing':
      return credential.providerId === 'gitlab'
        ? `Voting on ${credential.host} needs the GitLab Workflow extension, or a stored token.`
        : `No ${credential.providerId} sign-in available for ${credential.host}.`;
    case 'instance-mismatch':
      return credential.instance !== undefined
        ? `GitLab Workflow is signed in to ${credential.instance}, but this index rates on ${credential.host}.`
        : `No sign-in for ${credential.host} — the signed-in instance is a different one.`;
    case 'no-session':
      return `No credential for ${credential.host}.`;
  }
}

/** grim's word for "this row has no rating" / "I cannot vote here". */
function unvotable(reference: string): string {
  return `No rating thread for ${reference} — this index publishes none for it.`;
}

/**
 * Cast (`remove: false`) or retract (`remove: true`) the viewer's upvote.
 *
 * Every failure path returns `ok: false` with a message fit for a
 * notification. None of them claims the user has not voted: the caller maps a
 * failure to `'unknown'`, because a vote that failed after the request left
 * may well have landed.
 */
export async function castVote(
  deps: VoteDeps,
  reference: string,
  remove: boolean,
): Promise<VoteOutcome> {
  // 1. The handshake. Scope 'project' so the run inherits the workspace's own
  //    grim config — which is where a GHES host override lives.
  const resolved = await deps.run<RateReport>(rateArgs(reference, { remove, dryRun: true }), 'project');
  if (!resolved.ok) {
    return {
      ok: false,
      message:
        resolved.kind === 'not-found'
          ? 'grim executable not found'
          : `Could not resolve a rating for ${reference}: ${resolved.message}`,
    };
  }
  const { host, provider } = resolved.value;
  if (!host || !provider) {
    // grim resolved the row but no host: an unrecognised provider, or no
    // rating on the row. Either way it is readable, not writable.
    return { ok: false, message: unvotable(reference) };
  }

  // 2. The provider comes from the host grim just named, never from a default.
  const target = authTargetFor(provider, host);
  if (!target) {
    return { ok: false, message: `No credential for ${host} — Grimoire cannot vote there.` };
  }

  // Disclosure BEFORE authentication: a user who declines must not first be
  // dragged through a sign-in prompt for a vote they are about to cancel.
  if (!(await deps.confirm(reference, provider, target.host, remove))) {
    return { ok: false, message: '' };
  }

  const credential = await voteToken(target, deps.secrets, 'interactive');
  if (!credential.ok) {
    // PIPE NOTHING. Falling through to a token-less `grim rate` would make
    // grim run its own credential ladder against a host we could not
    // authenticate against; the honest answer is that we have no credential.
    // The reason rides along so the caller can offer the way out.
    return { ok: false, message: noCredentialMessage(credential), credential };
  }

  // 3. `--token-host` alongside `--token-stdin`: grim fails closed on a
  //    mismatch before the token reaches a header.
  const result = await deps.run<RateReport>(
    rateArgs(reference, { remove, tokenStdin: true, tokenHost: target.host }),
    'project',
    credential.token,
  );
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.kind === 'not-found'
          ? 'grim executable not found'
          : `Vote failed: ${result.message}`,
    };
  }
  return { ok: true, report: result.value };
}

/** The disclosure C-018 owes the user, as a modal. Modal on purpose: this
 *  posts publicly under their own forge account, and a toast they can miss is
 *  not consent. */
export function confirmVote(
  reference: string,
  provider: string,
  host: string,
  remove: boolean,
): Promise<boolean> {
  if (remove) {
    // Retracting posts nothing new; it undoes the user's own earlier vote.
    return Promise.resolve(true);
  }
  return Promise.resolve(
    vscode.window.showWarningMessage(
      'This posts publicly under your forge account.',
      {
        modal: true,
        // The reference is in the modal, not just the panel behind it: a /vote
        // link can name any artifact, and the panel it opened may not even have
        // painted yet when this appears.
        detail:
          `Upvote ${reference}?\n\n` +
          `Your upvote will be visible to anyone who can see the ${provider} thread at ${host}.`,
      },
      'Vote',
    ),
  ).then((choice) => choice === 'Vote');
}

/**
 * The lazy `viewer_up` refinement (C-023 / S-008): ask grim, silently, whether
 * this user has already voted — so a detail view can stop saying "unknown"
 * once it can honestly say something better.
 *
 * Silent throughout. Opening a detail view must never raise a sign-in prompt,
 * so the credential comes from `voteToken(…, 'silent')`, which returns
 * undefined rather than prompting. No credential ⇒ **no second call at all**.
 *
 * Returns a state, never throws, and **every** unhappy path returns
 * `'unknown'` — no credential, no host, a refused query, a `viewer_up` of
 * null, offline (grim exits 81 for a credentialed dry run), a missing grim.
 * There is deliberately no branch that can produce `'not-voted'` from a
 * failure: that is R-3's whole point, and the reason grim made the field
 * nullable instead of defaulting it to false.
 */
export async function refineVoteState(
  deps: Pick<VoteDeps, 'run' | 'secrets'>,
  reference: string,
): Promise<VoteState> {
  // The host handshake, unchanged and uncredentialed: a bare `--dry-run` makes
  // no forge request and works offline (C-022), and piping a token into THIS
  // call would break that. The credentialed query is the second call.
  const resolved = await deps.run<RateReport>(rateArgs(reference, { dryRun: true }), 'project');
  if (!resolved.ok) {
    return 'unknown';
  }
  const { host, provider } = resolved.value;
  if (!host || !provider) {
    return 'unknown';
  }
  const target = authTargetFor(provider, host);
  if (!target) {
    return 'unknown';
  }
  const credential = await voteToken(target, deps.secrets, 'silent');
  if (!credential.ok) {
    return 'unknown';
  }
  const viewer = await deps.run<RateReport>(
    rateArgs(reference, { dryRun: true, tokenStdin: true, tokenHost: target.host }),
    'project',
    credential.token,
  );
  if (!viewer.ok) {
    return 'unknown';
  }
  // Strict comparisons, not truthiness: `undefined` (an older grim with no
  // such field) and `null` (asked, not knowable) both have to land on unknown.
  if (viewer.value.viewer_up === true) {
    return 'voted';
  }
  return viewer.value.viewer_up === false ? 'not-voted' : 'unknown';
}
