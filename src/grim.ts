// Wrapper around the `grim` CLI. All invocations go through execFile (no
// shell). Every reporting command is called with `--format json`, which per
// grim's frozen JSON interface emits exactly one JSON document on stdout:
// multi-item reports as {"items":[...]}, failures as
// {"error":{code,exit,message}}. Branch on the top-level `error` key first,
// then on exit codes. Clap parse errors (e.g. unknown subcommand) exit 64
// with plain text and no JSON — that is the feature-detect signal for newer
// subcommands like `describe`.
import { execFile } from 'child_process';

export type Scope = 'project' | 'global';

// --- Wire types (nullable fields are honest: the default index returns null
// --- for most metadata; OCI-backed registries fill more in).

export interface SearchItem {
  kind: string | null;
  repo: string;
  summary: string | null;
  description: string | null;
  version: string | null;
  latest_tag: string | null;
  repository: string | null;
  revision: string | null;
  created: string | null;
  deprecated: string | null;
  replaced_by?: string | null;
  status: string;
}

export interface FetchFile {
  path: string;
  size: number;
}

/** One member of a description companion report (`fetch --description`). `content`
 *  is the file body — omit-empty, so an empty member (e.g. a placeholder README)
 *  ships none. `encoding` is present only for binary members ("base64"), omitted
 *  (utf8) otherwise — the documented omit-empty exemption to grim's
 *  always-present-null rule. */
export interface DescFile {
  path: string;
  size: number;
  content?: string;
  encoding?: string;
}

/** `fetch <ref> --description --format json`: one report with every companion
 *  file inline. Well-known members (README.md, logo.png|logo.svg, CHANGELOG.md)
 *  are all optional; extra README-referenced assets may appear. No top-level
 *  `content`. A missing companion is a not-found error envelope (exit 79). */
export interface DescriptionResult {
  ref: string;
  digest: string;
  kind: string;
  files: DescFile[];
}

/** `fetch <ref> [--description] --digest-only --format json`: the digest only,
 *  no download. Without --description it is the artifact manifest digest; with
 *  it, the companion tag's digest. */
export interface DigestResult {
  ref: string;
  digest: string;
}

export interface FetchResult {
  ref: string;
  digest: string;
  kind: string | null;
  name: string;
  vendor: string;
  path?: string;
  content: string;
  encoding?: string;
  truncated?: boolean;
  files?: FetchFile[];
  warnings?: string[];
}

export interface StatusOutput {
  client: string;
  path: string;
}

export interface StatusItem {
  kind: string;
  name: string;
  source: string;
  // null for unlocked artifacts (grim emits `pinned: null` when the lock has no
  // pinned entry — e.g. a floating tag). Nullable means null; never deref raw.
  pinned: string | null;
  state: string;
  outputs: StatusOutput[];
}

export interface RegistryInfo {
  alias: string | null;
  url: string;
  kind: string;
  default: boolean;
  // Additive (frozen-additive): true when grim has a stored credential for this
  // registry host. Absent on older binaries — treat a missing field as false.
  authenticated?: boolean;
}

export interface ContextInfo {
  version: string;
  scope: string;
  workspace: string | null;
  config_path: string;
  config_exists: boolean;
  lock_path: string;
  lock_exists: boolean;
  state_path?: string | null;
  grim_home: string;
  offline: boolean;
  clients: string[];
  registries: RegistryInfo[];
  default_registry: string | null;
}

export interface DescribeResult {
  ref: string;
  digest: string;
  kind: string | null;
  name: string;
  title: string | null;
  description: string | null;
  summary: string | null;
  version: string | null;
  license: string | null;
  repository: string | null;
  revision: string | null;
  created: string | null;
  keywords: string[] | null;
  deprecated: string | null;
  replaced_by: string | null;
  tags: string[];
  annotations: Record<string, string>;
  // Additive (frozen-additive, same tolerance pattern as `registries[].authenticated`
  // in ContextInfo): true when the artifact publishes a description companion.
  // Absent (a grim predating the v2 surface) or false → no companion; the details
  // view shows in-tree content only. No compat shim (pre-1.0 policy).
  has_description?: boolean;
}

export interface ActionReport {
  kind?: string;
  name?: string;
  status?: string;
  path?: string;
  scope?: string;
  pinned?: string;
}

/** `grim uninstall` single-item report status (bundle members are a no-op). */
export type UninstallStatus = 'uninstalled' | 'kept-by-bundle' | 'not-installed';
/** `grim remove` single-item report status (undeclare a bundle). */
export type RemoveStatus = 'removed' | 'absent';

export interface ItemsEnvelope<T> {
  items: T[];
}

// --- Config wire types (`grim config ...`). `type` is grim's presentation
// --- metadata for a key's value (string/boolean/enum/string-set/string-list/
// --- integer today) — kept as an open `string` here, not a closed union: the
// --- JSON contract is frozen/additive, so a future grim may add a type this
// --- extension doesn't know yet. Narrowing + the "unknown type degrades to a
// --- read-only row" rule live in webview/settings (buildSettingsVM), same
// --- split as SearchItem.kind (open here) / ArtifactKind (closed, webview).

/** One row of `grim config list --all`. All 8 fields always present
 *  (always-present-null policy) whether or not `--all` was passed. */
export interface ConfigEntry {
  key: string;
  value: string | null;
  set: boolean;
  type: string;
  title: string;
  description: string;
  default: string | null;
  values: string[] | null;
}

/** One row of `grim config registry list`. Exactly one of `oci`/`index` is
 *  non-null for a valid entry; `alias: null` marks a legacy (pre-alias) row. */
export interface RegistryEntry {
  alias: string | null;
  oci: string | null;
  index: string | null;
  default: boolean;
}

/** The write confirmation shared by `config set`, `config unset`, and every
 *  `config registry add|rm|use` — one report shape, discriminated by `action`. */
export type ConfigWriteAction =
  | 'set'
  | 'unset'
  | 'registry-added'
  | 'registry-removed'
  | 'registry-default';

export interface ConfigWriteResult {
  action: ConfigWriteAction;
  key: string;
  value: string | null;
  scope: Scope;
}

// --- Results

export type GrimResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'not-found' }
  | {
      ok: false;
      kind: 'error';
      code: string;
      exitCode: number;
      message: string;
      // Optional error discriminator (frozen-additive, omitted for most
      // errors). grim tags a stale-lock partial-resolve refusal as
      // reason:"stale-lock"; kept a plain string, never an enum.
      reason?: string;
    };

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface ErrorDoc {
  error: { code: string; exit: number; message: string; reason?: string };
}

function isErrorDoc(doc: unknown): doc is ErrorDoc {
  if (typeof doc !== 'object' || doc === null) {
    return false;
  }
  const err = (doc as Record<string, unknown>)['error'];
  return typeof err === 'object' && err !== null && 'message' in (err as object);
}

/** Parses one grim `--format json` stdout document into a GrimResult. Exported for tests. */
export function parseReport<T>(stdout: string, exitCode: number, stderr: string): GrimResult<T> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    // No JSON on stdout: clap parse errors (exit 64) and other pre-contract
    // failures. Surface whatever text we have.
    const message = (stderr || stdout).trim() || `grim exited with code ${exitCode}`;
    return {
      ok: false,
      kind: 'error',
      code: exitCode === 64 ? 'usage' : 'failure',
      exitCode,
      message,
    };
  }
  if (isErrorDoc(doc)) {
    return {
      ok: false,
      kind: 'error',
      code: doc.error.code,
      exitCode: doc.error.exit,
      message: doc.error.message,
      // Additive: surface `reason` verbatim when present, else leave undefined.
      ...(doc.error.reason !== undefined ? { reason: doc.error.reason } : {}),
    };
  }
  return { ok: true, value: doc as T };
}

/** Runs grim with `--format json` appended and parses the report. Builders
 *  that need a `--` separator (e.g. searchArgs, before a user-controlled
 *  positional query) put it in `args`; the format flag is inserted before it
 *  so it's still parsed as a flag, not swept up as another positional. */
export function runJson<T>(
  executable: string,
  args: string[],
  options: RunOptions = {},
): Promise<GrimResult<T>> {
  return new Promise((resolve) => {
    const sep = args.indexOf('--');
    const fullArgs =
      sep === -1
        ? [...args, '--format', 'json']
        : [...args.slice(0, sep), '--format', 'json', ...args.slice(sep)];
    const child = execFile(
      executable,
      fullArgs,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, kind: 'not-found' });
          return;
        }
        const exitCode = typeof child.exitCode === 'number' ? child.exitCode : 1;
        resolve(parseReport<T>(stdout, exitCode, stderr));
      },
    );
  });
}

// --- Pure argv builders (exported for tests). `--format json` is appended by
// --- runJson; builders emit subcommand + flags only. Scope (`--global`) is
// --- NOT a builder concern — ScopeService.run prepends it via withGlobalFlag
// --- for global-scope calls, so a builder emitting it too would risk clap
// --- rejecting a doubled top-level flag.

export function searchArgs(
  query: string,
  options: { refresh?: boolean; showDeprecated?: boolean } = {},
): string[] {
  const args = ['search'];
  if (options.refresh) {
    args.push('--refresh');
  }
  if (options.showDeprecated) {
    args.push('--show-deprecated');
  }
  // grim's [QUERY] is ONE positional — grim whitespace-splits and ANDs the
  // terms itself. Passing pre-split words as separate argv entries makes clap
  // reject the second one ("unexpected argument"), so the whole query travels
  // as a single string. It is free text (e.g. a tag chip or typed term) and
  // may start with "-"/"--" (a term like "--foo"); a `--` separator after
  // every flag forces clap to treat it as positional instead of an
  // unknown-flag parse error.
  const trimmed = query.trim();
  if (trimmed.length > 0) {
    args.push('--', trimmed);
  }
  return args;
}

export function fetchArgs(
  reference: string,
  options: {
    path?: string;
    vendor?: string;
    description?: boolean;
    digestOnly?: boolean;
  } = {},
): string[] {
  const args = ['fetch', reference];
  if (options.path) {
    args.push('--path', options.path);
  }
  if (options.vendor) {
    args.push('--vendor', options.vendor);
  }
  if (options.description) {
    args.push('--description');
  }
  if (options.digestOnly) {
    args.push('--digest-only');
  }
  return args;
}

export function describeArgs(reference: string): string[] {
  return ['describe', reference];
}

export function statusArgs(): string[] {
  return ['status'];
}

export function contextArgs(): string[] {
  return ['context'];
}

export function addArgs(
  reference: string,
  options: { kind?: string; name?: string; noInstall?: boolean } = {},
): string[] {
  const args = ['add', reference];
  if (options.kind) {
    args.push('--kind', options.kind);
  }
  if (options.name) {
    args.push('--name', options.name);
  }
  if (options.noInstall) {
    args.push('--no-install');
  }
  return args;
}

export function removeArgs(kind: string, name: string): string[] {
  return ['remove', kind, name];
}

export function uninstallArgs(kind: string, name: string): string[] {
  return ['uninstall', kind, name];
}

/**
 * Shared uninstall decision for both action hosts: `grim uninstall` rejects
 * kind `bundle` at clap parse time, so bundles are undeclared via `grim remove`
 * instead; every other kind uses `uninstall`.
 */
export function uninstallOrRemoveArgs(kind: string, name: string): string[] {
  return kind === 'bundle' ? removeArgs(kind, name) : uninstallArgs(kind, name);
}

/**
 * Info message when an uninstall was a deliberate no-op (`UninstallStatus`
 * other than "uninstalled") so callers don't silently report success; null
 * when the member was actually removed or the report has no such status.
 */
export function uninstallNotice(report: ActionReport): string | null {
  const name = report.name ?? 'This artifact';
  if (report.status === 'kept-by-bundle') {
    return `${name} is installed via a bundle — uninstall the bundle to remove it.`;
  }
  if (report.status === 'not-installed') {
    return `${name} was not installed.`;
  }
  return null;
}

export function updateArgs(names: string[] = []): string[] {
  return ['update', ...names];
}

export function installArgs(options: { client?: string } = {}): string[] {
  const args = ['install'];
  if (options.client) {
    args.push('--client', options.client);
  }
  return args;
}

export function initArgs(options: { registry?: string } = {}): string[] {
  const args = ['init'];
  if (options.registry) {
    args.push('--registry', options.registry);
  }
  return args;
}

// --- Config argv builders (`grim config ...`). Scope is still not a builder
// --- concern here — ScopeService.run prepends `--global` for global-scope
// --- calls (see withGlobalFlag in scopes.ts); these builders never emit it.

export function configListArgs(options: { all?: boolean } = {}): string[] {
  const args = ['config', 'list'];
  if (options.all) {
    args.push('--all');
  }
  return args;
}

/** `value` is free text a user can type into a Settings text/chip control and
 *  may start with "-"/"--" (same clap hazard searchArgs documents for a
 *  free-text positional: `config set <key> <value>` are both trailing
 *  positionals with no `allow_hyphen_values`, so a value like "--foo" parses
 *  as an unknown flag instead of the intended positional). `--` forces both
 *  to parse positionally regardless of content. */
export function configSetArgs(key: string, value: string): string[] {
  return ['config', 'set', '--', key, value];
}

export function configUnsetArgs(key: string): string[] {
  return ['config', 'unset', key];
}

export function registryListArgs(): string[] {
  return ['config', 'registry', 'list'];
}

/** Exactly one of `oci`/`index` — clap's `--oci`/`--index` are
 *  mutually exclusive, so a discriminated union makes the invalid "both" or
 *  "neither" state unrepresentable at the call site instead of a runtime check. */
export type RegistryLocator = { oci: string } | { index: string };

/** `alias`/`locator` are free text (the add-registry form) and may start with
 *  "-"/"--" — the same hazard class as configSetArgs's `value`. `--oci`/
 *  `--index` are FLAG values, not positionals, so the `--` separator can't
 *  protect them (it disables flag parsing for everything after it, which
 *  would also swallow `--default`); the `--flag=value` form sidesteps that
 *  unambiguously instead, since `=` delimits the value from the flag name at
 *  the token level regardless of what the value looks like. `alias` IS a
 *  trailing positional (nothing follows it), so it gets searchArgs's `--`
 *  treatment, emitted last. */
export function registryAddArgs(
  alias: string,
  locator: RegistryLocator,
  options: { default?: boolean } = {},
): string[] {
  const args = ['config', 'registry', 'add'];
  args.push('oci' in locator ? `--oci=${locator.oci}` : `--index=${locator.index}`);
  if (options.default) {
    args.push('--default');
  }
  args.push('--', alias);
  return args;
}

/** `alias` names an existing registry — but one originally created via
 *  registryAddArgs's free-text alias field, so it may still start with
 *  "-"/"--"; same `--` treatment as configSetArgs. */
export function registryRmArgs(alias: string): string[] {
  return ['config', 'registry', 'rm', '--', alias];
}

export function registryUseArgs(alias: string): string[] {
  return ['config', 'registry', 'use', '--', alias];
}
