// The way OUT of a failed rating credential, host side.
//
// `castVote` refuses to pipe anything when it cannot resolve a credential for
// the host grim named, which is correct and stays that way. What was missing is
// everything after that refusal: the toast said "sign in, or store a token" and
// the extension offered neither. Signing in to a GitLab instance needs the
// GitLab Workflow extension (VS Code ships no `gitlab` auth provider of its
// own), and the host-keyed PAT the ladder falls back to had no writer anywhere
// in the codebase — `voteToken`'s SecretStorage branch was unreachable in
// practice.
//
// So this module owns the two things auth.ts deliberately does not: the
// remedies, and the write half of SecretStorage.
import * as vscode from 'vscode';

import { normalizeHost, voteSecretKey, type SecretWriter, type VoteCredential } from '../auth';

/** Marketplace id of the extension that registers the `gitlab` auth provider.
 *  GitHub's two providers are built into VS Code, so this is the only one the
 *  user can be missing. */
const GITLAB_WORKFLOW = 'GitLab.gitlab-workflow';

const STORE_TOKEN = 'Store Token…';
const INSTALL_GITLAB = 'Install GitLab Workflow';

/**
 * Reports a no-credential vote failure with the remedy that actually fits it,
 * and runs whichever the user picks.
 *
 * Deliberately does NOT retry the vote afterwards. A vote is a public post; the
 * click that authorised it was for an attempt that failed, and turning a token
 * prompt into a second, unasked-for post is not the same consent. The user
 * clicks again.
 *
 * `Store Token…` is offered on every reason: it is host-keyed, so it works for
 * a self-managed instance the provider cannot reach, for an instance the
 * provider is pointed away from, and as a plain alternative to signing in.
 */
export async function offerRatingCredential(
  credential: Extract<VoteCredential, { ok: false }>,
  message: string,
  secrets: SecretWriter,
): Promise<void> {
  const actions =
    credential.reason === 'provider-missing' && credential.providerId === 'gitlab'
      ? [INSTALL_GITLAB, STORE_TOKEN]
      : [STORE_TOKEN];
  const picked = await vscode.window.showWarningMessage(message, ...actions);
  if (picked === INSTALL_GITLAB) {
    // Opens the extension's page rather than installing it outright: an
    // install is the user's decision, and the page is also where they sign in
    // afterwards.
    await vscode.commands.executeCommand('extension.open', GITLAB_WORKFLOW);
    return;
  }
  if (picked === STORE_TOKEN) {
    await storeRatingToken(secrets, credential.host);
  }
}

/**
 * Prompts for a personal access token and stores it under the host's key.
 * Returns true when one was stored.
 *
 * `host` comes from the failure that prompted this; from the command palette
 * there is none, so it is asked for. It is never guessed: grim resolves the
 * rating host from the index's own provider config, and a token stored under
 * the wrong key would either sit unused or, worse, be piped at a host it was
 * not issued for.
 */
export async function storeRatingToken(
  secrets: SecretWriter,
  host?: string,
): Promise<boolean> {
  const target = host ?? (await askForHost());
  if (target === undefined) {
    return false;
  }
  const token = await vscode.window.showInputBox({
    title: `Rating token for ${target}`,
    prompt: 'Personal access token with permission to comment on the rating thread.',
    password: true,
    // The box outlives a click elsewhere: losing a pasted token to a stray
    // focus change is a bad trade for a modal that is already explicit.
    ignoreFocusOut: true,
  });
  if (!token) {
    return false;
  }
  await secrets.store(voteSecretKey(target), token);
  void vscode.window.showInformationMessage(`Grimoire: rating token stored for ${target}.`);
  return true;
}

/** Removes the stored token for a host. Without this a token that turns out to
 *  be wrong (expired, wrong scope, wrong account) is unremovable from the UI,
 *  and it takes precedence over nothing — the ladder would keep piping it. */
export async function clearRatingToken(secrets: SecretWriter, host?: string): Promise<void> {
  const target = host ?? (await askForHost());
  if (target === undefined) {
    return;
  }
  await secrets.delete(voteSecretKey(target));
  void vscode.window.showInformationMessage(`Grimoire: rating token cleared for ${target}.`);
}

/** The host a palette invocation did not carry, normalised the same way the
 *  vote ladder normalises the host grim reports. Both sides must agree: the
 *  secret is keyed on the normalised form, so a token typed as `GitLab.com/`
 *  would otherwise be stored where nothing ever reads it. A value that will not
 *  normalise (a URL, a path, anything but an authority) is rejected here rather
 *  than silently stored. */
async function askForHost(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Rating host',
    prompt: 'The forge host the index rates on, e.g. gitlab.com or gitlab.example.com.',
    placeHolder: 'gitlab.com',
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim() === '' || normalizeHost(input.trim()) !== undefined
        ? undefined
        : 'Not a host name — give just the host, e.g. gitlab.example.com.',
  });
  const host = value?.trim();
  return host ? normalizeHost(host) : undefined;
}
