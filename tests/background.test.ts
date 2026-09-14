import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { MAX_LAYOUTS, MAX_LAYOUT_BYTES, readState, sanitizeLayouts, sanitizeLists, sourceUrl, validateColumns } from '../src/shared/core';
import { extractListsSnapshot, extractProfileSnapshot } from '../src/source/parser';
import { DEFAULT_SETTINGS, EMPTY_FEED, STORAGE_KEY, type ColumnConfig, type DeckState, type Post, type Request, type Response, type SourceSnapshot } from '../src/shared/types';

type Listener = (...args: any[]) => unknown;
type Message = { type: string; scroll?: boolean; selectionKey?: string; expiresAt?: number };
function event() {
  const listeners = new Set<Listener>();
  return {
    addListener(listener: Listener) { listeners.add(listener); },
    removeListener(listener: Listener) { listeners.delete(listener); },
    emit(...args: any[]) { return [...listeners].map(listener => listener(...args)); },
  };
}
const NOW = 1_800_000_000_000;
const RUNTIME_KEY = 'tdeck-runtime';
const EXTENSION = 'chrome-extension://tdeck-test/';
let instance = 0;

function column(id: string): ColumnConfig {
  return validateColumns([{ id, kind: 'search', query: id, title: id }])[0];
}
function post(id = '1800000000000000001'): Post {
  return {
    id, url: `https://x.com/alice/status/${id}`, text: 'A cached post.',
    author: { name: 'Alice', handle: 'alice', verified: false },
    createdAt: '2026-09-14T08:00:00.000Z', media: [],
    counts: { replies: '', reposts: '', likes: '' }, isReply: false,
  };
}
function snapshot(config: ColumnConfig, posts = [post()]): SourceSnapshot {
  return { pageUrl: sourceUrl(config, true), posts, hasMore: false, status: 'ready' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  for (let turn = 0; turn < 12; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function background(options: {
  columns?: ColumnConfig[];
  runtime?: unknown;
  tabs?: chrome.tabs.Tab[];
  read?: (tabId: number, message: Message) => unknown | Promise<unknown>;
  creating?: (tab: chrome.tabs.Tab) => Promise<void>;
  updating?: (tabId: number, properties: object) => void;
  reloading?: (tabId: number) => Promise<void>;
  groupUpdating?: (groupId: number, properties: chrome.tabGroups.UpdateProperties) => void;
  windows?: chrome.windows.Window[];
  windowCreating?: (window: chrome.windows.Window) => Promise<void>;
} = {}) {
  const columns = options.columns ?? [column('alpha')];
  const state: DeckState = {
    version: 1, connected: true, columns, settings: structuredClone(DEFAULT_SETTINGS), bookmarks: [],
    feeds: Object.fromEntries(columns.map(config => [config.id, { ...structuredClone(EMPTY_FEED), posts: [post()], nextRefresh: NOW + 60_000 }])),
  };
  const stored: Record<string, unknown> = {
    [STORAGE_KEY]: state,
    [RUNTIME_KEY]: options.runtime ?? { sources: {}, nextNavigation: 0, cooldownUntil: 0 },
  };
  const tabs = new Map((options.tabs ?? []).map(tab => [tab.id!, structuredClone(tab)]));
  const windows = new Map((options.windows ?? [{ id: 1, focused: true, state: 'normal', type: 'normal', alwaysOnTop: false, incognito: false } as chrome.windows.Window]).map(window => [window.id!, structuredClone(window)]));
  const messages: (Message & { tabId: number })[] = [];
  const created: chrome.tabs.Tab[] = [];
  const removed: number[] = [];
  const reloaded: number[] = [];
  const groupUpdates: { groupId: number; properties: chrome.tabGroups.UpdateProperties }[] = [];
  const windowCreates: chrome.windows.CreateData[] = [], windowUpdates: { id: number; properties: chrome.windows.UpdateInfo }[] = [];
  const moved: { tabId: number; windowId: number }[] = [];
  const documentTokens = new Map<number, string>();
  const runtimeMessage = event(), onRemoved = event(), onAlarm = event(), onUpdated = event();
  const alarms = new Map<string, unknown>();
  let nextTabId = 100;
  let nextWindowId = 1_000;
  const previousChrome = globalThis.chrome;
  const previousNow = Date.now;
  Date.now = () => NOW;
  const fake = {
    storage: { local: {
      async get(keys: string | string[]) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(stored[key])])); },
      async set(values: Record<string, unknown>) { Object.assign(stored, structuredClone(values)); },
      async setAccessLevel() {},
    } },
    runtime: { id: 'tdeck-test', getURL: (path: string) => EXTENSION + path, onMessage: runtimeMessage, onInstalled: event(), onStartup: event() },
    alarms: {
      async get(name: string) { return alarms.get(name); },
      async create(name: string, info: unknown) { alarms.set(name, info); },
      async clear(name: string) { return alarms.delete(name); },
      onAlarm,
    },
    tabs: {
      async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error('No tab.'); return structuredClone(tab); },
      async query(query: { url?: string; windowId?: number }) { return [...tabs.values()].filter(tab => (!query.url || tab.url === query.url) && (query.windowId === undefined || tab.windowId === query.windowId)).map(tab => structuredClone(tab)); },
      async create(properties: { url: string; active?: boolean }) {
        const tab: chrome.tabs.Tab = { id: nextTabId++, url: properties.url, active: properties.active ?? true, status: 'complete', windowId: 1, index: 0, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, groupId: -1 };
        tabs.set(tab.id!, tab); created.push(structuredClone(tab));
        await options.creating?.(tab);
        return structuredClone(tab);
      },
      async update(id: number, properties: chrome.tabs.UpdateProperties) {
        const tab = tabs.get(id); if (!tab) throw new Error('No tab.');
        options.updating?.(id, properties);
        if (properties.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) { other.active = false; Object.assign(other, { frozen: false }); }
        Object.assign(tab, properties); return structuredClone(tab);
      },
      async move(id: number, properties: { windowId: number; index: number }) {
        const tab = tabs.get(id); if (!tab || !windows.has(properties.windowId)) throw new Error('No tab or window.');
        moved.push({ tabId: id, windowId: properties.windowId });
        Object.assign(tab, { windowId: properties.windowId, index: properties.index, active: false, groupId: -1, frozen: false });
        return structuredClone(tab);
      },
      async reload(id: number) {
        if (!tabs.has(id)) throw new Error('No tab.');
        reloaded.push(id);
        if (options.reloading) await options.reloading(id);
        else {
          tabs.get(id)!.status = 'loading';
          onUpdated.emit(id, { status: 'loading' });
          queueMicrotask(() => {
            const documentToken = `document-${id}-${reloaded.length}`;
            documentTokens.set(id, documentToken);
            tabs.get(id)!.status = 'complete';
            runtimeMessage.emit({ type: 'TDECK_DOCUMENT_READY', documentToken }, { id: 'tdeck-test', url: tabs.get(id)!.url, tab: tabs.get(id), frameId: 0, documentId: documentToken }, () => {});
            onUpdated.emit(id, { status: 'complete' });
          });
        }
      },
      async remove(id: number) { removed.push(id); tabs.delete(id); onRemoved.emit(id, { windowId: 1, isWindowClosing: false }); },
      async group(properties: { tabIds: number | number[]; groupId?: number }) {
        const groupId = properties.groupId ?? 7;
        for (const id of Array.isArray(properties.tabIds) ? properties.tabIds : [properties.tabIds]) if (tabs.has(id)) tabs.get(id)!.groupId = groupId;
        return groupId;
      },
      async sendMessage(tabId: number, message: Message) {
        const documentToken = documentTokens.get(tabId) ?? `document-${tabId}-initial`;
        // Document handshakes are transport metadata; messages records feed
        // and list operations separately from this instantaneous exchange.
        if (message.type === 'TDECK_DOCUMENT') return { documentToken, pageUrl: tabs.get(tabId)?.url, readyState: 'complete' };
        messages.push({ tabId, ...message });
        const result = await (options.read ? options.read(tabId, message) : snapshot(columns.find(config => sourceUrl(config, true) === tabs.get(tabId)?.url) ?? columns[0]));
        return result && typeof result === 'object' && 'posts' in result ? { documentToken, ...result } : result;
      },
      onRemoved, onUpdated,
    },
    tabGroups: { async update(groupId: number, properties: chrome.tabGroups.UpdateProperties) { groupUpdates.push({ groupId, properties }); options.groupUpdating?.(groupId, properties); } },
    windows: {
      async get(id: number, options?: { populate?: boolean }) {
        const window = windows.get(id); if (!window) throw new Error('No window.');
        return { ...structuredClone(window), ...(options?.populate ? { tabs: [...tabs.values()].filter(tab => tab.windowId === id).map(tab => structuredClone(tab)) } : {}) };
      },
      async create(properties: chrome.windows.CreateData) {
        const tab = tabs.get(properties.tabId!); if (!tab) throw new Error('No source tab.');
        const window: chrome.windows.Window = { id: nextWindowId++, focused: properties.focused ?? true, state: properties.state ?? 'normal', type: properties.type ?? 'normal', alwaysOnTop: false, incognito: false };
        windows.set(window.id!, window); windowCreates.push(structuredClone(properties));
        Object.assign(tab, { windowId: window.id, active: true, groupId: -1, frozen: false });
        await options.windowCreating?.(window);
        return structuredClone(window);
      },
      async update(id: number, properties: chrome.windows.UpdateInfo) { const window = windows.get(id); if (!window) throw new Error('No window.'); windowUpdates.push({ id, properties }); Object.assign(window, properties); return structuredClone(window); },
    },
    action: { onClicked: event() },
    commands: { onCommand: event() },
  };
  globalThis.chrome = fake as unknown as typeof chrome;
  await import(`../src/background.ts?background-test=${++instance}`);
  return {
    stored, tabs, windows, messages, created, removed, reloaded, documentTokens, onRemoved, onUpdated, onAlarm, alarms, groupUpdates, windowCreates, windowUpdates, moved,
    get state() { return structuredClone(stored[STORAGE_KEY]) as DeckState; },
    async request(request: Request): Promise<Response> {
      return new Promise<Response>((resolve, reject) => {
        const accepted = runtimeMessage.emit(request, { id: 'tdeck-test', url: EXTENSION + 'index.html' }, resolve);
        if (!accepted.includes(true)) reject(new Error('Request listener did not accept the extension page.'));
      });
    },
    rawMessage(request: Request, sender: object) { return runtimeMessage.emit(request, sender, () => { throw new Error('An untrusted sender received a response.'); }); },
    documentReady(tabId: number, documentToken: string) {
      documentTokens.set(tabId, documentToken);
      runtimeMessage.emit({ type: 'TDECK_DOCUMENT_READY', documentToken }, { id: 'tdeck-test', url: tabs.get(tabId)?.url, tab: tabs.get(tabId), frameId: 0, documentId: documentToken }, () => {});
    },
    async close() { await flush(); Date.now = previousNow; globalThis.chrome = previousChrome; },
  };
}

function owned(config: ColumnConfig, tabId = 10) {
  return {
    runtime: { sources: { [config.id]: { tabId, expectedUrl: sourceUrl(config, true), failures: 0 } }, nextNavigation: 0, cooldownUntil: 0 },
    tab: { id: tabId, url: sourceUrl(config, true), active: false, status: 'complete', windowId: 1 } as chrome.tabs.Tab,
  };
}

test('background accepts only its own extension-page requests', async () => {
  const app = await background();
  try {
    assert.deepEqual(app.rawMessage({ type: 'CONNECT' }, { id: 'tdeck-test', url: 'https://x.com/search' }), [false]);
    assert.deepEqual(app.rawMessage({ type: 'CONNECT' }, { id: 'other-extension', url: EXTENSION + 'index.html' }), [false]);
    assert.deepEqual(app.rawMessage({ type: 'CONNECT' }, { id: 'tdeck-test', url: 'https://attacker.example/' }), [false]);
    assert.equal((await app.request({ type: 'GET_STATE' })).ok, true);
    assert.equal(app.created.length, 0);
  } finally { await app.close(); }
});

test('a requested refresh takes priority over overdue automatic columns', async () => {
  const alpha = column('alpha'), beta = column('beta');
  const app = await background({ columns: [alpha, beta] });
  try {
    (app.stored[STORAGE_KEY] as DeckState).feeds.alpha.nextRefresh = 0;
    assert.equal((await app.request({ type: 'REFRESH', columnId: beta.id })).ok, true);
    await flush();
    assert.equal(app.created[0]?.url, sourceUrl(beta, true));
  } finally { await app.close(); }
});

test('loading older posts on an existing source does not wait for navigation cooldown', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  source.runtime.nextNavigation = NOW + 15_000;
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab] });
  try {
    assert.equal((await app.request({ type: 'LOAD_OLDER', columnId: alpha.id })).ok, true);
    await flush();
    assert.ok(app.messages.length > 0, 'existing-source pagination should start immediately');
    assert.equal(app.created.length, 0);
    assert.equal(app.reloaded.length, 0);
  } finally { await app.close(); }
});

test('closing a source while its read is pending cannot later overwrite the closed state', async () => {
  const alpha = column('alpha'), source = owned(alpha), result = deferred<SourceSnapshot>();
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: () => result.promise });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.messages.length, 1);
    app.tabs.delete(source.tab.id!);
    app.onRemoved.emit(source.tab.id, { windowId: 1, isWindowClosing: false });
    await flush();
    result.resolve(snapshot(alpha));
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'error');
    assert.match(app.state.feeds.alpha.error ?? '', /closed/i);
    assert.equal(app.state.feeds.alpha.nextRefresh, undefined);
  } finally { result.resolve(snapshot(alpha)); await app.close(); }
});

test('retiring a column never removes a tab navigating away from its owned source', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  source.tab.pendingUrl = 'https://example.com/user-navigation';
  source.tab.status = 'loading';
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab] });
  try {
    assert.equal((await app.request({ type: 'SAVE_COLUMNS', columns: [] })).ok, true);
    await flush();
    assert.deepEqual(app.removed, []);
    assert.equal(app.tabs.has(source.tab.id!), true);
  } finally { await app.close(); }
});

test('an automatic refresh does not reload a source the user is actively inspecting', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  source.tab.active = true;
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab] });
  try {
    (app.stored[STORAGE_KEY] as DeckState).feeds.alpha.nextRefresh = 0;
    app.onAlarm.emit({ name: 'tdeck-refresh' });
    await flush();
    assert.deepEqual(app.reloaded, []);
    assert.equal(app.messages.some(message => message.type === 'TDECK_SCROLL'), false);
  } finally { await app.close(); }
});

test('malformed persisted runtime is recovered without discarding the saved deck', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], runtime: { sources: null } });
  try {
    const response = await app.request({ type: 'REFRESH', columnId: alpha.id });
    assert.equal(response.ok, true);
    await flush();
    assert.equal(app.state.columns[0].id, alpha.id);
    assert.equal(app.state.feeds.alpha.status, 'ready');
  } finally { await app.close(); }
});

test('an unknown source status is surfaced as an error instead of persisted as a feed status', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], read: () => ({ ...snapshot(alpha), status: 'unexpected' }) });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'error');
    assert.ok(app.state.feeds.alpha.error);
    assert.equal(app.state.feeds.alpha.posts.length, 1, 'cached posts remain readable');
  } finally { await app.close(); }
});

test('pausing during a source failure preserves the paused presentation', async () => {
  const alpha = column('alpha'), source = owned(alpha), result = deferred<SourceSnapshot>();
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: () => result.promise });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    await app.request({ type: 'UPDATE_SETTINGS', patch: { paused: true } });
    result.resolve({ ...snapshot(alpha), status: 'error', error: 'The source failed.' });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'paused');
    assert.equal(app.state.feeds.alpha.loadingOlder, false);
  } finally { result.resolve(snapshot(alpha)); await app.close(); }
});

test('a stale in-flight result does not repopulate a manually cleared column', async () => {
  const alpha = column('alpha'), source = owned(alpha), result = deferred<SourceSnapshot>();
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: () => result.promise });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    await app.request({ type: 'CLEAR_COLUMN', columnId: alpha.id });
    result.resolve(snapshot(alpha));
    await flush();
    assert.deepEqual(app.state.feeds.alpha.posts, []);
  } finally { result.resolve(snapshot(alpha)); await app.close(); }
});

test('deleting a column during tabs.create cleans up the unclaimed source', async () => {
  const alpha = column('alpha'), created = deferred<void>();
  const app = await background({ columns: [alpha], creating: () => created.promise });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.created.length, 1);
    await app.request({ type: 'SAVE_COLUMNS', columns: [] });
    created.resolve();
    await flush();
    assert.deepEqual(app.state.columns, []);
    assert.deepEqual(app.removed, [app.created[0].id]);
    assert.deepEqual((app.stored[RUNTIME_KEY] as { sources: object }).sources, {});
  } finally { created.resolve(); await app.close(); }
});

test('source ownership survives failure of optional tab decoration', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], updating: () => { throw new Error('Optional tab update failed.'); } });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal((app.stored[RUNTIME_KEY] as { sources: { alpha: { tabId: number } } }).sources.alpha.tabId, app.created[0].id);
  } finally { await app.close(); }
});

test('a source redirected to the X login flow suspends refreshes without a content script', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], creating: async tab => { tab.url = 'https://x.com/i/flow/login'; } });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'login-required');
    assert.equal(app.state.feeds.alpha.nextRefresh, undefined);
    assert.equal(app.messages.length, 0);
    assert.equal((app.stored[RUNTIME_KEY] as { sources: { alpha: { suspended: boolean } } }).sources.alpha.suspended, true);
  } finally { await app.close(); }
});

test('an unresponsive source times out and releases the persisted worker lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const alpha = column('alpha'), source = owned(alpha);
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: () => new Promise(() => {}) });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.messages.length, 1);
    t.mock.timers.tick(15_000);
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'error');
    assert.match(app.state.feeds.alpha.error ?? '', /respond/i);
    assert.equal((app.stored[RUNTIME_KEY] as { busy?: object }).busy, undefined);
  } finally { await app.close(); t.mock.timers.reset(); }
});

test('expired worker leases recover the interrupted job from persistent state', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  const generation = 'persisted-source-generation';
  const runtime = {
    ...source.runtime,
    sources: { alpha: { ...source.runtime.sources.alpha, generation } },
    busy: { token: 'interrupted-job', generation, columnId: alpha.id, since: NOW - 91_000, older: false },
  };
  const app = await background({ columns: [alpha], runtime, tabs: [source.tab] });
  try {
    (app.stored[STORAGE_KEY] as DeckState).feeds.alpha.status = 'loading';
    app.onAlarm.emit({ name: 'tdeck-refresh' });
    await flush();
    assert.equal(app.messages.length, 1);
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal((app.stored[RUNTIME_KEY] as { busy?: object }).busy, undefined);
  } finally { await app.close(); }
});

test('loading flags whose persisted job was lost recover on the next alarm', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], runtime: {} });
  try {
    const feed = (app.stored[STORAGE_KEY] as DeckState).feeds.alpha;
    feed.status = 'loading'; feed.loadingOlder = true;
    app.onAlarm.emit({ name: 'tdeck-refresh' });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal(app.state.feeds.alpha.loadingOlder, false);
    assert.equal(app.messages.length, 1);
  } finally { await app.close(); }
});

test('queued work gets a persistent one-shot wake after the navigation floor', async () => {
  const alpha = column('alpha'), beta = column('beta');
  const app = await background({ columns: [alpha, beta] });
  try {
    (app.stored[STORAGE_KEY] as DeckState).feeds.beta.nextRefresh = 0;
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.created.length, 1);
    assert.equal((app.alarms.get('tdeck-queued-work') as { when: number })?.when, NOW + 15_000);
    assert.ok(app.alarms.has('tdeck-refresh'));
  } finally { await app.close(); }
});

test('older work queued during another column read starts when that read finishes', async () => {
  const alpha = column('alpha'), beta = column('beta'), a = owned(alpha, 10), b = owned(beta, 11), first = deferred<SourceSnapshot>();
  const runtime = { ...a.runtime, sources: { ...a.runtime.sources, ...b.runtime.sources } };
  const app = await background({ columns: [alpha, beta], runtime, tabs: [a.tab, b.tab], read: id => id === 10 ? first.promise : snapshot(beta) });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    await app.request({ type: 'LOAD_OLDER', columnId: beta.id });
    first.resolve(snapshot(alpha));
    await flush();
    assert.deepEqual(app.messages.map(message => message.tabId), [10, 11]);
    assert.equal(app.state.feeds.beta.loadingOlder, false);
    assert.deepEqual(app.reloaded, [10]);
  } finally { first.resolve(snapshot(alpha)); await app.close(); }
});

test('untrusted malformed posts are filtered before collection while valid posts remain', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], read: () => ({ ...snapshot(alpha), posts: [null, { id: {} }, post('1800000000000000002')] }) });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal(app.state.feeds.alpha.posts.length, 2);
  } finally { await app.close(); }
});

test('older pagination stops when the bounded recent-post cache is full', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], read: () => ({ ...snapshot(alpha), hasMore: true }) });
  try {
    (app.stored[STORAGE_KEY] as DeckState).feeds.alpha.posts = Array.from({ length: 180 }, (_, index) => post(String(1_800_000_000_000_000_000n + BigInt(index))));
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.posts.length, 180);
    assert.equal(app.state.feeds.alpha.hasMore, false);
    const readCount = app.messages.length;
    await app.request({ type: 'LOAD_OLDER', columnId: alpha.id });
    await flush();
    assert.equal(app.messages.length, readCount);
    assert.equal(app.state.feeds.alpha.loadingOlder, false);
  } finally { await app.close(); }
});

test('refresh commits a valid first screen without requesting optional backfill', async () => {
  const alpha = column('alpha');
  const app = await background({ columns: [alpha], read: (_id, message) => {
    assert.equal(message.type, 'TDECK_READ', 'refresh must not depend on a follow-up scroll');
    return { ...snapshot(alpha, [post('1800000000000000002')]), hasMore: true };
  } });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal(app.state.feeds.alpha.posts.length, 2);
    assert.equal(app.messages.length, 1);
  } finally { await app.close(); }
});

test('refresh cannot read a stale complete document before its reload enters loading', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  let documentToken = 'old-document';
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], reloading: async () => {}, read: (_id, message) => {
    if (message.type === 'TDECK_DOCUMENT') return { documentToken, pageUrl: source.tab.url, readyState: 'complete' };
    return { ...snapshot(alpha, [post(documentToken === 'old-document' ? '1800000000000000002' : '1800000000000000003')]), documentToken };
  } });
  const completeNavigation = () => {
    app.tabs.get(source.tab.id!)!.status = 'loading';
    app.onUpdated.emit(source.tab.id, { status: 'loading' });
    documentToken = 'new-document';
    app.documentTokens.set(source.tab.id!, documentToken);
    app.tabs.get(source.tab.id!)!.status = 'complete';
    app.onUpdated.emit(source.tab.id, { status: 'complete' });
  };
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.messages.filter(message => message.type === 'TDECK_READ').length, 0, 'the old document must not be captured');
    completeNavigation();
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.ok(app.state.feeds.alpha.posts.some(item => item.id === '1800000000000000003'));
    assert.ok(!app.state.feeds.alpha.posts.some(item => item.id === '1800000000000000002'));
  } finally { completeNavigation(); await app.close(); }
});

test('refresh waits for a new content document announced after navigation completes', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], reloading: async id => {
    app.onUpdated.emit(id, { status: 'loading' });
    app.onUpdated.emit(id, { status: 'complete' });
  } });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.messages.length, 0);
    app.documentReady(source.tab.id!, 'newly-injected-document');
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal(app.messages.length, 1);
  } finally { app.documentReady(source.tab.id!, 'newly-injected-document'); await app.close(); }
});

test('a feed response from the wrong document cannot be committed after a valid reload', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: () => ({ ...snapshot(alpha, [post('1800000000000000002')]), documentToken: 'stale-document' }) });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'error');
    assert.match(app.state.feeds.alpha.error ?? '', /document changed/i);
    assert.equal(app.state.feeds.alpha.posts.length, 1);
  } finally { await app.close(); }
});

test('an older-scroll timeout preserves every valid post already collected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const alpha = column('alpha'), source = owned(alpha);
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: (_id, message) => message.type === 'TDECK_READ'
    ? { ...snapshot(alpha, [post('1800000000000000002')]), hasMore: true }
    : new Promise(() => {}) });
  try {
    await app.request({ type: 'LOAD_OLDER', columnId: alpha.id });
    await flush();
    assert.equal(app.messages.length, 2);
    t.mock.timers.tick(15_000);
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'error');
    assert.equal(app.state.feeds.alpha.posts.length, 2);
    assert.equal(app.state.feeds.alpha.loadingOlder, false);
  } finally { await app.close(); t.mock.timers.reset(); }
});

test('malformed older-scroll responses reject the job instead of accepting partial data', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: (_id, message) => message.type === 'TDECK_READ'
    ? { ...snapshot(alpha, [post('1800000000000000002')]), hasMore: true }
    : { ...snapshot(alpha), posts: 'not a post array' } });
  try {
    await app.request({ type: 'LOAD_OLDER', columnId: alpha.id });
    await flush();
    assert.equal(app.state.feeds.alpha.status, 'error');
    assert.equal(app.state.feeds.alpha.posts.length, 1);
    assert.match(app.state.feeds.alpha.error ?? '', /unreadable/i);
  } finally { await app.close(); }
});

test('list discovery uses the signed-in profile, reads at most three screens, and preserves feed tabs', async () => {
  const alpha = column('alpha'), source = owned(alpha);
  let screen = 0;
  const app = await background({ columns: [alpha], runtime: source.runtime, tabs: [source.tab], read: (id, message) => {
    const pageUrl = app.tabs.get(id)!.url!;
    if (message.type === 'TDECK_PROFILE') return { status: 'ready', pageUrl, handle: 'signed_in', listUrl: 'https://x.com/signed_in/lists' };
    assert.equal(new URL(pageUrl).pathname, '/signed_in/lists');
    return { status: 'ready', pageUrl, hasMore: true, lists: [{ id: 'pick:0', selectionKey: `list:screen:${screen++}`, name: `List ${screen}` }] };
  } });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.state.listsStatus, 'ready');
    assert.equal(app.state.lists?.length, 3);
    assert.deepEqual(app.messages.map(message => [message.type, message.scroll]), [['TDECK_PROFILE', undefined], ['TDECK_LISTS', false], ['TDECK_LISTS', true], ['TDECK_LISTS', true]]);
    assert.match(app.created[0].url!, /^https:\/\/x\.com\/home#tdeck-lists=/);
    assert.deepEqual(app.removed, [app.created[0].id]);
    assert.equal(app.tabs.has(source.tab.id!), true);
    assert.deepEqual(app.reloaded, []);
    assert.equal((app.stored[RUNTIME_KEY] as { listsJob?: object }).listsJob, undefined);
    assert.equal(readState(app.stored[STORAGE_KEY]).lists?.length, 3);
  } finally { await app.close(); }
});

test('list discovery accepts real parser snapshots with clean URLs while checking the actual tab marker', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: { document: Document } } };
  const document = new JSDOM('<nav><a data-testid="AppTabBar_Profile_Link" href="/signed_in">Profile</a></nav><main><div data-testid="primaryColumn"><h2>Your Lists</h2><div data-testid="listCell" role="link"><span>My existing list</span><span>3 members</span><button aria-label="Pin List"></button></div></div></main>').window.document;
  const app = await background({ columns: [], read: (id, message) => {
    const pageUrl = app.tabs.get(id)!.url!;
    assert.match(pageUrl, /#tdeck-lists=/);
    const result = message.type === 'TDECK_PROFILE' ? extractProfileSnapshot(document, pageUrl) : extractListsSnapshot(document, pageUrl);
    assert.equal(new URL(result.pageUrl).hash, '', 'the production parser strips ownership fragments');
    return result;
  } });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.state.listsStatus, 'ready');
    assert.equal(app.state.lists?.[0].name, 'My existing list');
    assert.deepEqual(app.removed, [app.created[0].id]);
  } finally { await app.close(); }
});

test('clean list snapshot URLs cannot substitute another origin or account directory', async () => {
  const app = await background({ columns: [], read: (id, message) => message.type === 'TDECK_PROFILE'
    ? { status: 'ready', pageUrl: app.tabs.get(id)!.url, handle: 'alice', listUrl: 'https://x.com/alice/lists' }
    : { status: 'ready', pageUrl: 'https://attacker.example/alice/lists', hasMore: false, lists: [{ id: '12345', name: 'Injected list' }] } });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.state.listsStatus, 'error');
    assert.deepEqual(app.state.lists, []);
    assert.deepEqual(app.removed, [app.created[0].id]);
  } finally { await app.close(); }
});

test('repeated list discovery requests share one pending temporary tab', async () => {
  const profile = deferred<unknown>();
  const app = await background({ columns: [], read: (id, message) => message.type === 'TDECK_PROFILE' ? profile.promise : { status: 'ready', pageUrl: app.tabs.get(id)!.url, hasMore: false, lists: [] } });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.created.length, 1);
    assert.equal(app.state.listsStatus, 'loading');
    profile.resolve({ status: 'ready', pageUrl: app.created[0].url, handle: 'alice', listUrl: 'https://x.com/alice/lists' });
    await flush();
    assert.equal(app.state.listsStatus, 'ready');
    assert.deepEqual(app.removed, [app.created[0].id]);
  } finally { profile.resolve({ status: 'error', pageUrl: 'https://x.com/home' }); await app.close(); }
});

test('an unresolved own list is resolved only by verified ordinary card navigation', async () => {
  const selectionKey = 'list:native-card:0';
  const app = await background({ columns: [], read: (id, message) => {
    const tab = app.tabs.get(id)!;
    if (message.type === 'TDECK_PROFILE') return { status: 'ready', pageUrl: tab.url, handle: 'alice', listUrl: 'https://x.com/alice/lists' };
    if (message.type === 'TDECK_LISTS') return { status: 'ready', pageUrl: tab.url, hasMore: false, lists: [{ id: 'pick:0', selectionKey, name: 'My security list', members: '12' }] };
    assert.equal(message.type, 'TDECK_SELECT_LIST');
    assert.equal(message.selectionKey, selectionKey);
    tab.url = 'https://x.com/i/lists/987654321';
    return { status: 'ready', pageUrl: tab.url, id: '987654321' };
  } });
  try {
    (app.stored[STORAGE_KEY] as DeckState).lists = [{ id: 'pick:0', selectionKey, name: 'My security list' }];
    const response = await app.request({ type: 'RESOLVE_LIST', selectionKey });
    assert.equal(response.ok, true);
    assert.equal(app.state.listsStatus, 'ready');
    assert.equal(app.state.lists?.[0].id, '987654321');
    assert.equal(app.state.lists?.[0].selectionKey, selectionKey);
    assert.deepEqual(app.removed, [app.created[0].id]);
    assert.equal(app.messages.filter(message => message.type === 'TDECK_SELECT_LIST').length, 1);
  } finally { await app.close(); }
});

test('list discovery preserves cached lists when the profile handshake is invalid', async () => {
  const app = await background({ columns: [], read: id => ({ status: 'ready', pageUrl: app.tabs.get(id)!.url, handle: 'alice', listUrl: 'https://attacker.example/lists' }) });
  try {
    (app.stored[STORAGE_KEY] as DeckState).lists = [{ id: '12345', name: 'Cached list' }];
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.state.listsStatus, 'error');
    assert.equal(app.state.lists?.[0].name, 'Cached list');
    assert.deepEqual(app.removed, [app.created[0].id]);
    assert.equal(app.messages.length, 1);
  } finally { await app.close(); }
});

test('a user-navigated discovery tab is never reclaimed or deleted', async () => {
  const app = await background({ columns: [], read: id => {
    const tab = app.tabs.get(id)!;
    const pageUrl = tab.url;
    tab.pendingUrl = 'https://example.com/user-navigation';
    return { status: 'ready', pageUrl, handle: 'alice', listUrl: 'https://x.com/alice/lists' };
  } });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.state.listsStatus, 'error');
    assert.deepEqual(app.removed, []);
    assert.equal(app.tabs.has(app.created[0].id!), true);
  } finally { await app.close(); }
});

test('a selected list ID must agree with the actual browser destination', async () => {
  const selectionKey = 'list:mismatch:0';
  const app = await background({ columns: [], read: (id, message) => {
    const tab = app.tabs.get(id)!;
    if (message.type === 'TDECK_PROFILE') return { status: 'ready', pageUrl: tab.url, handle: 'alice', listUrl: 'https://x.com/alice/lists' };
    if (message.type === 'TDECK_LISTS') return { status: 'ready', pageUrl: tab.url, hasMore: false, lists: [{ id: 'pick:0', selectionKey, name: 'A list' }] };
    tab.url = 'https://x.com/i/lists/99999';
    return { status: 'ready', pageUrl: 'https://x.com/i/lists/12345', id: '12345' };
  } });
  try {
    (app.stored[STORAGE_KEY] as DeckState).lists = [{ id: 'pick:0', selectionKey, name: 'A list' }];
    const response = await app.request({ type: 'RESOLVE_LIST', selectionKey });
    assert.equal(response.ok, false);
    assert.equal(app.state.listsStatus, 'error');
    assert.equal(app.state.lists?.[0].id, 'pick:0');
    assert.deepEqual(app.removed, []);
  } finally { await app.close(); }
});

test('closing a pending discovery invalidates its token and prevents stale success', async () => {
  const profile = deferred<unknown>();
  const app = await background({ columns: [], read: () => profile.promise });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    const tab = app.created[0];
    app.tabs.delete(tab.id!);
    app.onRemoved.emit(tab.id, { windowId: 1, isWindowClosing: false });
    await flush();
    profile.resolve({ status: 'ready', pageUrl: tab.url, handle: 'alice', listUrl: 'https://x.com/alice/lists' });
    await flush();
    assert.equal(app.state.listsStatus, 'error');
    assert.match(app.state.listsError ?? '', /closed/i);
    assert.equal((app.stored[RUNTIME_KEY] as { listsJob?: object }).listsJob, undefined);
  } finally { profile.resolve({ status: 'error', pageUrl: 'https://x.com/home' }); await app.close(); }
});

test('resuming a persisted discovery reuses its tab and remaining screen budget', async () => {
  const listsJob = { token: 'persisted-list-job', since: NOW - 20_000, tabId: 20, handle: 'alice', screens: 1, lists: [{ id: '12345', name: 'Previously found' }] };
  const tab = { id: 20, url: 'https://x.com/alice/lists#tdeck-lists=persisted-list-job', active: false, status: 'complete', windowId: 1 } as chrome.tabs.Tab;
  const app = await background({ columns: [], runtime: { sources: {}, nextNavigation: 0, cooldownUntil: 0, listsJob }, tabs: [tab], read: id => ({ status: 'ready', pageUrl: app.tabs.get(id)!.url, lists: [{ id: '67890', name: 'Newly found' }], hasMore: true }) });
  try {
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    assert.equal(app.created.length, 0);
    assert.equal(app.messages.length, 2);
    assert.ok(app.messages.every(message => message.type === 'TDECK_LISTS' && message.scroll));
    assert.equal(app.state.listsStatus, 'ready');
    assert.equal(app.state.lists?.length, 2);
    assert.deepEqual(app.removed, [20]);
  } finally { await app.close(); }
});

test('an expired discovery is cleaned up without starting an automatic crawl', async () => {
  const listsJob = { token: 'expired-list-job', since: NOW - 121_000, tabId: 20, screens: 0, lists: [] };
  const tab = { id: 20, url: 'https://x.com/home#tdeck-lists=expired-list-job', active: false, status: 'complete', windowId: 1 } as chrome.tabs.Tab;
  const app = await background({ columns: [], runtime: { sources: {}, nextNavigation: 0, cooldownUntil: 0, listsJob }, tabs: [tab] });
  try {
    (app.stored[STORAGE_KEY] as DeckState).listsStatus = 'loading';
    app.onAlarm.emit({ name: 'tdeck-refresh' });
    await flush();
    assert.equal(app.state.listsStatus, 'error');
    assert.match(app.state.listsError ?? '', /interrupted/i);
    assert.deepEqual(app.removed, [20]);
    assert.equal(app.created.length, 0);
    assert.equal(app.messages.length, 0);
  } finally { await app.close(); }
});

test('list response timeouts preserve the cache and clean up their temporary source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = await background({ columns: [], read: () => new Promise(() => {}) });
  try {
    (app.stored[STORAGE_KEY] as DeckState).lists = [{ id: '12345', name: 'Cached' }];
    await app.request({ type: 'LOAD_LISTS' });
    await flush();
    t.mock.timers.tick(15_000);
    await flush();
    assert.equal(app.state.listsStatus, 'error');
    assert.equal(app.state.lists?.[0].id, '12345');
    assert.deepEqual(app.removed, [app.created[0].id]);
  } finally { await app.close(); t.mock.timers.reset(); }
});

test('list normalization retains safe unresolved selections and already-resolved IDs', () => {
  const lists = sanitizeLists([
    { id: '12345', name: 'Resolved', selectionKey: 'list:one:0' },
    { id: 'pick:0', name: 'Resolved, renamed', selectionKey: 'list:one:0' },
    { id: 'pick:0', name: 'Second', selectionKey: 'list:two:0', image: 'javascript:alert(1)' },
    { id: 'pick:0', name: 'Third', selectionKey: 'list:three:0' },
    { id: 'pick:0', name: 'No usable selection key' },
    { id: 'https://evil.example/list', name: 'Bad identity' },
  ]);
  assert.deepEqual(lists.map(list => [list.id, list.name]), [['12345', 'Resolved, renamed'], ['pick:1', 'Second'], ['pick:2', 'Third']]);
  assert.equal(lists[1].image, undefined);
});

function browserWindow(id: number, patch: Partial<chrome.windows.Window> = {}): chrome.windows.Window {
  return { id, focused: false, state: 'normal', type: 'normal', alwaysOnTop: false, incognito: false, ...patch };
}

test('the source broker migrates only marked sources into one unfocused normal window', async () => {
  const alpha = column('alpha'), beta = column('beta'), a = owned(alpha, 10), b = owned(beta, 11);
  const unrelated = { ...a.tab, id: 12, url: 'https://example.com/my-tab', active: true };
  const app = await background({ columns: [alpha, beta], runtime: { ...a.runtime, sources: { ...a.runtime.sources, ...b.runtime.sources }, groupId: 7 }, tabs: [Object.assign(a.tab, { groupId: 7, frozen: true }), b.tab, unrelated] });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id }); await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready');
    assert.equal(app.windowCreates.length, 1);
    assert.deepEqual(app.windowCreates[0], { tabId: 10, focused: false, type: 'normal', state: 'normal', width: 1_100, height: 850 });
    const id = (app.stored[RUNTIME_KEY] as { sourceWindowId: number }).sourceWindowId;
    assert.equal(app.tabs.get(10)?.windowId, id); assert.equal(app.tabs.get(11)?.windowId, id);
    assert.equal(app.tabs.get(12)?.windowId, 1); assert.equal(app.tabs.get(12)?.active, true);
    assert.equal(app.windows.get(1)?.focused, true); assert.equal(app.windows.get(id)?.focused, false);
    assert.equal(app.windowUpdates.length, 0);
    assert.ok(app.messages.every(message => typeof message.expiresAt === 'number' && message.expiresAt > NOW));
  } finally { await app.close(); }
});

test('the broker rotates active sources without focusing its window and permits older pagination', async () => {
  const alpha = column('alpha'), beta = column('beta'), a = owned(alpha, 10), b = owned(beta, 11);
  Object.assign(a.tab, { windowId: 2, active: true }); Object.assign(b.tab, { windowId: 2, active: false });
  let reads = 0;
  const app = await background({ columns: [alpha, beta], runtime: { ...a.runtime, sources: { ...a.runtime.sources, ...b.runtime.sources }, sourceWindowId: 2, nextNavigation: NOW + 15_000 }, tabs: [a.tab, b.tab], windows: [browserWindow(1, { focused: true }), browserWindow(2)], read: (_id, message) => {
    reads++; assert.equal(app.tabs.get(11)?.active, true); assert.equal(app.windows.get(2)?.focused, false);
    return { ...snapshot(beta, [post(message.type === 'TDECK_SCROLL' ? '1800000000000000002' : undefined)]), hasMore: message.type === 'TDECK_READ' };
  } });
  try {
    await app.request({ type: 'LOAD_OLDER', columnId: beta.id }); await flush();
    assert.equal(app.state.feeds.beta.status, 'ready'); assert.equal(reads, 2);
    assert.equal(app.tabs.get(10)?.active, false); assert.equal(app.tabs.get(11)?.active, true);
    assert.equal(app.windowCreates.length, 0); assert.equal(app.reloaded.length, 0); assert.equal(app.windowUpdates.length, 0);
  } finally { await app.close(); }
});

test('a focused or minimized source window is never rotated, reloaded, or restored automatically', async () => {
  for (const patch of [{ focused: true }, { state: 'minimized' as const }]) {
    const alpha = column('alpha'), a = owned(alpha); Object.assign(a.tab, { windowId: 2, active: false });
    const app = await background({ columns: [alpha], runtime: { ...a.runtime, sourceWindowId: 2 }, tabs: [a.tab], windows: [browserWindow(1, { focused: true }), browserWindow(2, patch)] });
    try {
      await app.request({ type: 'LOAD_OLDER', columnId: alpha.id }); await flush();
      assert.equal(app.state.feeds.alpha.status, 'error');
      assert.equal(app.reloaded.length, 0); assert.equal(app.messages.length, 0); assert.equal(app.windowCreates.length, 0); assert.equal(app.windowUpdates.length, 0);
      assert.equal(app.tabs.get(10)?.active, false);
    } finally { await app.close(); }
  }
});

test('a window containing any unrelated tab is not taken over despite a persisted broker ID', async () => {
  const alpha = column('alpha'), a = owned(alpha); Object.assign(a.tab, { windowId: 2, active: false });
  const app = await background({ columns: [alpha], runtime: { ...a.runtime, sourceWindowId: 2 }, tabs: [a.tab, { ...a.tab, id: 11, url: 'https://example.com/personal', active: true }], windows: [browserWindow(1, { focused: true }), browserWindow(2)] });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id }); await flush();
    assert.equal(app.state.feeds.alpha.status, 'error'); assert.match(app.state.feeds.alpha.error ?? '', /another tab/i);
    assert.equal(app.tabs.get(11)?.active, true); assert.equal(app.tabs.get(10)?.active, false);
    assert.equal(app.windowCreates.length, 0); assert.equal(app.reloaded.length, 0); assert.equal(app.moved.length, 0);
  } finally { await app.close(); }
});

test('another known source redirected to sign-in reports auth expiry without browser control', async () => {
  const alpha = column('alpha'), beta = column('beta'), a = owned(alpha, 10), b = owned(beta, 11);
  Object.assign(a.tab, { windowId: 2, active: false });
  Object.assign(b.tab, { windowId: 2, active: true, url: 'https://x.com/i/flow/login' });
  let tabUpdates = 0;
  const app = await background({ columns: [alpha, beta], runtime: { ...a.runtime, sources: { ...a.runtime.sources, ...b.runtime.sources }, sourceWindowId: 2 }, tabs: [a.tab, b.tab], windows: [browserWindow(1, { focused: true }), browserWindow(2)], updating: () => { tabUpdates++; } });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id }); await flush();
    assert.equal(app.state.feeds.alpha.status, 'login-required');
    assert.match(app.state.feeds.alpha.error ?? '', /sign in/i);
    assert.equal(app.messages.length, 0); assert.equal(tabUpdates, 0);
    assert.equal(app.created.length, 0); assert.equal(app.windowCreates.length, 0); assert.equal(app.windowUpdates.length, 0);
    assert.equal(app.reloaded.length, 0); assert.equal(app.moved.length, 0); assert.equal(app.removed.length, 0);
    assert.equal(app.tabs.get(11)?.url, 'https://x.com/i/flow/login'); assert.equal(app.tabs.get(11)?.active, true);
  } finally { await app.close(); }
});

test('a reused window ID without any current marked source does not confer ownership', async () => {
  const alpha = column('alpha'), a = owned(alpha);
  const unrelated = { ...a.tab, id: 11, windowId: 2, url: 'https://example.com/personal', active: true };
  const app = await background({ columns: [alpha], runtime: { ...a.runtime, sourceWindowId: 2 }, tabs: [a.tab, unrelated], windows: [browserWindow(1, { focused: true }), browserWindow(2)] });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id }); await flush();
    assert.equal(app.state.feeds.alpha.status, 'ready'); assert.equal(app.windowCreates.length, 1);
    assert.equal(app.tabs.get(11)?.windowId, 2); assert.equal(app.tabs.get(11)?.active, true);
    assert.notEqual((app.stored[RUNTIME_KEY] as { sourceWindowId: number }).sourceWindowId, 2);
  } finally { await app.close(); }
});

test('focusing the source window midway through a read prevents later pagination', async () => {
  const alpha = column('alpha'), a = owned(alpha); Object.assign(a.tab, { windowId: 2, active: true });
  const app = await background({ columns: [alpha], runtime: { ...a.runtime, sourceWindowId: 2 }, tabs: [a.tab], windows: [browserWindow(1, { focused: true }), browserWindow(2)], read: () => {
    app.windows.get(2)!.focused = true;
    return { ...snapshot(alpha), hasMore: true };
  } });
  try {
    await app.request({ type: 'LOAD_OLDER', columnId: alpha.id }); await flush();
    assert.deepEqual(app.messages.map(message => message.type), ['TDECK_READ']);
    assert.equal(app.windowUpdates.length, 0);
  } finally { await app.close(); }
});

test('explicit Open source restores and focuses the actual owned source instead of opening a duplicate', async () => {
  const alpha = column('alpha'), a = owned(alpha); Object.assign(a.tab, { windowId: 2, active: true });
  const app = await background({ columns: [alpha], runtime: { ...a.runtime, sourceWindowId: 2 }, tabs: [a.tab], windows: [browserWindow(1, { focused: true }), browserWindow(2, { state: 'minimized' })] });
  try {
    await app.request({ type: 'OPEN_SOURCE', columnId: alpha.id }); await flush();
    assert.equal(app.created.length, 0);
    assert.deepEqual(app.windowUpdates, [{ id: 2, properties: { focused: true, state: 'normal' } }]);
    assert.equal(app.reloaded.length, 0);
  } finally { await app.close(); }
});

test('pausing and resuming preserves the underlying source error and previous successful timestamp', async () => {
  const alpha = column('alpha'), a = owned(alpha); a.runtime.nextNavigation = NOW + 15_000;
  const app = await background({ columns: [alpha], runtime: a.runtime, tabs: [a.tab] });
  try {
    Object.assign((app.stored[STORAGE_KEY] as DeckState).feeds.alpha, { status: 'error', error: 'Native timeline failed.', lastUpdated: NOW - 420_000 });
    await app.request({ type: 'UPDATE_SETTINGS', patch: { paused: true } });
    assert.equal(app.state.feeds.alpha.status, 'paused');
    await app.request({ type: 'UPDATE_SETTINGS', patch: { paused: false } }); await flush();
    assert.equal(app.state.feeds.alpha.status, 'error'); assert.equal(app.state.feeds.alpha.error, 'Native timeline failed.');
    assert.equal(app.state.feeds.alpha.lastUpdated, NOW - 420_000); assert.equal(app.messages.length, 0);
  } finally { await app.close(); }
});

test('a transient native error gets one bounded worker retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const alpha = column('alpha'); let reads = 0;
  const app = await background({ columns: [alpha], read: () => ++reads === 1 ? { ...snapshot(alpha, []), status: 'error', error: 'Temporary placeholder.' } : snapshot(alpha) });
  try {
    await app.request({ type: 'REFRESH', columnId: alpha.id }); await flush(); assert.equal(reads, 1);
    t.mock.timers.tick(1_200); await flush();
    assert.equal(reads, 2); assert.equal(app.state.feeds.alpha.status, 'ready');
  } finally { await app.close(); t.mock.timers.reset(); }
});

test('named layouts persist independent configuration snapshots and require explicit overwrite', async () => {
  const app = await background();
  try {
    (app.stored[STORAGE_KEY] as DeckState).connected = false;
    const saved = await app.request({ type: 'SAVE_LAYOUT', name: ' Work ' }); assert.equal(saved.ok, true);
    const id = app.state.layouts![0].id;
    assert.equal(app.state.layouts![0].name, 'Work'); assert.equal('feeds' in app.state.layouts![0], false); assert.equal('connected' in app.state.layouts![0], false);
    assert.equal((await app.request({ type: 'SAVE_LAYOUT', name: 'work' })).ok, false);
    await app.request({ type: 'SAVE_COLUMNS', columns: [column('beta')] });
    assert.equal(app.state.layouts![0].columns[0].id, 'alpha');
    await app.request({ type: 'SAVE_LAYOUT', id, name: 'Updated' });
    assert.equal(app.state.layouts!.length, 1); assert.equal(app.state.layouts![0].columns[0].id, 'beta');
    await app.request({ type: 'RENAME_LAYOUT', layoutId: id, name: ' Weekend ' }); assert.equal(app.state.layouts![0].name, 'Weekend');
    await app.request({ type: 'DELETE_LAYOUT', layoutId: id });
    assert.deepEqual(app.state.layouts, []); assert.equal(app.state.columns[0].id, 'beta');
  } finally { await app.close(); }
});

test('loading a layout preserves bookmarks, connection and the library while safely retiring old sources', async () => {
  const alpha = column('alpha'), a = owned(alpha); Object.assign(a.tab, { windowId: 2, active: true });
  const app = await background({ columns: [alpha], runtime: { ...a.runtime, sourceWindowId: 2 }, tabs: [a.tab], windows: [browserWindow(1, { focused: true }), browserWindow(2)] });
  try {
    const state = app.stored[STORAGE_KEY] as DeckState;
    state.bookmarks = [post()]; state.layouts = [{ id: 'saved', name: 'Other', columns: [column('beta')], settings: { ...DEFAULT_SETTINGS, paused: true, theme: 'light' }, updatedAt: NOW }];
    await app.request({ type: 'LOAD_LAYOUT', layoutId: 'saved' }); await flush();
    assert.equal(app.state.connected, true); assert.equal(app.state.bookmarks.length, 1); assert.equal(app.state.layouts?.length, 1);
    assert.equal(app.state.columns[0].id, 'beta'); assert.equal(app.state.settings.theme, 'light'); assert.deepEqual(app.removed, [10]);
    assert.equal(app.created.length, 0); assert.equal(app.state.feeds.beta.status, 'paused');
  } finally { await app.close(); }
});

test('layout count and UTF-8 storage quotas reject new saves without damaging the prior library', async () => {
  const app = await background();
  try {
    (app.stored[STORAGE_KEY] as DeckState).connected = false;
    for (let index = 0; index < MAX_LAYOUTS; index++) assert.equal((await app.request({ type: 'SAVE_LAYOUT', name: `Layout ${index}` })).ok, true);
    const before = app.state.layouts;
    assert.equal((await app.request({ type: 'SAVE_LAYOUT', name: 'One too many' })).ok, false);
    assert.deepEqual(app.state.layouts, before);
    const heavyColumns = validateColumns(Array.from({ length: 12 }, (_, index) => ({ ...column(`heavy${index}`), mutedWords: Array.from({ length: 50 }, () => '界'.repeat(100)) })));
    const heavy = Array.from({ length: 10 }, (_, index) => ({ id: `heavy${index}`, name: `Heavy ${index}`, columns: heavyColumns, settings: DEFAULT_SETTINGS, updatedAt: NOW }));
    const state = app.stored[STORAGE_KEY] as DeckState; state.columns = heavyColumns; state.layouts = sanitizeLayouts(heavy);
    const original = structuredClone(state.layouts);
    assert.ok(new TextEncoder().encode(JSON.stringify(original)).byteLength < MAX_LAYOUT_BYTES);
    assert.equal((await app.request({ type: 'SAVE_LAYOUT', name: 'Overflow bytes' })).ok, false);
    assert.deepEqual(app.state.layouts, original);
  } finally { await app.close(); }
});
