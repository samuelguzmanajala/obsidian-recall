/** Connection to the Recall backend. Captured when the plugin loads; changes apply after a reload. */
export interface BackendConnection {
  url: string;
  token: string;
  /** Publish Markdown notes from this device to the backend. */
  syncNotes: boolean;
  /** Legacy "Use standalone backend" toggle. Ignored: the plugin is always a backend client. */
  enabled?: boolean;
}

/**
 * Plugin data.json. Scheduling settings (tags, limits, audio) live on the server now.
 * Keys written by older versions (local mode, voice API, AI keys…) are kept untouched
 * so saving never silently drops them, but nothing reads them.
 */
export interface PluginSettings {
  backend: BackendConnection;
  /** Deck IDs the user has expanded in the sidebar. */
  expandedDeckIds: string[];
  /** Vault folder where accepted card proposals are appended, one note per deck. */
  proposalInboxFolder: string;
  [legacyKey: string]: unknown;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  backend: { url: '', token: '', syncNotes: false },
  expandedDeckIds: [],
  proposalInboxFolder: 'Recall inbox',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Normalizes whatever `loadData()` returned, preserving unknown and legacy keys. */
export function loadPluginSettings(data: unknown): PluginSettings {
  const stored = isRecord(data) ? data : {};
  const backend = isRecord(stored.backend) ? stored.backend : {};
  const expanded = stored.expandedDeckIds;
  return {
    ...stored,
    backend: {
      ...backend,
      url: typeof backend.url === 'string' ? backend.url : '',
      token: typeof backend.token === 'string' ? backend.token : '',
      syncNotes: backend.syncNotes === true,
    },
    expandedDeckIds: Array.isArray(expanded) ? expanded.filter((id): id is string => typeof id === 'string') : [],
    proposalInboxFolder: normalizeInboxFolder(stored.proposalInboxFolder),
  };
}

/**
 * A vault-relative folder ("Recall inbox", "Languages/Inbox"): trimmed, without leading, trailing or
 * repeated slashes. Anything unusable (empty, "..", hidden or excluded folders) falls back to the default.
 */
export function normalizeInboxFolder(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.proposalInboxFolder;
  const segments = value.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(s => s && s !== '.');
  const unusable = !segments.length || segments.some(s => s === '..' || s.startsWith('.') || s === 'node_modules' || /[\u0000-\u001f:*?"<>|]/.test(s));
  return unusable ? DEFAULT_SETTINGS.proposalInboxFolder : segments.join('/');
}

export function isBackendConfigured(settings: Pick<PluginSettings, 'backend'>): boolean {
  return !!settings.backend.url && !!settings.backend.token;
}
