import { DEFAULT_SETTINGS, EMPTY_FEED, EMPTY_STATE, type ColumnConfig, type DeckState, type Feed, type Layout, type Post, type Settings, type XList } from './types';

export const MAX_POSTS = 180;
export const MAX_COLUMNS = 12;
export const MAX_PENDING = 80;
export const MIN_REFRESH = 60;
export const MAX_LAYOUTS = 20;
export const MAX_LAYOUT_BYTES = 1_000_000;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const string = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';

export function normalizeAccount(value: string): string {
  let input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Enter an X handle, such as @NASA.');
    input = url.pathname.slice(1);
  }
  input = input.replace(/^@/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(input)) throw new Error('Enter an X handle, such as @NASA.');
  return input;
}

export function normalizeList(value: string): string {
  let input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Enter a valid X list URL.');
    input = url.pathname.match(/^\/i\/lists\/(\d{1,25})\/?$/)?.[1] ?? '';
  }
  if (!/^\d{1,25}$/.test(input)) throw new Error('Enter a list URL, such as https://x.com/i/lists/123456789.');
  return input;
}

export function validateColumns(input: unknown): ColumnConfig[] {
  if (!Array.isArray(input) || input.length > MAX_COLUMNS) throw new Error(`Use up to ${MAX_COLUMNS} columns per deck.`);
  const ids = new Set<string>();
  return input.map(value => {
    if (!object(value)) throw new Error('Invalid column.');
    const id = string(value.id, 81);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id)) throw new Error('Column IDs must be unique.');
    ids.add(id);
    if (!['search', 'account', 'list'].includes(String(value.kind))) throw new Error('Choose a search, account, or list column.');
    const kind = value.kind as ColumnConfig['kind'];
    let query = string(value.query, 501).trim();
    if (!query || query.length > 500) throw new Error('Enter a query of 1–500 characters.');
    if (kind === 'account') query = normalizeAccount(query);
    if (kind === 'list') query = normalizeList(query);
    const title = string(value.title, 80).trim() || (kind === 'account' ? `@${query}` : query.slice(0, 60));
    return {
      id, kind, query, title,
      color: typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color : '#79dfc1',
      width: bounded(value.width, 300, 640, 380),
      refreshSeconds: bounded(value.refreshSeconds, MIN_REFRESH, 1800, 120),
      paused: value.paused === true, mediaOnly: value.mediaOnly === true, hideReplies: value.hideReplies === true,
      mutedWords: Array.isArray(value.mutedWords) ? value.mutedWords.filter((v): v is string => typeof v === 'string').map(v => v.trim().slice(0, 100)).filter(Boolean).slice(0, 50) : [],
    };
  });
}

export function validateSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  if (!object(input)) throw new Error('Invalid settings.');
  return {
    theme: ['dark', 'light', 'system'].includes(String(input.theme)) ? input.theme as Settings['theme'] : base.theme,
    density: ['comfortable', 'compact'].includes(String(input.density)) ? input.density as Settings['density'] : base.density,
    arrivalMode: ['queue', 'automatic'].includes(String(input.arrivalMode)) ? input.arrivalMode as Settings['arrivalMode'] : base.arrivalMode,
    paused: typeof input.paused === 'boolean' ? input.paused : base.paused,
    showMedia: typeof input.showMedia === 'boolean' ? input.showMedia : base.showMedia,
    fontSize: bounded(input.fontSize, 12, 18, base.fontSize),
  };
}

export function sourceUrl(column: ColumnConfig, owned = false): string {
  const url = column.kind === 'list' ? new URL(`https://x.com/i/lists/${normalizeList(column.query)}`) : new URL('https://x.com/search');
  if (column.kind !== 'list') {
    url.searchParams.set('q', column.kind === 'account' ? `from:${normalizeAccount(column.query)}` : column.query);
    url.searchParams.set('src', 'typed_query');
    url.searchParams.set('f', 'live');
  }
  if (owned) url.hash = `tdeck=${column.id}`;
  return url.href;
}

export function sameSource(actual: string | undefined, expected: string, requireMarker = true): boolean {
  try {
    if (!actual) return false;
    const a = new URL(actual), b = new URL(expected);
    if (a.origin !== 'https://x.com' || b.origin !== 'https://x.com' || a.username || a.password || b.username || b.password) return false;
    if (![a, b].every(url => url.pathname === '/search' || /^\/i\/lists\/\d{1,25}$/.test(url.pathname))) return false;
    if ([a, b].some(url => url.searchParams.getAll('q').length > 1 || url.searchParams.getAll('f').length > 1)) return false;
    return a.pathname === b.pathname && a.searchParams.get('q') === b.searchParams.get('q') && a.searchParams.get('f') === b.searchParams.get('f') && (!requireMarker || (/^#tdeck=[A-Za-z0-9_-]{1,80}$/.test(b.hash) && a.hash === b.hash));
  } catch { return false; }
}

export function safeImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.username || url.password || url.port || !/^\/(?:media|profile_images|profile_banners|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname)) return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export function sanitizePost(value: unknown): Post | null {
  if (!object(value) || !/^\d{5,25}$/.test(String(value.id)) || !object(value.author) || !/^[A-Za-z0-9_]{1,15}$/.test(String(value.author.handle).replace(/^@/, ''))) return null;
  const handle = String(value.author.handle).replace(/^@/, '');
  const counts = object(value.counts) ? value.counts : {};
  const createdAt = string(value.createdAt, 40);
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  const post: Post = {
    id: String(value.id), url: `https://x.com/${handle}/status/${value.id}`,
    text: string(value.text, 12000), createdAt,
    author: { name: string(value.author.name, 160) || handle, handle, avatar: safeImage(value.author.avatar), verified: value.author.verified === true },
    counts: { replies: string(counts.replies, 20), likes: string(counts.likes, 20), reposts: string(counts.reposts, 20), views: string(counts.views, 20) },
    media: [], isReply: value.isReply === true,
  };
  if (Array.isArray(value.media)) for (const media of value.media.slice(0, 4)) {
    if (!object(media)) continue;
    const url = safeImage(media.url);
    if (url && (media.type === 'image' || media.type === 'video')) post.media.push({ type: media.type, url, alt: string(media.alt, 500) });
  }
  if (object(value.quote)) {
    post.quote = { text: string(value.quote.text, 4000), author: string(value.quote.author, 160) };
    if (/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}$/.test(String(value.quote.url))) post.quote.url = String(value.quote.url);
  }
  if (typeof value.repostedBy === 'string') post.repostedBy = value.repostedBy.slice(0, 160);
  return post;
}

export function sanitizeLists(value: unknown): XList[] {
  if (!Array.isArray(value)) return [];
  const lists = new Map<string, XList>();
  for (const raw of value.slice(0, 600)) {
    if (!object(raw) || typeof raw.id !== 'string') continue;
    const selectionKey = typeof raw.selectionKey === 'string' && raw.selectionKey.length > 0 && raw.selectionKey.length <= 512 ? raw.selectionKey : undefined;
    const resolved = /^\d{1,25}$/.test(raw.id);
    if (!resolved && (!/^pick:\d{1,4}$/.test(raw.id) || !selectionKey)) continue;
    const name = string(raw.name, 200).trim();
    if (!name) continue;
    const list: XList = { id: raw.id, name };
    if (selectionKey) list.selectionKey = selectionKey;
    const description = string(raw.description, 1000).trim(), members = string(raw.members, 100).trim();
    if (description) list.description = description;
    if (members) list.members = members;
    const image = safeImage(raw.image);
    if (image) list.image = image;
    const key = selectionKey ?? raw.id;
    const existing = lists.get(key);
    // A rediscovered clickable card must not erase an ID already resolved by
    // the browser's ordinary navigation for that same stable card identity.
    if (existing && /^\d{1,25}$/.test(existing.id) && !resolved) list.id = existing.id;
    lists.set(key, list);
  }
  return [...lists.values()].slice(0, 300).map((list, index) => /^pick:/.test(list.id) ? { ...list, id: `pick:${index}` } : list);
}

export function sanitizeLayouts(value: unknown): Layout[] {
  if (!Array.isArray(value)) return [];
  const layouts: Layout[] = [], ids = new Set<string>();
  for (const raw of value.slice(0, MAX_LAYOUTS)) {
    if (!object(raw) || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.id)
      || ['__proto__', 'constructor', 'prototype'].includes(raw.id) || ids.has(raw.id)) continue;
    const name = string(raw.name, 80).trim();
    if (!name) continue;
    try {
      const layout: Layout = {
        id: raw.id, name, columns: validateColumns(raw.columns), settings: validateSettings(raw.settings),
        updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0 ? raw.updatedAt : 0,
      };
      if (new TextEncoder().encode(JSON.stringify([...layouts, layout])).byteLength > MAX_LAYOUT_BYTES) continue;
      layouts.push(layout); ids.add(layout.id);
    } catch { /* A malformed snapshot does not discard the rest of the library. */ }
  }
  return layouts;
}

export function validateLayoutQuota(layouts: Layout[]): void {
  if (layouts.length > MAX_LAYOUTS || new TextEncoder().encode(JSON.stringify(layouts)).byteLength > MAX_LAYOUT_BYTES) {
    throw new Error('Your saved layouts have reached their local storage limit. Delete a layout or shorten its filters before saving another.');
  }
}

export function sortPosts(posts: Post[]): Post[] {
  return posts.sort((a, b) => b.id.length - a.id.length || b.id.localeCompare(a.id));
}

export function dedupePosts(posts: Post[], limit = MAX_POSTS): Post[] {
  const unique = new Map<string, Post>();
  for (const post of posts) if (!unique.has(post.id)) unique.set(post.id, post);
  return sortPosts([...unique.values()]).slice(0, limit);
}

export function mergeFeed(feed: Feed, incoming: Post[], mode: Settings['arrivalMode'], older = false): Feed {
  const existing = new Set([...feed.posts, ...feed.pending].map(p => p.id));
  const updated = new Map(incoming.map(post => [post.id, post]));
  const fresh = [...updated.values()].filter(post => !existing.has(post.id));
  const oldPosts = feed.posts.map(post => updated.get(post.id) ?? post);
  const pending = feed.pending.map(post => updated.get(post.id) ?? post);
  if (mode === 'automatic' || feed.posts.length === 0) return { ...feed, posts: dedupePosts([...fresh, ...oldPosts, ...pending]), pending: [] };
  if (older) return { ...feed, posts: dedupePosts([...fresh, ...oldPosts]), pending };
  return { ...feed, posts: oldPosts, pending: dedupePosts([...fresh, ...pending], MAX_PENDING) };
}

export function applyColumns(state: DeckState, input: unknown): DeckState {
  const columns = validateColumns(input);
  const feeds: Record<string, Feed> = {};
  for (const column of columns) {
    const prev = state.columns.find(c => c.id === column.id);
    feeds[column.id] = prev?.kind === column.kind && prev.query === column.query ? state.feeds[column.id] ?? structuredClone(EMPTY_FEED) : structuredClone(EMPTY_FEED);
  }
  return { ...state, columns, feeds };
}

export function readState(value: unknown): DeckState {
  if (!object(value) || value.version !== 1) return structuredClone(EMPTY_STATE);
  try {
    const columns = validateColumns(value.columns);
    const feeds: Record<string, Feed> = {};
    for (const column of columns) {
      const raw = object(value.feeds) && object(value.feeds[column.id]) ? value.feeds[column.id] as Record<string, unknown> : {};
      const safePosts = (v: unknown, limit: number) => Array.isArray(v) ? dedupePosts(v.map(sanitizePost).filter((p): p is Post => !!p), limit) : [];
      const status = ['idle', 'loading', 'ready', 'paused', 'login-required', 'rate-limited', 'error'].includes(String(raw.status)) ? raw.status as Feed['status'] : 'idle';
      const posts = safePosts(raw.posts, MAX_POSTS);
      const visibleIds = new Set(posts.map(post => post.id));
      feeds[column.id] = { ...EMPTY_FEED, status, posts, pending: safePosts(raw.pending, MAX_PENDING).filter(post => !visibleIds.has(post.id)), hasMore: raw.hasMore !== false,
        error: string(raw.error, 500) || undefined, lastUpdated: typeof raw.lastUpdated === 'number' && Number.isFinite(raw.lastUpdated) && raw.lastUpdated >= 0 ? raw.lastUpdated : undefined, nextRefresh: typeof raw.nextRefresh === 'number' && Number.isFinite(raw.nextRefresh) && raw.nextRefresh >= 0 ? raw.nextRefresh : undefined, loadingOlder: raw.loadingOlder === true };
    }
    return {
      version: 1, columns, feeds, connected: value.connected === true, settings: validateSettings(value.settings),
      bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks.map(sanitizePost).filter((p): p is Post => !!p).slice(0, 300) : [],
      lists: sanitizeLists(value.lists),
      listsStatus: ['idle', 'loading', 'ready', 'login-required', 'error'].includes(String(value.listsStatus)) ? value.listsStatus as DeckState['listsStatus'] : 'idle',
      listsError: string(value.listsError, 500) || undefined,
      layouts: sanitizeLayouts(value.layouts),
    };
  } catch { return structuredClone(EMPTY_STATE); }
}

export function fitStorage(state: DeckState, budget = 7_000_000): DeckState {
  if (!Number.isFinite(budget) || budget < 0) throw new Error('Storage budget must be a nonnegative finite number.');
  // UTF-8 can use up to four bytes per code point; measure the actual encoded JSON.
  const bytes = () => new TextEncoder().encode(JSON.stringify(state)).byteLength;
  while (bytes() > budget) {
    const largest = Object.values(state.feeds).sort((a, b) => b.posts.length - a.posts.length)[0];
    if (largest && largest.posts.length > 10) largest.posts.splice(-Math.min(20, largest.posts.length - 10));
    else if (Object.values(state.feeds).some(f => f.pending.length)) for (const feed of Object.values(state.feeds)) feed.pending = feed.pending.slice(0, Math.floor(feed.pending.length / 2));
    else if (state.bookmarks.length > 10) state.bookmarks.splice(-10);
    else if (largest?.posts.length) largest.posts.pop();
    else if (state.bookmarks.length) state.bookmarks.pop();
    else throw new Error('The deck settings exceed the available local storage budget.');
  }
  return state;
}
