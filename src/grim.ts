// Wrapper around the `grim` CLI. All invocations go through execFile (no
// shell). Every reporting command is called with `--format json`, which per
// grim's frozen JSON interface emits exactly one JSON document on stdout:
// multi-item reports as {"items":[...]}, failures as
// {"error":{code,exit,message}}. Branch on the top-level `error` key first,
// then on exit codes. Clap parse errors (e.g. unknown subcommand) exit 64
// with plain text and no JSON — that is the feature-detect signal for newer
// subcommands like `describe`.
import { execFile } from 'child_process';

import { registryFieldKey, type RegistryFieldState } from './webview/protocol';

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
  // Client-set drift, computed from local state (config + install record) with
  // no network — so populated on a plain `grim status`, not just `--check`.
  // `clients_missing` is desired−recorded, `clients_extra` recorded−desired;
  // both sorted, both `[]` when the sets agree AND always `[]` when the
  // project's client target is unset (autodetect — no explicit set to diff).
  clients_missing: string[];
  clients_extra: string[];
  // The `--check` surface: grim's live catalog lookup. `deprecated`/`replaced_by`
  // mirror `grim search`'s fields; `update_available` is a fresh per-artifact
  // re-resolution (true=registry newer, false=matches). All three are null on a
  // plain `grim status` (no `--check` ⇒ no network) and for rows with no registry
  // pin (bundle members, dev-installs, path sources); absence never lies as false.
  deprecated: string | null;
  replaced_by: string | null;
  update_available: boolean | null;
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

/** `grim status`'s envelope. `checked` is `true` only when `--check` was passed
 *  AND the invocation ran online — an offline `--check` degrades with a stderr
 *  warning and reports `false`. grim's contract: `checked === false` implies
 *  `deprecated`/`replaced_by`/`update_available` are null on EVERY item, so it
 *  is the discriminator between "grim says there is no update" and "grim did
 *  not look". Optional here like every additive field — an envelope without it
 *  reads as "did not look", which is the safe direction. */
export interface StatusEnvelope extends ItemsEnvelope<StatusItem> {
  checked?: boolean;
}

/** One row of `grim update --format json`'s `items` envelope: one artifact's
 *  update outcome. `old`/`new` are digests — `old: null` means the artifact
 *  had no previous lock entry, `new: null` means the row left the lock
 *  (pruned or kept-modified) and has no current digest.
 *  `reaped_clients`/`kept_modified_clients` are always-present sorted client
 *  arrays (`[]` when no client was dropped for this row); reap is only ever
 *  attempted against an explicitly set `[options].clients` — with autodetect
 *  (no explicit set) both stay `[]` for every row. */
export interface UpdateEntry {
  kind: string;
  name: string;
  old: string | null;
  new: string | null;
  action: 'updated' | 'unchanged' | 'removed' | 'kept-modified';
  reaped_clients: string[];
  kept_modified_clients: string[];
}

// --- Config wire types (`grim config ...`). `type` is grim's presentation
// --- metadata for a key's value (string/boolean/enum/string-set/string-list/
// --- integer today) — kept as an open `string` here, not a closed union: the
// --- JSON contract is frozen/additive, so a future grim may add a type this
// --- extension doesn't know yet. Narrowing + the "unknown type degrades to a
// --- read-only row" rule live in webview/settings (buildSettingsVM), same
// --- split as SearchItem.kind (open here) / ArtifactKind (closed, webview).

/** Advisory pre-check constraints on the individual items of a list-valued
 *  config key (e.g. `options.tui.tree_separators`) — mirrors grim's
 *  `ValueConstraints`. Necessary, NOT sufficient: `item_pattern` can't
 *  express every shape rule (e.g. Unicode display width, covered instead by
 *  `item_width`); grim's own `config set` validation is authoritative
 *  regardless of what this pre-check says. */
export interface ConfigConstraints {
  item_pattern: string;
  item_width: number;
}

/** One row of `grim config list --all`. All 9 fields always present
 *  (always-present-null policy) whether or not `--all` was passed.
 *  `constraints` is non-null only for keys whose list items carry a shape
 *  rule beyond membership in `values` (e.g. `options.clients`'s closed set
 *  needs none). */
export interface ConfigEntry {
  key: string;
  value: string | null;
  set: boolean;
  type: string;
  title: string;
  description: string;
  default: string | null;
  values: string[] | null;
  constraints: ConfigConstraints | null;
}

/** One row of `grim config registry list`. Exactly one of `oci`/`index` is
 *  non-null for a valid entry; `alias: null` marks a legacy (pre-alias) row. */
export interface RegistryEntry {
  alias: string | null;
  oci: string | null;
  index: string | null;
  // Additive (frozen-additive): the entry's browse filters, in declaration
  // order, `[]` when unfiltered. They narrow what BROWSING shows (search, TUI,
  // MCP) and nothing else — resolve, lock, install and `status --check` all
  // ignore them, and a fully-qualified ref to an excluded package still
  // installs. Absent on older binaries — read as `[]`, never as "no filter
  // is possible".
  include?: string[];
  exclude?: string[];
  default: boolean;
}

/** One row of `grim config registry fields` — presentation metadata for the
 *  add-registry form's oci/index/default controls (same title/description
 *  convention as ConfigEntry). Context-free: no scope or workspace
 *  dependency, unlike every other `config` subcommand here — fetched once
 *  per Settings panel lifetime and cached (see SettingsManager), not
 *  refetched per scope. */
export interface RegistryFieldEntry {
  key: string;
  type: string;
  title: string;
  description: string;
}

/** The write confirmation shared by `config set`, `config unset`, and every
 *  `config registry add|set|rm|use` — one report shape, discriminated by `action`. */
export type ConfigWriteAction =
  'set' | 'unset' | 'registry-added' | 'registry-set' | 'registry-removed' | 'registry-default';

export interface ConfigWriteResult {
  action: ConfigWriteAction;
  key: string;
  value: string | null;
  scope: Scope;
  // `--dry-run` is `set`-only in grim: `true` when the write was validated
  // and reported but never committed, `false` for every real write (and for
  // `unset`/registry actions, which have no dry-run surface at all).
  dry_run: boolean;
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
      // Additive: grim omits this key unless `reason` is present AND that
      // reason is retryable (currently only "locked") — never a bare
      // `false`. See isRetryable, which also treats exit 75 (EX_TEMPFAIL)
      // as retryable regardless of this field, for callers on older grim
      // builds that predate it.
      retryable?: boolean;
      // Additive: grim omits this key unless `reason` is present AND that
      // reason is forceable (currently "modified" and "untracked-destination")
      // — never a bare `false`. See isForceable.
      forceable?: boolean;
    };

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface ErrorDoc {
  error: {
    code: string;
    exit: number;
    message: string;
    reason?: string;
    retryable?: boolean;
    forceable?: boolean;
  };
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
      // Additive: surface `retryable` verbatim when present, else leave undefined.
      ...(doc.error.retryable !== undefined ? { retryable: doc.error.retryable } : {}),
      // Additive: surface `forceable` verbatim when present, else leave undefined.
      ...(doc.error.forceable !== undefined ? { forceable: doc.error.forceable } : {}),
    };
  }
  return { ok: true, value: doc as T };
}

/** True when a failed grim call is worth retrying once: grim tagged the
 *  error itself (`retryable: true`, currently only the "locked" reason), or
 *  the exit code is 75 (`sysexits.h` EX_TEMPFAIL) — the same signal callers
 *  checked directly before grim started emitting `retryable`. The exit-75
 *  fallback is deliberately broader than lock contention: grim also exits
 *  75 for other temporary failures with no `retryable` tag (e.g. a
 *  credential-helper timeout), so this may green-light one extra attempt
 *  there — harmless for the write/switch call sites that use it. When
 *  `retryable` is present it's only ever `true` (grim never sends a bare
 *  `false`), so an explicit `false` is treated as "not tagged" and exit 75
 *  still wins. Pure; exported for tests. */
export function isRetryable(result: { exitCode: number; retryable?: boolean }): boolean {
  return result.retryable === true || result.exitCode === 75;
}

/** True when a failed grim call names a refusal that a retry with `--force`
 *  can resolve (currently the "modified" and "untracked-destination"
 *  reasons). Unlike isRetryable, there is no exit-code fallback: exit 65
 *  covers many non-forceable failures too (e.g. anchor-escape), and
 *  MINIMUM_GRIM_VERSION guarantees this key is present whenever `forceable`
 *  is true. Pure; exported for tests. */
export function isForceable(result: { forceable?: boolean }): boolean {
  return result.forceable === true;
}

/** Adds flags to an argv the builders below may have ended with a `--`
 *  separator: everything after that token parses as a positional, so a flag
 *  appended to the tail would be swallowed as one (`grim add -- ref --force`
 *  reads `--force` as a second reference). Inserted before the separator
 *  instead — or plainly appended when there is none. Pure; the one place that
 *  knows the rule, shared by runJson's `--format json` and the force retry. */
export function withFlags(args: string[], flags: string[]): string[] {
  const sep = args.indexOf('--');
  return sep === -1
    ? [...args, ...flags]
    : [...args.slice(0, sep), ...flags, ...args.slice(sep)];
}

/** The positional an action's argv names — the reference for `add`, the
 *  artifact name for `update`. Reads the token after the `--` separator the
 *  builders emit, falling back to argv[1] for a builder that has none. Pure;
 *  used for the human-facing name in a failure dialog, never for a respawn. */
export function positionalOf(args: string[]): string {
  const sep = args.indexOf('--');
  return (sep === -1 ? args[1] : args[sep + 1]) ?? '';
}

/** Runs grim with `--format json` and parses the report. Builders end with a
 *  `--` separator before their positionals; the format flag goes in front of
 *  it (see {@link withFlags}) so it's still parsed as a flag. */
export function runJson<T>(
  executable: string,
  args: string[],
  options: RunOptions = {},
): Promise<GrimResult<T>> {
  return new Promise((resolve) => {
    const fullArgs = withFlags(args, ['--format', 'json']);
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

// --- Pure argv builders (exported for tests). `--format json` is inserted by
// --- runJson; builders emit subcommand + flags + positionals. Scope
// --- (`--global`) is NOT a builder concern — ScopeService.run prepends it via
// --- withGlobalFlag for global-scope calls, so a builder emitting it too would
// --- risk clap rejecting a doubled top-level flag.
// ---
// --- EVERY positional goes behind a `--` separator, and every flag in front of
// --- it. The values are not ours: repos and artifact names come off the
// --- registry catalog and grim's own status rows, and a repo like `--global`
// --- would otherwise reach clap as a FLAG rather than the reference it is
// --- (argument injection — the security rule this repo already applies to
// --- searchArgs' free-text query and the config/registry builders). None of
// --- grim's positionals set `allow_hyphen_values`, so `--` is the only thing
// --- that forces the parse; flags must precede it, since clap treats every
// --- token after it as positional.

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
  const args = ['fetch'];
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
  args.push('--', reference);
  return args;
}

export function describeArgs(reference: string): string[] {
  return ['describe', '--', reference];
}

/** `--check` re-checks every registry-sourced artifact against the live catalog
 *  (deprecation/replacement) and re-resolves each locked artifact's current tag
 *  for honest `update_available` — network-verified, so reserved for the explicit
 *  "Check for updates" command and the daily interval, never a plain refresh. */
export function statusArgs(options: { check?: boolean } = {}): string[] {
  const args = ['status'];
  if (options.check) {
    args.push('--check');
  }
  return args;
}

export function contextArgs(): string[] {
  return ['context'];
}

export function addArgs(
  reference: string,
  options: { kind?: string; name?: string; noInstall?: boolean } = {},
): string[] {
  const args = ['add'];
  if (options.kind) {
    args.push('--kind', options.kind);
  }
  if (options.name) {
    args.push('--name', options.name);
  }
  if (options.noInstall) {
    args.push('--no-install');
  }
  args.push('--', reference);
  return args;
}

export function removeArgs(kind: string, name: string): string[] {
  return ['remove', '--', kind, name];
}

export function uninstallArgs(kind: string, name: string): string[] {
  return ['uninstall', '--', kind, name];
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

/** A bare `grim update` (every artifact) emits no separator: with no
 *  positional to protect, a trailing `--` is noise the force retry would then
 *  have to reason about. */
export function updateArgs(names: string[] = []): string[] {
  return names.length > 0 ? ['update', '--', ...names] : ['update'];
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
 *  to parse positionally regardless of content — so `--dry-run` (a flag,
 *  not a positional) must land BEFORE the `--` separator, or it would be
 *  swallowed as a third positional instead of parsed as a flag. `--dry-run`
 *  is `set`-only in grim: validates and reports without writing. */
export function configSetArgs(
  key: string,
  value: string,
  options: { dryRun?: boolean } = {},
): string[] {
  const args = ['config', 'set'];
  if (options.dryRun) {
    args.push('--dry-run');
  }
  args.push('--', key, value);
  return args;
}

/** `--` for the same reason configSetArgs has one: `<key>` is a trailing
 *  positional with no `allow_hyphen_values`. Today's keys are all
 *  extension-built, but the separator costs nothing and keeps the two write
 *  builders one shape. */
export function configUnsetArgs(key: string): string[] {
  return ['config', 'unset', '--', key];
}

export function registryListArgs(): string[] {
  return ['config', 'registry', 'list'];
}

/** `grim config registry fields`: presentation metadata (title/description)
 *  for the add-registry form's oci/index/default controls — context-free
 *  (no scope-dependent state), so callers fetch it once rather than per
 *  scope switch. */
export function registryFieldsArgs(): string[] {
  return ['config', 'registry', 'fields'];
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
 *  treatment, emitted last.
 *
 *  `include`/`exclude` are browse-filter globs and repeat once per pattern —
 *  never comma-joined, because a comma is glob alternation syntax
 *  (`acme/{platform,tools}/**` is ONE pattern) and grim splits neither flag.
 *  They take the same `--flag=value` form and for a stronger reason than the
 *  locator: a glob legitimately starting with "-" is ordinary, not exotic.
 *  These repeated flags — here and on registrySetArgs — are the only CLI path
 *  that writes a multi-pattern list; `config set` takes one pattern and
 *  replaces the whole list. */
export function registryAddArgs(
  alias: string,
  locator: RegistryLocator,
  options: { default?: boolean; include?: string[]; exclude?: string[] } = {},
): string[] {
  const args = ['config', 'registry', 'add'];
  args.push('oci' in locator ? `--oci=${locator.oci}` : `--index=${locator.index}`);
  for (const pattern of options.include ?? []) {
    args.push(`--include=${pattern}`);
  }
  for (const pattern of options.exclude ?? []) {
    args.push(`--exclude=${pattern}`);
  }
  if (options.default) {
    args.push('--default');
  }
  args.push('--', alias);
  return args;
}

/** `config registry set` — edits an existing entry IN PLACE, keeping its
 *  position in `[[registries]]`. grim reads an omitted flag as "leave that
 *  field alone", so this builder emits only what the caller actually names.
 *
 *  Same escaping rules as registryAddArgs, which this mirrors flag for flag:
 *  `--flag=value` for everything (they are flag values, so the `--` separator
 *  cannot protect a locator or a glob starting with "-"), alias last behind
 *  `--`, one repetition per pattern and never comma-joined.
 *
 *  `include`/`exclude` REPLACE the whole list when given, and a flag given
 *  zero times means "untouched" — so an empty list has no spelling of its own.
 *  `--clear-include`/`--clear-exclude` are that spelling. They are mutually
 *  exclusive with the pattern flags for the SAME field, which the if/else
 *  below makes unrepresentable in the argv regardless of what a caller
 *  passes. */
export function registrySetArgs(
  alias: string,
  locator: RegistryLocator,
  options: {
    default?: boolean;
    include?: string[];
    exclude?: string[];
    clearInclude?: boolean;
    clearExclude?: boolean;
  } = {},
): string[] {
  const args = ['config', 'registry', 'set'];
  args.push('oci' in locator ? `--oci=${locator.oci}` : `--index=${locator.index}`);
  if (options.clearInclude) {
    args.push('--clear-include');
  } else {
    for (const pattern of options.include ?? []) {
      args.push(`--include=${pattern}`);
    }
  }
  if (options.clearExclude) {
    args.push('--clear-exclude');
  } else {
    for (const pattern of options.exclude ?? []) {
      args.push(`--exclude=${pattern}`);
    }
  }
  if (options.default) {
    args.push('--default');
  }
  args.push('--', alias);
  return args;
}

/** The three registry fields an edit cannot clear by omission — held twice
 *  (target and starting point) so {@link editRegistrySteps} can tell a real
 *  clear from a field that was already empty or already off. The locator is
 *  not here: it is always written, so it travels as its own parameter.
 *
 *  Re-exported from the wire protocol rather than declared again: the webview
 *  builds this exact object and posts it, so a second declaration here could
 *  drift from the one on the wire with no type error to say so. This is the
 *  one direction that stays legal — `webview/protocol.ts` is dependency-free
 *  precisely so both sides may import it, and it never imports back. */
export type { RegistryFieldState };

/** The argv sequence that makes an existing registry match `desired`, applied
 *  in order and aborted at the first failure (see SettingsManager.writeInner).
 *
 *  One `registry set` carries the whole edit, emptied pattern lists included
 *  (see {@link registrySetArgs}). DEMOTION is the one edit that cannot ride
 *  along: `--default` only ever promotes — it clears every OTHER entry's flag,
 *  the way `registry use` does, and has no negative form — so unchecking it
 *  appends a second step, `config set registry.<alias>.default false`.
 *
 *  Every subtractive form is emitted only when `previous` shows it would
 *  change something, so an ordinary save — nothing cleared, not the default —
 *  is the same argv it was before either feature existed. */
export function editRegistrySteps(
  alias: string,
  locator: RegistryLocator,
  desired: RegistryFieldState,
  previous: RegistryFieldState,
): string[][] {
  const steps = [
    registrySetArgs(alias, locator, {
      default: desired.default,
      include: desired.include,
      exclude: desired.exclude,
      clearInclude: desired.include.length === 0 && previous.include.length > 0,
      clearExclude: desired.exclude.length === 0 && previous.exclude.length > 0,
    }),
  ];
  if (!desired.default && previous.default) {
    steps.push(configSetArgs(registryFieldKey(alias, 'default'), 'false'));
  }
  return steps;
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
