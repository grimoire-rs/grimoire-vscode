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

  async search(query: string, options: { refresh?: boolean } = {}): Promise<CatalogState> {
    const args = searchArgs(query, {
      ...(readConfig().showDeprecated ? { showDeprecated: true } : {}),
      ...(options.refresh ? { refresh: true } : {}),
    });
    const scope = this.scopes.projectFolder() ? 'project' : 'global';
    const result: GrimResult<ItemsEnvelope<SearchItem>> = await this.scopes.run(args, scope);
    if (!result.ok) {
      if (result.kind === 'not-found') {
        return { items: [], syncedAt: this.syncedAt, grimMissing: true };
      }
      return { items: this.items, syncedAt: this.syncedAt, error: result.message };
    }
    this.items = result.value.items;
    this.syncedAt = Date.now();
    return this.state();
  }
}
