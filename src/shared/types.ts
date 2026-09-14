export type ColumnKind = 'search' | 'account' | 'list';
export type FeedStatus = 'idle' | 'loading' | 'ready' | 'paused' | 'login-required' | 'rate-limited' | 'error';

export interface Author {
  name: string;
  handle: string;
  avatar?: string;
  verified: boolean;
}

export interface Post {
  id: string;
  url: string;
  text: string;
  author: Author;
  createdAt: string;
  media: { type: 'image' | 'video'; url: string; alt?: string }[];
  counts: { replies: string; reposts: string; likes: string; views?: string };
  quote?: { text: string; author: string; url?: string };
  repostedBy?: string;
  isReply: boolean;
}

export interface ColumnConfig {
  id: string;
  kind: ColumnKind;
  title: string;
  query: string;
  color: string;
  width: number;
  refreshSeconds: number;
  paused: boolean;
  mediaOnly: boolean;
  hideReplies: boolean;
  mutedWords: string[];
}

export interface Feed {
  posts: Post[];
  pending: Post[];
  status: FeedStatus;
  error?: string;
  lastUpdated?: number;
  nextRefresh?: number;
  loadingOlder?: boolean;
  hasMore: boolean;
}

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  density: 'comfortable' | 'compact';
  arrivalMode: 'queue' | 'automatic';
  paused: boolean;
  showMedia: boolean;
  fontSize: number;
}

export interface DeckState {
  version: 1;
  columns: ColumnConfig[];
  feeds: Record<string, Feed>;
  settings: Settings;
  bookmarks: Post[];
  connected: boolean;
  lists?: XList[];
  listsStatus?: 'idle' | 'loading' | 'ready' | 'login-required' | 'error';
  listsError?: string;
  layouts?: Layout[];
}

export interface Layout {
  id: string;
  name: string;
  columns: ColumnConfig[];
  settings: Settings;
  updatedAt: number;
}

export interface XList {
  id: string;
  name: string;
  description?: string;
  members?: string;
  image?: string;
  selectionKey?: string;
}

export type Request =
  | { type: 'GET_STATE' }
  | { type: 'SAVE_COLUMNS'; columns: ColumnConfig[] }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<Settings> }
  | { type: 'REFRESH'; columnId?: string }
  | { type: 'LOAD_OLDER'; columnId: string }
  | { type: 'MARK_READ'; columnId: string }
  | { type: 'CLEAR_COLUMN'; columnId: string }
  | { type: 'CONNECT' }
  | { type: 'LOAD_LISTS' }
  | { type: 'RESOLVE_LIST'; selectionKey: string }
  | { type: 'SAVE_LAYOUT'; id?: string; name: string }
  | { type: 'LOAD_LAYOUT'; layoutId: string }
  | { type: 'RENAME_LAYOUT'; layoutId: string; name: string }
  | { type: 'DELETE_LAYOUT'; layoutId: string }
  | { type: 'OPEN_SOURCE'; columnId: string }
  | { type: 'BOOKMARK_TOGGLE'; post: Post }
  | { type: 'IMPORT_CONFIG'; columns: ColumnConfig[]; settings: Settings };

export type Response = { ok: true; state: DeckState } | { ok: false; error: string };

export interface SourceSnapshot {
  posts: Post[];
  status: 'ready' | 'loading' | 'login-required' | 'rate-limited' | 'error' | 'empty';
  error?: string;
  hasMore: boolean;
  pageUrl: string;
  documentToken?: string;
}

export interface SourceDocumentSnapshot {
  documentToken: string;
  pageUrl: string;
  readyState: DocumentReadyState;
}

export interface ListSnapshot {
  lists: XList[];
  status: 'ready' | 'loading' | 'login-required' | 'error';
  error?: string;
  hasMore: boolean;
  pageUrl: string;
}

export interface ProfileSnapshot {
  handle?: string;
  listUrl?: string;
  status: 'ready' | 'loading' | 'login-required' | 'error';
  error?: string;
  pageUrl: string;
}

export interface ListSelectionSnapshot {
  id?: string;
  status: 'ready' | 'loading' | 'login-required' | 'error';
  error?: string;
  pageUrl: string;
}

export type SourceRequest =
  | { type: 'TDECK_DOCUMENT' }
  | { type: 'TDECK_READ'; expiresAt?: number }
  | { type: 'TDECK_SCROLL'; expiresAt?: number }
  | { type: 'TDECK_RESET' }
  | { type: 'TDECK_PROFILE' }
  | { type: 'TDECK_LISTS'; scroll?: boolean }
  | { type: 'TDECK_SELECT_LIST'; selectionKey: string };

export const STORAGE_KEY = 'tdeck-state';
export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark', density: 'comfortable', arrivalMode: 'automatic',
  paused: false, showMedia: true, fontSize: 14,
};
export const EMPTY_FEED: Feed = { posts: [], pending: [], status: 'idle', hasMore: true };
export const EMPTY_STATE: DeckState = {
  version: 1, columns: [], feeds: {}, settings: DEFAULT_SETTINGS, bookmarks: [], connected: false,
};
