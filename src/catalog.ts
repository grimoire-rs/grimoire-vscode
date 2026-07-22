// In-memory search cache. grim itself caches the catalog on disk (1h TTL);
// this layer only remembers the last successful result set and when it was
// fetched, for the "Cached catalog · synced Nm ago" footer.
import { searchArgs, type GrimResult, type ItemsEnvelope, type SearchItem } from './grim';
import type { ScopeService } from './scopes';

export interface CatalogState {
  items: SearchItem[];
  syncedAt: number | null;
  error?: string;
  grimMissing?: boolean;
}

export class CatalogService {
  private items: SearchItem[] = [];
  private syncedAt: number | null = null;
  /** Monotonic search generation, so a slow response can't overwrite a newer
   *  one's results. Same pattern as SidebarProvider.refreshGen — but that one
   *  only gates POSTING to its own webview; this shared cache is written by
   *  every caller (the sidebar's search box, watcher and command refreshes,
   *  the details panels' catalog lookups) and had no ordering guard at all. */
  private generation = 0;

  constructor(private readonly scopes: ScopeService) {}

  state(): CatalogState {
    return { items: this.items, syncedAt: this.syncedAt };
  }

  async search(
    query: string,
    options: { refresh?: boolean; projectConfigured?: boolean } = {},
  ): Promise<CatalogState> {
    // grim's own `options.show_deprecated` config (set via the Settings panel,
    // which replaced the old grimoire.showDeprecated VS Code setting) drives
    // this now — the flag is omitted so `grim search` honors whatever the
    // user has configured, no VS Code-side override.
    const args = searchArgs(query, options.refresh ? { refresh: true } : {});
    // Browse is discovery, not project state: an open folder searches project
    // scope ONLY when it has a grimoire.toml. Without one, project-scope search
    // has no registries and returns []; fall back to global so the global
    // registries' catalog is still browsable (and installable globally).
    // Callers pass projectConfigured via scopes.projectSearchable(), which also
    // treats a FAILED project probe as "configured" — otherwise a transient
    // probe error would silently fall back to global too, instead of searching
    // project scope and surfacing the failure as a search error.
    const scope = this.scopes.projectFolder() && options.projectConfigured ? 'project' : 'global';
    const generation = ++this.generation;
    const result: GrimResult<ItemsEnvelope<SearchItem>> = await this.scopes.run(args, scope);
    if (!result.ok) {
      if (result.kind === 'not-found') {
        return { items: [], syncedAt: this.syncedAt, grimMissing: true };
      }
      return { items: this.items, syncedAt: this.syncedAt, error: result.message };
    }
    // Boundary guard: an envelope that parses ok but whose `items` is missing
    // or not an array (contract violation, but observed from misbehaving stubs
    // and possible on a version-skewed grim) must not poison the cache — the
    // card builders iterate it.
    const items = Array.isArray(result.value.items) ? result.value.items : [];
    if (generation !== this.generation) {
      // A newer search started while this one was in flight and its results
      // are what the cache should hold. Return this caller's own results —
      // they are real, just superseded — without clobbering the cache.
      return { items, syncedAt: this.syncedAt };
    }
    this.items = items;
    this.syncedAt = Date.now();
    return this.state();
  }
}
