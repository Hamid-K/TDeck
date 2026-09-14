import assert from 'node:assert/strict';
import test from 'node:test';
import { applyColumns, dedupePosts, fitStorage, MAX_COLUMNS, MAX_LAYOUT_BYTES, MAX_LAYOUTS, MAX_PENDING, MAX_POSTS, mergeFeed, MIN_REFRESH, normalizeAccount, normalizeList, readState, safeImage, sameSource, sanitizeLayouts, sanitizePost, sortPosts, sourceUrl, validateColumns, validateLayoutQuota, validateSettings } from '../src/shared/core';
import { DEFAULT_SETTINGS, EMPTY_FEED, EMPTY_STATE, type ColumnConfig, type DeckState, type Feed, type Layout, type Post } from '../src/shared/types';

function column(patch: Partial<ColumnConfig> = {}): ColumnConfig {
  return { id: 'column-1', kind: 'search', query: 'typescript OR javascript', title: 'Web', color: '#79dfc1', width: 380, refreshSeconds: 120, paused: false, mediaOnly: false, hideReplies: false, mutedWords: [], ...patch };
}

function post(id = '1900000000000000001', patch: Partial<Post> = {}): Post {
  return { id, url: `https://x.com/alice/status/${id}`, text: `Post ${id}`, author: { name: 'Alice', handle: 'alice', verified: false }, createdAt: '2026-09-14T12:00:00.000Z', media: [], counts: { replies: '0', likes: '1', reposts: '0' }, isReply: false, ...patch };
}

function feed(posts: Post[] = [], pending: Post[] = []): Feed {
  return { ...structuredClone(EMPTY_FEED), status: 'ready', posts, pending, lastUpdated: 100, hasMore: true };
}

function state(posts: Post[] = []): DeckState {
  return { ...structuredClone(EMPTY_STATE), columns: [column()], feeds: { 'column-1': feed(posts) } };
}

function layout(id = 'layout-1', patch: Partial<Layout> = {}): Layout {
  return { id, name: 'Research', columns: [column()], settings: structuredClone(DEFAULT_SETTINGS), updatedAt: 1_800_000_000_000, ...patch };
}

const ids = (posts: Post[]): string[] => posts.map(item => item.id);
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('column validation normalizes sources and bounds appearance and refresh settings', () => {
  const [account, list] = validateColumns([
    column({ id: 'account', kind: 'account', query: ' https://x.com/NASA?s=20 ', title: '', width: 900, refreshSeconds: 5, color: 'url(javascript:bad)', mutedWords: ['  spam  ', '', 'a'.repeat(200)] }),
    column({ id: 'list', kind: 'list', query: 'https://x.com/i/lists/123456789?lang=en#section', width: -1, refreshSeconds: Infinity }),
  ]);
  assert.equal(account.query, 'NASA');
  assert.equal(account.title, '@NASA');
  assert.equal(account.width, 640);
  assert.equal(account.refreshSeconds, MIN_REFRESH);
  assert.equal(account.color, '#79dfc1');
  assert.deepEqual(account.mutedWords, ['spam', 'a'.repeat(100)]);
  assert.equal(list.query, '123456789');
  assert.equal(list.width, 300);
  assert.equal(list.refreshSeconds, 120);
});

test('column validation rejects duplicate, truncated or object-prototype identities and invalid source inputs', () => {
  for (const input of [null, {}, Array.from({ length: MAX_COLUMNS + 1 }, (_, index) => column({ id: String(index) })), [column(), column()], [column({ id: '__proto__' })], [column({ id: 'constructor' })], [column({ id: 'prototype' })], [column({ id: 'a'.repeat(81) })], [column({ query: ' ' })], [column({ query: 'a'.repeat(501) })], [column({ kind: 'invalid' as 'search' })]]) {
    assert.throws(() => validateColumns(input));
  }
  assert.deepEqual(validateColumns([]), []);
});

test('account and list normalization accepts copied X URLs and rejects other destinations', () => {
  assert.equal(normalizeAccount('@NASA'), 'NASA');
  assert.equal(normalizeAccount('https://www.twitter.com/NASA/?s=20'), 'NASA');
  assert.equal(normalizeList('123456789'), '123456789');
  assert.equal(normalizeList('https://www.twitter.com/i/lists/123456789/'), '123456789');
  for (const value of ['https://evil.example/NASA', 'https://x.com.evil.example/NASA', 'https://u:p@x.com/NASA', 'https://x.com:8443/NASA', 'http://x.com/NASA', 'NASA/status/123', '@two words', 'abcdefghijklmnop']) assert.throws(() => normalizeAccount(value), value);
  for (const value of ['https://evil.example/i/lists/123', 'https://x.com:8443/i/lists/123', 'https://u:p@x.com/i/lists/123', 'http://x.com/i/lists/123', '123/anything', 'https://x.com/i/lists/123/members', '-1', '1e10']) assert.throws(() => normalizeList(value), value);
});

test('settings validate partial patches and ignore invalid enums and boolean coercions', () => {
  const base = { ...DEFAULT_SETTINGS, theme: 'light' as const, showMedia: false, fontSize: 16 };
  assert.deepEqual(validateSettings({ density: 'compact', fontSize: 999, theme: 'unknown', showMedia: 'true', paused: true }, base), { ...base, density: 'compact', fontSize: 18, paused: true });
  assert.equal(validateSettings({ fontSize: NaN }, base).fontSize, 16);
  assert.throws(() => validateSettings(null));
});

test('source URLs encode keyword syntax and give accounts a latest-search feed', () => {
  const search = new URL(sourceUrl(column({ query: '"browser extension" #javascript -filter:replies' }), true));
  assert.equal(search.origin, 'https://x.com');
  assert.equal(search.pathname, '/search');
  assert.equal(search.searchParams.get('q'), '"browser extension" #javascript -filter:replies');
  assert.equal(search.searchParams.get('f'), 'live');
  assert.equal(search.hash, '#tdeck=column-1');
  assert.equal(new URL(sourceUrl(column({ kind: 'account', query: '@NASA' }))).searchParams.get('q'), 'from:NASA');
  assert.equal(sourceUrl(column({ kind: 'list', query: '123456789' }), true), 'https://x.com/i/lists/123456789#tdeck=column-1');
});

test('source ownership requires an explicit matching marker, query, live mode and trusted origin', () => {
  const expected = sourceUrl(column(), true);
  assert.equal(sameSource(expected.replace('src=typed_query', 'src=recent_search_click'), expected), true);
  assert.equal(sameSource(sourceUrl(column()), expected), false);
  assert.equal(sameSource(sourceUrl(column()), expected, false), true);
  assert.equal(sameSource(sourceUrl(column()), sourceUrl(column())), false);
  for (const actual of [undefined, 'not a URL', expected.replace('x.com', 'evil.example'), expected.replace('https:', 'http:'), expected.replace('x.com', 'user:pass@x.com'), expected.replace('column-1', 'column-2'), expected.replace('f=live', 'f=top'), expected.replace('typescript', 'python'), expected.replace('#tdeck=', '&q=another#tdeck='), expected.replace('#tdeck=', '&f=top#tdeck=')]) assert.equal(sameSource(actual, expected), false, actual);
  assert.equal(sameSource('https://x.com/search?q=hi&f=live#tdeck=x', 'https://evil.example/search?q=hi&f=live#tdeck=x'), false);
  assert.equal(sameSource('https://x.com/settings#tdeck=x', 'https://x.com/settings#tdeck=x'), false);
  const list = sourceUrl(column({ kind: 'list', query: '123456789' }), true);
  assert.equal(sameSource(list, list), true);
  assert.equal(sameSource(list.replace('123456789', '123456780'), list), false);
});

test('post sanitization rebuilds destinations, rejects broken identity/date values and bounds copied data', () => {
  const safe = sanitizePost({ ...post(), url: 'javascript:alert(1)', text: 'x'.repeat(13_000), author: { handle: '@alice', name: 'Alice', avatar: 'https://evil.example/track', verified: 'true' }, counts: { likes: '9'.repeat(40), replies: 2 }, quote: { author: 'Bob', text: 'q'.repeat(5_000), url: 'javascript:alert(1)' }, media: [{ type: 'image', url: 'https://pbs.twimg.com/media/ok.jpg', alt: 'a'.repeat(600) }, { type: 'script', url: 'https://pbs.twimg.com/media/ignored.jpg' }, { type: 'image', url: 'https://evil.example/track.jpg' }] });
  assert.ok(safe);
  assert.equal(safe.url, 'https://x.com/alice/status/1900000000000000001');
  assert.equal(safe.text.length, 12_000);
  assert.equal(safe.author.handle, 'alice');
  assert.equal(safe.author.avatar, undefined);
  assert.equal(safe.author.verified, false);
  assert.equal(safe.counts.likes.length, 20);
  assert.equal(safe.quote?.text.length, 4_000);
  assert.equal(safe.quote?.url, undefined);
  assert.equal(safe.media.length, 1);
  assert.equal(safe.media[0].alt?.length, 500);
  for (const value of [null, {}, post('bad'), post('1234'), post('12345678901234567890123456'), post('12345', { createdAt: 'invalid' }), { ...post(), author: { handle: 'alice/../../settings' } }]) assert.equal(sanitizePost(value), null);
});

test('only approved HTTPS image paths are retained, including video thumbnails', () => {
  assert.equal(safeImage('https://pbs.twimg.com/media/photo?name=small#discard'), 'https://pbs.twimg.com/media/photo?name=small');
  assert.equal(safeImage('https://pbs.twimg.com/amplify_video_thumb/123/photo.jpg'), 'https://pbs.twimg.com/amplify_video_thumb/123/photo.jpg');
  for (const value of [undefined, {}, 'http://pbs.twimg.com/media/x', 'https://pbs.twimg.com.evil.example/media/x', 'https://u:p@pbs.twimg.com/media/x', 'https://pbs.twimg.com:8443/media/x', 'https://pbs.twimg.com/unknown', 'blob:https://x.com/id', 'data:image/svg+xml,<svg/>']) assert.equal(safeImage(value), undefined);
});

test('snowflake sorting is exact above Number precision and deduplication preserves its first authoritative object', () => {
  const ordered = sortPosts([post('1900000000000000001'), post('99999'), post('1900000000000000002'), post('100000')]);
  assert.deepEqual(ids(ordered), ['1900000000000000002', '1900000000000000001', '100000', '99999']);
  const authoritative = post('12345', { text: 'latest counts' });
  assert.deepEqual(dedupePosts([authoritative, post('12345'), post('12346')], 1), [post('12346')]);
  assert.equal(dedupePosts([authoritative, post('12345')])[0], authoritative);
});

test('automatic arrivals update existing counts, deduplicate incoming IDs and insert latest posts first', () => {
  const previous = feed([post('10003'), post('10001')], [post('10004')]);
  const updated = post('10003', { counts: { likes: '9', replies: '3', reposts: '2' } });
  const result = mergeFeed(previous, [post('10005', { text: 'earlier observation' }), updated, post('10002'), post('10005', { text: 'latest observation' })], 'automatic');
  assert.deepEqual(ids(result.posts), ['10005', '10004', '10003', '10002', '10001']);
  assert.equal(result.posts[0].text, 'latest observation');
  assert.equal(result.posts[2].counts.likes, '9');
  assert.deepEqual(result.pending, []);
  assert.equal(result.lastUpdated, 100);
  assert.deepEqual(ids(previous.posts), ['10003', '10001']);
  assert.equal(previous.posts[0].counts.likes, '1');
});

test('queued arrivals keep visible positions, refresh both queues and initialize an empty feed immediately', () => {
  const previous = feed([post('10003'), post('10001')], [post('10004')]);
  const result = mergeFeed(previous, [post('10005'), post('10003', { text: 'updated visible' }), post('10004', { text: 'updated pending' })], 'queue');
  assert.deepEqual(ids(result.posts), ['10003', '10001']);
  assert.equal(result.posts[0].text, 'updated visible');
  assert.deepEqual(ids(result.pending), ['10005', '10004']);
  assert.equal(result.pending[1].text, 'updated pending');
  const initial = mergeFeed(feed([], [post('10002')]), [post('10001')], 'queue');
  assert.deepEqual(ids(initial.posts), ['10002', '10001']);
  assert.deepEqual(initial.pending, []);
});

test('loading older posts preserves queued arrivals while refreshing known post data', () => {
  const result = mergeFeed(feed([post('10003'), post('10002')], [post('10004')]), [post('10002', { text: 'updated older' }), post('10001'), post('10004', { text: 'updated queued' })], 'queue', true);
  assert.deepEqual(ids(result.posts), ['10003', '10002', '10001']);
  assert.equal(result.posts[1].text, 'updated older');
  assert.deepEqual(ids(result.pending), ['10004']);
  assert.equal(result.pending[0].text, 'updated queued');
});

test('feed and arrival queues retain bounded newest histories', () => {
  const incoming = Array.from({ length: MAX_POSTS + 30 }, (_, index) => post(String(10000 + index)));
  const automatic = mergeFeed(feed(), incoming, 'automatic');
  assert.equal(automatic.posts.length, MAX_POSTS);
  assert.equal(automatic.posts[0].id, String(10000 + incoming.length - 1));
  const queued = mergeFeed(feed([post('99999')]), incoming, 'queue');
  assert.equal(queued.pending.length, MAX_PENDING);
  assert.deepEqual(ids(queued.posts), ['99999']);
});

test('column edits preserve the feed for presentation changes and clear it for a new source', () => {
  const initial = state([post()]);
  assert.equal(applyColumns(initial, [column({ title: 'Renamed', width: 450 })]).feeds['column-1'], initial.feeds['column-1']);
  assert.deepEqual(applyColumns(initial, [column({ query: 'different query' })]).feeds['column-1'], EMPTY_FEED);
  assert.deepEqual(applyColumns(initial, []).feeds, {});
  const added = applyColumns(initial, [column(), column({ id: 'new', query: 'news' })]);
  added.feeds.new.posts.push(post('12345'));
  assert.equal(EMPTY_FEED.posts.length, 0);
});

test('persisted state sanitizes posts, pending duplicates, malformed timestamps and unknown feeds', () => {
  const persisted = state([post(), post(), post('bad')]);
  persisted.feeds['column-1'].pending = [post(), post('1900000000000000002')];
  persisted.feeds['column-1'].lastUpdated = NaN;
  persisted.feeds['column-1'].nextRefresh = Infinity;
  persisted.feeds.unlisted = feed([post('12345')]);
  const restored = readState(persisted);
  assert.equal(restored.feeds['column-1'].posts.length, 1);
  assert.deepEqual(ids(restored.feeds['column-1'].pending), ['1900000000000000002']);
  assert.equal(restored.feeds['column-1'].lastUpdated, undefined);
  assert.equal(restored.feeds['column-1'].nextRefresh, undefined);
  assert.equal(restored.feeds.unlisted, undefined);
  assert.deepEqual(readState({ version: 999 }), EMPTY_STATE);
  const invalid = readState({ version: 1, columns: [{ id: '__proto__' }] });
  invalid.columns.push(column());
  assert.equal(EMPTY_STATE.columns.length, 0);
});

test('storage fitting measures Unicode bytes, keeps newest posts and can trim below ten to honor the budget', () => {
  const initial = state(Array.from({ length: 12 }, (_, index) => post(String(10020 - index), { text: '🧵'.repeat(1_000) })));
  initial.feeds['column-1'].pending = [post('10030', { text: 'p'.repeat(3_000) })];
  initial.bookmarks = [post('10040', { text: 'b'.repeat(3_000) })];
  const originalBytes = bytes(initial);
  const fitted = fitStorage(initial, 12_000);
  assert.ok(bytes(fitted) <= 12_000);
  assert.ok(bytes(fitted) < originalBytes);
  assert.ok(fitted.feeds['column-1'].posts.length < 10);
  assert.equal(fitted.feeds['column-1'].posts[0]?.id, '10020');
  assert.equal(fitted.columns[0].query, 'typescript OR javascript');
  assert.throws(() => fitStorage(state(), 1), /settings exceed/);
  assert.throws(() => fitStorage(state(), NaN), /budget/);
});

test('named layouts contain configuration only and strip cached feeds, bookmarks, session data and extra fields', () => {
  const supplied = {
    ...layout(), feeds: { 'column-1': feed([post()]) }, bookmarks: [post()], connected: true,
    session: { account: 'not-layout-data' }, lists: [{ id: '12345', name: 'Not part of this layout' }], unexpected: 'discard',
    columns: [{ ...column(), posts: [post()], tabId: 42 }],
    settings: { ...DEFAULT_SETTINGS, sessionToken: 'not-layout-data', arbitrary: true },
  };
  const [saved] = sanitizeLayouts([supplied]);
  assert.deepEqual(saved, layout());
  assert.deepEqual(Object.keys(saved).sort(), ['columns', 'id', 'name', 'settings', 'updatedAt']);
  assert.equal('posts' in saved.columns[0], false);
  assert.equal('tabId' in saved.columns[0], false);
  assert.equal('sessionToken' in saved.settings, false);
  assert.doesNotMatch(JSON.stringify(saved), /not-layout-data|A cached post|unexpected/);
});

test('malformed named layouts are isolated without poisoning later valid entries or duplicate identity', () => {
  const library = sanitizeLayouts([
    null, [], layout('bad-columns', { columns: [column({ query: '' })] }),
    layout('bad-settings', { settings: null as unknown as Layout['settings'] }),
    layout('__proto__'), layout('constructor'), layout('blank', { name: ' ' }),
    layout('retry', { columns: [column({ id: '__proto__' })] }),
    layout('valid', { name: 'First valid' }), layout('valid', { name: 'Duplicate must not replace it' }),
    layout('retry', { name: 'Valid after malformed same ID' }),
  ]);
  assert.deepEqual(library.map(({ id, name }) => ({ id, name })), [{ id: 'valid', name: 'First valid' }, { id: 'retry', name: 'Valid after malformed same ID' }]);
  assert.deepEqual(sanitizeLayouts({ layouts: [layout()] }), []);
});

test('named layouts validate source configuration and bound settings and display metadata', () => {
  const [saved] = sanitizeLayouts([layout('bounded', {
    name: `  ${'n'.repeat(100)}`, updatedAt: NaN,
    columns: [column({ kind: 'account', query: 'https://x.com/NASA?s=20', width: 1_000, refreshSeconds: 1, title: '' })],
    settings: { ...DEFAULT_SETTINGS, fontSize: 1_000, theme: 'unknown' as Layout['settings']['theme'] },
  })]);
  assert.ok(saved.name.length > 0 && saved.name.length <= 80);
  assert.equal(saved.name, saved.name.trim());
  assert.equal(saved.updatedAt, 0);
  assert.equal(saved.columns[0].query, 'NASA');
  assert.equal(saved.columns[0].title, '@NASA');
  assert.equal(saved.columns[0].width, 640);
  assert.equal(saved.columns[0].refreshSeconds, MIN_REFRESH);
  assert.equal(saved.settings.fontSize, 18);
  assert.equal(saved.settings.theme, DEFAULT_SETTINGS.theme);
  assert.equal(sanitizeLayouts([layout('negative', { updatedAt: -1 })])[0].updatedAt, 0);
});

test('named-layout library enforces its twenty-layout cap when restoring and saving', () => {
  assert.equal(MAX_LAYOUTS, 20);
  const supplied = Array.from({ length: MAX_LAYOUTS + 1 }, (_, index) => layout(`layout-${index}`));
  const saved = sanitizeLayouts(supplied);
  assert.equal(saved.length, MAX_LAYOUTS);
  assert.equal(saved.at(-1)?.id, 'layout-19');
  assert.doesNotThrow(() => validateLayoutQuota(saved));
  assert.throws(() => validateLayoutQuota(supplied), /storage limit/);
});

test('named-layout byte quota measures UTF-8 and rejects an oversized library even when character count fits', () => {
  assert.equal(MAX_LAYOUT_BYTES, 1_000_000);
  const denseColumns = Array.from({ length: MAX_COLUMNS }, (_, index) => column({ id: `dense-${index}`, query: '🧵'.repeat(250), mutedWords: Array.from({ length: 50 }, () => '🧵'.repeat(50)) }));
  const supplied: Layout[] = [];
  while (bytes(supplied) <= MAX_LAYOUT_BYTES && supplied.length < MAX_LAYOUTS) supplied.push(layout(`dense-layout-${supplied.length}`, { columns: denseColumns }));
  assert.ok(bytes(supplied) > MAX_LAYOUT_BYTES);
  assert.ok(JSON.stringify(supplied).length < MAX_LAYOUT_BYTES, 'The UTF-16 character count alone would incorrectly allow this library');
  assert.throws(() => validateLayoutQuota(supplied), /storage limit/);
  const saved = sanitizeLayouts(supplied);
  assert.ok(saved.length > 0 && saved.length < supplied.length);
  assert.ok(bytes(saved) <= MAX_LAYOUT_BYTES);
  assert.doesNotThrow(() => validateLayoutQuota(saved));
});

test('state restoration retains the validated layout library independently of active feeds', () => {
  const initial = state([post()]);
  initial.layouts = [layout('work'), layout('personal', { name: 'Personal', columns: [column({ id: 'personal-feed', query: 'gardening' })] })];
  const restored = readState({ ...initial, layouts: [...initial.layouts, { id: 'broken', name: 'Broken', columns: null }] });
  assert.deepEqual(restored.layouts, initial.layouts);
  assert.equal(restored.feeds['column-1'].posts.length, 1);
  restored.layouts![0].columns[0].query = 'Changed restored layout';
  assert.equal(initial.layouts[0].columns[0].query, 'typescript OR javascript');
});
