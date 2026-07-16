// In-memory search cache. grim itself caches the catalog on disk (1h TTL);
// this layer only remembers the last successful result set and when it was
// fetched, for the "Cached catalog · synced Nm ago" footer.
import { searchArgs, type GrimResult, type ItemsEnvelope, type SearchItem } from './grim';
import type { ScopeService } from './scopes';
import { readConfig } from './config';

export interface CatalogState {
  items: SearchItem[];
  syncedAt: number | null;
  error?: string;
  grimMissing?: boolean;
}

export class CatalogService {
  private items: SearchItem[] = [];
  private syncedAt: number | null = null;

  constructor(private readonly scopes: ScopeService) {}

  state(): CatalogState {
    return { items: this.items, syncedAt: this.syncedAt };
  }

  async search(
    query: string,
    options: { refresh?: boolean; projectConfigured?: boolean } = {},
  ): Promise<CatalogState> {
    const args = searchArgs(query, {
      ...(readConfig().showDeprecated ? { showDeprecated: true } : {}),
      ...(options.refresh ? { refresh: true } : {}),
    });
    // Browse is discovery, not project state: an open folder searches project
    // scope ONLY when it has a grimoire.toml. Without one, project-scope search
    // has no registries and returns []; fall back to global so the global
    // registries' catalog is still browsable (and installable globally).
    // Callers pass projectConfigured via scopes.projectSearchable(), which also
    // treats a FAILED project probe as "configured" — otherwise a transient
    // probe error would silently fall back to global too, instead of searching
    // project scope and surfacing the failure as a search error.
    const scope =
      this.scopes.projectFolder() && options.projectConfigured ? 'project' : 'global';
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
    this.items = Array.isArray(result.value.items) ? result.value.items : [];
    this.syncedAt = Date.now();
    return this.state();
  }
}
