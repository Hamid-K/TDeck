import { MAX_LAYOUTS, MAX_POSTS, applyColumns, dedupePosts, fitStorage, mergeFeed, readState, sameSource, sanitizeLists, sanitizePost, sourceUrl, validateColumns, validateLayoutQuota, validateSettings } from './shared/core';
import { EMPTY_FEED, STORAGE_KEY, type ColumnConfig, type DeckState, type FeedStatus, type ListSelectionSnapshot, type ListSnapshot, type ProfileSnapshot, type Request, type Response, type SourceRequest, type SourceSnapshot, type XList } from './shared/types';

interface Source {
  tabId?: number;
  expectedUrl: string;
  generation: string;
  failures: number;
  suspended?: boolean;
  requested?: 'refresh' | 'older';
  requestedAt?: number;
  pausedStatus?: Exclude<FeedStatus, 'paused'>;
}
interface Runtime {
  sources: Record<string, Source>;
  groupId?: number;
  sourceWindowId?: number;
  nextNavigation: number;
  cooldownUntil: number;
  busy?: { token: string; generation: string; columnId: string; since: number; older: boolean };
  listsJob?: ListsJob;
}
interface ListsJob {
  token: string;
  since: number;
  tabId?: number;
  handle?: string;
  selectionKey?: string;
  screens: number;
  lists: XList[];
}
interface Job {
  token: string;
  column: ColumnConfig;
  source: Source;
  older: boolean;
  navigationReserved: boolean;
  since: number;
  known: string[];
  document?: { token: string; documentId?: string };
  windowId?: number;
}
const RUNTIME_KEY = 'tdeck-runtime';
const ALARM = 'tdeck-refresh';
const WAKE_ALARM = 'tdeck-queued-work';
const NAVIGATION_GAP = 15_000;
const JOB_LEASE = 90_000;
const RESPONSE_TIMEOUT = 14_000;
const LISTS_LEASE = 120_000;
const emptyRuntime = (): Runtime => ({ sources: {}, nextNavigation: 0, cooldownUntil: 0 });
let transactionQueue: Promise<unknown> = Promise.resolve();
let activePump: Promise<void> | undefined;
let activeLists: { selectionKey?: string; promise: Promise<void> } | undefined;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const token = () => crypto.randomUUID();
const newSource = (column: ColumnConfig): Source => ({ expectedUrl: sourceUrl(column, true), generation: token(), failures: 0 });

function readRuntime(value: unknown, state: DeckState): Runtime {
  const runtime = emptyRuntime();
  if (!object(value)) return runtime;
  const now = Date.now();
  runtime.nextNavigation = Math.min(finite(value.nextNavigation), now + NAVIGATION_GAP);
  runtime.cooldownUntil = Math.min(finite(value.cooldownUntil), now + 1_800_000);
  if (Number.isInteger(value.groupId) && Number(value.groupId) >= 0) runtime.groupId = Number(value.groupId);
  if (Number.isInteger(value.sourceWindowId) && Number(value.sourceWindowId) >= 0) runtime.sourceWindowId = Number(value.sourceWindowId);
  for (const column of state.columns) {
    const raw = object(value.sources) ? value.sources[column.id] : undefined;
    if (!object(raw) || !sameSource(typeof raw.expectedUrl === 'string' ? raw.expectedUrl : undefined, sourceUrl(column, true))) continue;
    const source = newSource(column);
    if (typeof raw.generation === 'string' && /^[\w-]{1,80}$/.test(raw.generation)) source.generation = raw.generation;
    if (Number.isInteger(raw.tabId) && Number(raw.tabId) >= 0) source.tabId = Number(raw.tabId);
    source.failures = Math.min(10, Math.floor(finite(raw.failures)));
    source.suspended = raw.suspended === true;
    if (['idle', 'loading', 'ready', 'login-required', 'rate-limited', 'error'].includes(String(raw.pausedStatus))) source.pausedStatus = raw.pausedStatus as Source['pausedStatus'];
    if (!source.suspended && (raw.requested === 'refresh' || raw.requested === 'older')) {
      source.requested = raw.requested;
      source.requestedAt = Math.min(finite(raw.requestedAt, now), now);
    }
    runtime.sources[column.id] = source;
  }
  const busy = value.busy;
  if (object(busy) && typeof busy.columnId === 'string' && typeof busy.token === 'string' && /^[\w-]{1,80}$/.test(busy.token)
    && typeof busy.generation === 'string' && runtime.sources[busy.columnId]?.generation === busy.generation
    && typeof busy.since === 'number' && Number.isFinite(busy.since) && busy.since >= 0 && busy.since <= now) {
    runtime.busy = { token: busy.token, generation: busy.generation, columnId: busy.columnId, since: busy.since, older: busy.older === true };
  }
  const listsJob = value.listsJob;
  if (object(listsJob) && typeof listsJob.token === 'string' && /^[\w-]{1,80}$/.test(listsJob.token)
    && typeof listsJob.since === 'number' && Number.isFinite(listsJob.since) && listsJob.since >= 0 && listsJob.since <= now) {
    runtime.listsJob = { token: listsJob.token, since: listsJob.since, screens: Math.min(3, Math.floor(finite(listsJob.screens))), lists: sanitizeLists(listsJob.lists) };
    if (Number.isInteger(listsJob.tabId) && Number(listsJob.tabId) >= 0) runtime.listsJob.tabId = Number(listsJob.tabId);
    if (typeof listsJob.handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(listsJob.handle)) runtime.listsJob.handle = listsJob.handle;
    if (typeof listsJob.selectionKey === 'string' && listsJob.selectionKey.length > 0 && listsJob.selectionKey.length <= 512) runtime.listsJob.selectionKey = listsJob.selectionKey;
  }
  return runtime;
}

async function transaction<T>(fn: (state: DeckState, runtime: Runtime) => T | Promise<T>): Promise<T> {
  const operation = transactionQueue.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEY, RUNTIME_KEY]);
    const state = readState(stored[STORAGE_KEY]);
    const runtime = readRuntime(stored[RUNTIME_KEY], state);
    if (state.listsStatus === 'loading' && !runtime.listsJob) { state.listsStatus = 'error'; state.listsError = 'List discovery was interrupted. Load your lists again.'; }
    for (const column of state.columns) {
      const feed = state.feeds[column.id], source = runtime.sources[column.id];
      if (runtime.busy?.columnId === column.id || source?.requested || (!feed.loadingOlder && feed.status !== 'loading')) continue;
      // Recover a UI loading flag if an old/malformed runtime lost its job.
      feed.loadingOlder = false;
      feed.status = state.settings.paused || column.paused ? 'paused' : source?.suspended ? 'error' : feed.posts.length ? 'ready' : 'idle';
      feed.nextRefresh = source?.suspended ? undefined : Date.now();
    }
    const result = await fn(state, runtime);
    await chrome.storage.local.set({ [STORAGE_KEY]: fitStorage(state), [RUNTIME_KEY]: runtime });
    return result;
  });
  transactionQueue = operation;
  return operation;
}

async function getState(): Promise<DeckState> {
  await transactionQueue.catch(() => undefined);
  return readState((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

async function openDeck() {
  const url = chrome.runtime.getURL('index.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]?.id !== undefined) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}

async function removeOwned(source: Source) {
  if (source.tabId === undefined) return;
  try {
    const tab = await chrome.tabs.get(source.tabId);
    if (sameSource(tab.pendingUrl ?? tab.url, source.expectedUrl) && !(await inspectingSource(tab))) await chrome.tabs.remove(source.tabId);
  } catch { /* Already closed. Never remove tabs whose ownership cannot be verified. */ }
}

async function ownedTab(source: Source): Promise<chrome.tabs.Tab | undefined> {
  if (source.tabId === undefined) return;
  try {
    const tab = await chrome.tabs.get(source.tabId);
    if (sameSource(tab.pendingUrl ?? tab.url, source.expectedUrl)) return tab;
  } catch { /* Closed or unavailable. */ }
}

async function inspectingSource(tab: chrome.tabs.Tab, sourceWindowId?: number): Promise<boolean> {
  if (!tab.active && tab.windowId !== sourceWindowId) return false;
  try { return (await chrome.windows.get(tab.windowId)).focused; }
  catch { return true; } // Unknown window state never grants control.
}

async function verifiedSourceWindow(runtime: Pick<Runtime, 'sources' | 'sourceWindowId'>): Promise<chrome.windows.Window | undefined> {
  if (runtime.sourceWindowId === undefined) return;
  const window = await chrome.windows.get(runtime.sourceWindowId, { populate: true }).catch(() => undefined);
  if (!window) return;
  const tabs = window.tabs ?? await chrome.tabs.query({ windowId: runtime.sourceWindowId });
  const sources = Object.values(runtime.sources);
  // A known source may lose its marker when X redirects it to sign-in. Stop
  // with an auth notice; it is neither an owned destination nor a foreign tab
  // that the broker may move, activate, or otherwise take over.
  if (tabs.some(tab => sources.some(source => source.tabId === tab.id) && loginPage(tab.pendingUrl ?? tab.url))) {
    throw new LoginRequired('Sign in to X in this browser profile, then refresh this column.');
  }
  const owned = (tab: chrome.tabs.Tab) => sources.some(source => source.tabId === tab.id && sameSource(tab.pendingUrl ?? tab.url, source.expectedUrl));
  if (!tabs.some(owned)) return; // A stale/reused ID is not ownership.
  if (!tabs.every(owned)) throw new Error('The TDeck source window contains another tab. Move that tab to another window, then refresh.');
  if (window.type !== 'normal') throw new Error('Keep the TDeck source window as a normal browser window, then refresh.');
  return window;
}

function usableSourceWindow(window: chrome.windows.Window): void {
  if (window.focused) throw new Error('The source window is open in X. Switch back to TDeck before refreshing or loading older posts.');
  if (window.state === 'minimized') throw new Error('The TDeck source window is minimized. Open this source in X to restore it, then return to TDeck and refresh.');
}

async function sourceWindowRuntime(job: Job) {
  return transaction((state, runtime) => {
    if (!currentJob(state, runtime, job)) throw new CancelledJob('The column changed while preparing its source window.');
    return { sources: structuredClone(runtime.sources), sourceWindowId: runtime.sourceWindowId };
  });
}

async function prepareSourceWindow(job: Job, tabId: number): Promise<boolean> {
  let source = await checkJob(job), tab = await ownedTab(source);
  if (!tab || tab.id !== tabId) {
    const actual = await chrome.tabs.get(tabId).catch(() => undefined);
    if (loginPage(actual?.pendingUrl ?? actual?.url)) throw new LoginRequired('Sign in to X in this browser profile, then refresh this column.');
    throw new CancelledJob('The X source changed before it could be read.');
  }
  const runtime = await sourceWindowRuntime(job);
  if (await inspectingSource(tab, runtime.sourceWindowId)) {
    if (tab.windowId === runtime.sourceWindowId) throw new Error('The source window is open in X. Switch back to TDeck before refreshing or loading older posts.');
    return false;
  }
  let window = await verifiedSourceWindow(runtime);
  if (window) usableSourceWindow(window);
  if (!window) {
    // Move only the individually verified source tab. Never create a window
    // from an unrelated tab, or infer ownership from a persisted window ID.
    source = await checkJob(job); tab = await ownedTab(source);
    if (!tab || tab.id !== tabId || await inspectingSource(tab)) throw new CancelledJob('The X source is being inspected. Return to TDeck and refresh.');
    window = await chrome.windows.create({ tabId, focused: false, type: 'normal', state: 'normal', width: 1_100, height: 850 });
    if (window?.id === undefined) throw new Error('The TDeck source window could not be opened.');
    const windowId = window.id;
    const claimed = await transaction((state, current) => {
      if (!currentJob(state, current, job)) return false;
      current.sourceWindowId = windowId;
      return true;
    });
    if (!claimed) { await cleanupUnclaimed(source); throw new CancelledJob(); }
    usableSourceWindow(window);
  }
  const windowId = window.id!;
  source = await checkJob(job); tab = await ownedTab(source);
  if (!tab || tab.id !== tabId) throw new CancelledJob('The X source changed before entering its source window.');
  if (tab.windowId !== windowId) {
    if (await inspectingSource(tab)) throw new CancelledJob('The source is open in X. Return to TDeck and refresh.');
    await chrome.tabs.move(tabId, { windowId, index: -1 });
  }
  job.windowId = windowId;
  // Migrate legacy inactive marked sources, one tab at a time. Other browser
  // tabs and any source the user is actively inspecting stay where they are.
  for (const candidate of Object.values(runtime.sources)) {
    if (candidate.tabId === undefined || candidate.tabId === tabId) continue;
    const other = await ownedTab(candidate);
    if (!other || other.windowId === windowId || await inspectingSource(other)) continue;
    const current = await sourceWindowRuntime(job);
    if (!Object.values(current.sources).some(source => source.tabId === candidate.tabId && source.generation === candidate.generation && source.expectedUrl === candidate.expectedUrl)) continue;
    await checkSourceWindow(job, tabId, true);
    await chrome.tabs.move(other.id!, { windowId, index: -1 });
  }
  await checkSourceWindow(job, tabId, true);
  if (!(await chrome.tabs.get(tabId)).active) await chrome.tabs.update(tabId, { active: true });
  await checkSourceWindow(job, tabId);
  return true;
}

async function checkSourceWindow(job: Job, tabId: number, allowInactive = false): Promise<void> {
  if (job.windowId === undefined) return;
  const runtime = await sourceWindowRuntime(job);
  const window = await verifiedSourceWindow(runtime);
  const tab = await ownedTab(await checkJob(job));
  if (!tab) {
    const actual = await chrome.tabs.get(tabId).catch(() => undefined);
    if (loginPage(actual?.pendingUrl ?? actual?.url)) throw new LoginRequired('Sign in to X in this browser profile, then refresh this column.');
  }
  if (!window || window.id !== job.windowId || tab?.id !== tabId || tab.windowId !== window.id) throw new CancelledJob('The source window changed. Refresh this column to reconnect.');
  usableSourceWindow(window);
  if (!allowInactive && !tab.active) throw new CancelledJob('Another source became active while this column was loading. Refresh this column again.');
}

async function wakeSource(source: Source): Promise<void> {
  const tab = await ownedTab(source);
  if (!tab) return;
  const groupId = await transaction((_state, runtime) => runtime.groupId);
  if (groupId === undefined || tab.groupId !== groupId) {
    if ((tab as chrome.tabs.Tab & { frozen?: boolean }).frozen) throw new Error('The X source is frozen. Expand its tab group or open the source, then refresh.');
    return;
  }
  // Chromium can freeze tabs in collapsed groups even when autoDiscardable is
  // false. Keep only our own source group expanded while collecting.
  let finish!: () => void;
  const awake = new Promise<void>(resolve => { finish = resolve; });
  const updated = (id: number, change: chrome.tabs.TabChangeInfo & { frozen?: boolean }) => { if (id === tab.id && change.frozen === false) finish(); };
  chrome.tabs.onUpdated.addListener(updated);
  try {
    await chrome.tabGroups.update(groupId, { collapsed: false });
    const current = await chrome.tabs.get(tab.id!);
    if (!(current as chrome.tabs.Tab & { frozen?: boolean }).frozen) finish();
    await withTimeout(awake, 3_000);
  } finally { chrome.tabs.onUpdated.removeListener(updated); }
}

function invalidateSource(runtime: Runtime, columnId: string) {
  const source = runtime.sources[columnId];
  if (source) { source.generation = token(); source.requested = undefined; source.requestedAt = undefined; }
  if (runtime.busy?.columnId === columnId) runtime.busy = undefined;
}

function pauseColumn(state: DeckState, runtime: Runtime, column: ColumnConfig) {
  const feed = state.feeds[column.id], source = runtime.sources[column.id] ??= newSource(column);
  if (feed.status !== 'paused') source.pausedStatus = feed.status;
  invalidateSource(runtime, column.id);
  feed.status = 'paused'; feed.loadingOlder = false;
}

function resumeColumn(state: DeckState, runtime: Runtime, column: ColumnConfig) {
  const feed = state.feeds[column.id], source = runtime.sources[column.id];
  if (feed.status !== 'paused') return;
  const previous = source?.pausedStatus;
  feed.status = previous && previous !== 'loading' ? previous : feed.error ? 'error' : feed.lastUpdated ? 'ready' : 'idle';
  feed.nextRefresh = Date.now();
  if (source) source.pausedStatus = undefined;
}

function currentJob(state: DeckState, runtime: Runtime, job: Job): Source | undefined {
  const column = state.columns.find(item => item.id === job.column.id);
  const source = runtime.sources[job.column.id];
  if (runtime.busy?.token === job.token && source?.generation === job.source.generation && !source.suspended
    && column && sourceUrl(column) === sourceUrl(job.column)) return source;
}

class CancelledJob extends Error {}
class SourceTimeout extends Error {}
class LoginRequired extends Error {}
class InvalidSourceResponse extends Error {}

function loginPage(url: string | undefined): boolean {
  try { const parsed = new URL(url ?? ''); return parsed.origin === 'https://x.com' && ['/login', '/i/flow/login'].includes(parsed.pathname); }
  catch { return false; }
}
async function checkJob(job: Job): Promise<Source> {
  const source = await transaction((state, runtime) => {
    const current = currentJob(state, runtime, job);
    return current && !state.settings.paused && !state.columns.find(column => column.id === job.column.id)?.paused ? structuredClone(current) : undefined;
  });
  if (!source) throw new CancelledJob('This column changed while its source was loading.');
  return source;
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new SourceTimeout('The X source did not respond. Open it in X, then refresh this column.')), milliseconds);
    })]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}

async function waitForPage(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); chrome.tabs.onRemoved.removeListener(removed); resolve(); };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => { if (id === tabId && info.status === 'complete') finish(); };
    const removed = (id: number) => { if (id === tabId) finish(); };
    const timeout = setTimeout(finish, 12_000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    // Cover a completion between the first get and listener registration.
    void chrome.tabs.get(tabId).then(current => { if (current.status === 'complete') finish(); }, finish);
  });
}

async function documentIdentity(tabId: number): Promise<{ token: string } | undefined> {
  try {
    const value: unknown = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'TDECK_DOCUMENT' }, { frameId: 0 }), 2_000);
    if (object(value) && typeof value.documentToken === 'string' && /^[\w-]{1,80}$/.test(value.documentToken)) return { token: value.documentToken };
  } catch { /* A just-created or unloading document may not have a receiver. */ }
}

async function reloadDocument(job: Job, tabId: number): Promise<{ token: string; documentId?: string }> {
  await checkSourceWindow(job, tabId);
  await wakeSource(await checkJob(job));
  const previous = await documentIdentity(tabId);
  await checkJob(job);
  const source = await ownedTab(job.source);
  if (!source || source.id !== tabId) throw new CancelledJob('The source navigated away before refresh.');
  if (await inspectingSource(source, job.windowId)) {
    if (previous) return previous;
    throw new Error('The source is open in X. Switch back to TDeck and refresh.');
  }
  let loading = false, complete = false;
  let identity: { token: string; documentId?: string } | undefined;
  let resolve!: (identity: { token: string; documentId?: string }) => void;
  let reject!: (error: Error) => void;
  const navigation = new Promise<{ token: string; documentId?: string }>((done, failed) => { resolve = done; reject = failed; });
  const accept = (next: { token: string; documentId?: string }) => {
    if (!loading || next.token === previous?.token) return;
    identity = next;
    if (complete) resolve(next);
  };
  const updated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId) return;
    if (info.status === 'loading') loading = true;
    if (info.status === 'complete' && loading) {
      complete = true;
      if (identity) resolve(identity);
      else void documentIdentity(tabId).then(current => { if (current) accept(current); });
    }
  };
  const removed = (id: number) => { if (id === tabId) reject(new CancelledJob('The source tab was closed during refresh.')); };
  const ready = (message: unknown, sender: chrome.runtime.MessageSender) => {
    if (object(message) && message.type === 'TDECK_DOCUMENT_READY' && typeof message.documentToken === 'string' && /^[\w-]{1,80}$/.test(message.documentToken)
      && sender.id === chrome.runtime.id && sender.tab?.id === tabId && sender.frameId === 0 && sameSource(sender.url, job.source.expectedUrl)) {
      accept({ token: message.documentToken, documentId: sender.documentId });
    }
    return false;
  };
  // Register before initiating reload: its Promise acknowledges the API call,
  // not a new document. An old `complete` tab is never sufficient evidence.
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved.addListener(removed);
  chrome.runtime.onMessage.addListener(ready);
  try {
    const awaited = withTimeout(navigation, 22_000);
    const reload = chrome.tabs.reload(tabId).catch(error => { reject(error); throw error; });
    return (await Promise.all([reload, awaited]))[1];
  } finally {
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.tabs.onRemoved.removeListener(removed);
    chrome.runtime.onMessage.removeListener(ready);
  }
}

async function cleanupUnclaimed(source: Source) {
  const claimed = await transaction((_state, runtime) => Object.values(runtime.sources).some(current => current.tabId === source.tabId));
  if (!claimed) await removeOwned(source);
}

async function createSource(job: Job): Promise<chrome.tabs.Tab> {
  await checkJob(job);
  if (!job.navigationReserved) throw new Error('The source changed before pagination. Refresh this column to reconnect.');
  const expectedUrl = sourceUrl(job.column, true);
  const tab = await chrome.tabs.create({ url: expectedUrl, active: false });
  if (tab.id === undefined) throw new Error('Could not open the X source tab.');
  const created = { ...job.source, tabId: tab.id, expectedUrl };
  try {
    // Record ownership before optional tab decoration. A column can be removed
    // while tabs.create is pending, so the claim must still match this job.
    const claim = await transaction((state, runtime) => {
      const source = currentJob(state, runtime, job);
      if (!source) return undefined;
      source.tabId = tab.id;
      return true;
    });
    if (!claim) throw new CancelledJob('The column changed before its source opened.');
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* Optional. */ }
    await checkJob(job);
    return tab;
  } catch (error) {
    await cleanupUnclaimed(created);
    throw error;
  }
}

function validSnapshot(value: unknown): SourceSnapshot {
  if (!object(value) || typeof value.pageUrl !== 'string' || !Array.isArray(value.posts) || typeof value.hasMore !== 'boolean'
    || !['ready', 'empty', 'loading', 'login-required', 'rate-limited', 'error'].includes(String(value.status))) {
    throw new InvalidSourceResponse('The X source returned an unreadable response. Refresh this column.');
  }
  const posts = value.posts.slice(0, 300).map(sanitizePost).filter((post): post is NonNullable<typeof post> => !!post);
  if (value.posts.length && !posts.length && (value.status === 'ready' || value.status === 'empty')) {
    throw new InvalidSourceResponse('The X source returned unreadable posts. Your cached posts are still available.');
  }
  return {
    pageUrl: value.pageUrl.slice(0, 4_000), posts: dedupePosts(posts), hasMore: value.hasMore,
    status: value.status as SourceSnapshot['status'], error: typeof value.error === 'string' ? value.error.slice(0, 500) : undefined,
    documentToken: typeof value.documentToken === 'string' ? value.documentToken.slice(0, 80) : undefined,
  };
}

async function readSource(job: Job, tabId: number, type: 'TDECK_READ' | 'TDECK_SCROLL'): Promise<SourceSnapshot> {
  await wakeSource(await checkJob(job));
  await waitForPage(tabId);
  const attempt = async () => {
    await checkSourceWindow(job, tabId);
    const source = await checkJob(job);
    const tab = await ownedTab(source);
    if (!tab || tab.id !== tabId) {
      const current = await chrome.tabs.get(tabId);
      if (loginPage(current.pendingUrl ?? current.url)) throw new LoginRequired('Sign in to X in this browser profile, then refresh this column.');
      throw new CancelledJob('The source navigated away from this column.');
    }
    if (type === 'TDECK_SCROLL' && await inspectingSource(tab, job.windowId)) throw new Error('The source is open in X. Switch back to TDeck before loading older posts.');
    const remaining = Math.min(RESPONSE_TIMEOUT, JOB_LEASE - 5_000 - (Date.now() - job.since));
    if (remaining <= 0) throw new SourceTimeout('This refresh took too long. Refresh the column to retry.');
    return withTimeout(chrome.tabs.sendMessage(tabId, { type, expiresAt: Date.now() + remaining }, job.document?.documentId ? { documentId: job.document.documentId } : { frameId: 0 }), remaining);
  };
  let raw: unknown;
  try { raw = await attempt(); }
  catch (error) {
    if (error instanceof CancelledJob || error instanceof SourceTimeout || error instanceof LoginRequired) throw error;
    await new Promise(resolve => setTimeout(resolve, 350));
    raw = await attempt();
  }
  const snapshot = validSnapshot(raw);
  if (job.document && snapshot.documentToken !== job.document.token) throw new InvalidSourceResponse('The X source document changed during refresh. Refresh this column again.');
  return snapshot;
}

async function collect(job: Job): Promise<SourceSnapshot> {
  const { column, older } = job;
  const knownIds = new Set(job.known);
  const source = await checkJob(job);
  let tab = await ownedTab(source);
  if (!tab && source.tabId !== undefined) {
    const current = await chrome.tabs.get(source.tabId).catch(() => undefined);
    if (current && loginPage(current.pendingUrl ?? current.url)) throw new LoginRequired('Sign in to X in this browser profile, then refresh this column.');
  }
  const existing = !!tab;
  if (!tab) tab = await createSource(job);
  const managed = await prepareSourceWindow(job, tab.id!);
  if (existing && !older && managed) {
    await checkJob(job);
    tab = await ownedTab(source);
    if (!tab) throw new Error('The source navigated away. Refresh this column to reconnect.');
    job.document = await reloadDocument(job, tab.id!);
  }
  const tabId = tab.id!;
  let snapshot = await readSource(job, tabId, 'TDECK_READ');
  if (!sameSource(snapshot.pageUrl, sourceUrl(column), false)) {
    if (snapshot.status === 'login-required') return snapshot;
    throw new Error('The source navigated away from this column. Refresh to open its search again.');
  }
  // X can briefly render its generic error placeholder during a fresh load.
  // Retry only that transient state once, on the worker's unthrottled clock;
  // login requirements and rate limits are never retried here.
  if (snapshot.status === 'error' && snapshot.posts.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 1_200));
    snapshot = await readSource(job, tabId, 'TDECK_READ');
    if (!sameSource(snapshot.pageUrl, sourceUrl(column), false)) {
      if (snapshot.status === 'login-required') return snapshot;
      throw new InvalidSourceResponse('The X source changed during refresh. Refresh this column again.');
    }
  }
  if (!['ready', 'empty'].includes(snapshot.status)) return snapshot;
  let collected = snapshot.posts;
  // Refresh commits the current rendered search promptly. Older loading alone
  // advances X pagination, keeping new arrivals independent of backfill delays.
  const steps = older ? 4 : 0;
  for (let step = 0; step < steps && snapshot.hasMore; step++) {
    const current = await ownedTab(await checkJob(job));
    if (!current || current.id !== tabId) throw new Error('The X source changed while loading. Refresh this column.');
    if (await inspectingSource(current, job.windowId)) break;
    try { snapshot = await readSource(job, tabId, 'TDECK_SCROLL'); }
    catch (error) {
      if (error instanceof CancelledJob || error instanceof InvalidSourceResponse) throw error;
      return {
        ...snapshot, posts: collected, status: error instanceof LoginRequired ? 'login-required' : 'error',
        error: error instanceof Error ? error.message : 'Older posts could not be loaded. Your cached posts are still available.',
      };
    }
    if (!sameSource(snapshot.pageUrl, sourceUrl(column), false)) throw new Error('The X source changed while loading. Refresh this column.');
    collected = dedupePosts([...snapshot.posts, ...collected]);
    if (!['ready', 'empty'].includes(snapshot.status)) break;
    if (older && snapshot.posts.some(post => !knownIds.has(post.id))) break;
  }
  return { ...snapshot, posts: collected };
}

async function pumpOnce(): Promise<boolean> {
  const job = await transaction(async (state, runtime): Promise<Job | undefined> => {
    const now = Date.now();
    if (runtime.busy && now - runtime.busy.since < JOB_LEASE) return;
    if (runtime.busy) {
      const feed = state.feeds[runtime.busy.columnId];
      const source = runtime.sources[runtime.busy.columnId];
      if (feed) { feed.status = state.settings.paused || state.columns.find(column => column.id === runtime.busy?.columnId)?.paused ? 'paused' : 'error'; feed.error = 'A refresh was interrupted. Retrying automatically.'; feed.loadingOlder = false; }
      if (source && !source.suspended) { source.requested ??= runtime.busy.older ? 'older' : 'refresh'; source.requestedAt ??= now; }
      runtime.busy = undefined;
    }
    if (!state.connected || state.settings.paused || runtime.cooldownUntil > now) return;
    const due = state.columns.filter(column => {
      const source = runtime.sources[column.id];
      return !column.paused && !source?.suspended && (source?.requested || (state.feeds[column.id]?.nextRefresh ?? 0) <= now);
    }).sort((a, b) => {
      const sa = runtime.sources[a.id], sb = runtime.sources[b.id];
      if (!!sa?.requested !== !!sb?.requested) return sa?.requested ? -1 : 1;
      const da = sa?.requested ? sa.requestedAt ?? 0 : state.feeds[a.id]?.nextRefresh ?? 0;
      const db = sb?.requested ? sb.requestedAt ?? 0 : state.feeds[b.id]?.nextRefresh ?? 0;
      return da - db;
    });
    for (const column of due) {
      const source = runtime.sources[column.id] ??= newSource(column);
      const older = source.requested === 'older';
      const tab = await ownedTab(source);
      const feed = state.feeds[column.id] ??= structuredClone(EMPTY_FEED);
      const inspecting = tab && await inspectingSource(tab, runtime.sourceWindowId);
      if (inspecting && !source.requested) { feed.nextRefresh = now + 30_000; continue; }
      if (inspecting && older) {
        source.requested = undefined; source.requestedAt = undefined;
        feed.loadingOlder = false; feed.status = 'error'; feed.nextRefresh = now + 30_000;
        feed.error = 'The source is open in X. Switch back to TDeck before loading older posts.';
        continue;
      }
      const healthyOlder = older && tab?.status === 'complete' && !tab.pendingUrl && !tab.discarded && !(tab as chrome.tabs.Tab & { frozen?: boolean }).frozen;
      if (runtime.nextNavigation > now && !healthyOlder) continue;
      source.requested = undefined;
      source.requestedAt = undefined;
      const jobToken = token();
      runtime.busy = { token: jobToken, generation: source.generation, columnId: column.id, since: now, older };
      if (!healthyOlder) runtime.nextNavigation = now + NAVIGATION_GAP;
      if (older) feed.loadingOlder = true;
      else feed.status = 'loading';
      feed.error = undefined;
      return { token: jobToken, column: structuredClone(column), source: structuredClone(source), older, navigationReserved: !healthyOlder, since: now, known: [...feed.posts, ...feed.pending].map(p => p.id) };
    }
  });
  if (!job) return false;
  let snapshot: SourceSnapshot;
  try { snapshot = await collect(job); }
  catch (error) {
    snapshot = { posts: [], status: error instanceof LoginRequired ? 'login-required' : 'error', hasMore: true, pageUrl: sourceUrl(job.column), error: error instanceof Error ? error.message : 'The source could not be read.' };
  }
  await transaction((state, runtime) => {
    const source = currentJob(state, runtime, job);
    if (runtime.busy?.token === job.token) runtime.busy = undefined;
    if (!source) return;
    const current = state.columns.find(column => column.id === job.column.id);
    if (!current) return;
    const previous = state.feeds[current.id] ?? structuredClone(EMPTY_FEED);
    const posts = Array.isArray(snapshot.posts) ? snapshot.posts.map(sanitizePost).filter((post): post is NonNullable<typeof post> => !!post) : [];
    const feed = mergeFeed(previous, posts, state.settings.arrivalMode, job.older);
    feed.loadingOlder = false;
    if (snapshot.status === 'ready' || snapshot.status === 'empty') {
      source.failures = 0;
      feed.status = state.settings.paused || current.paused ? 'paused' : 'ready';
      feed.error = undefined;
      if (!job.older) feed.lastUpdated = Date.now();
      feed.nextRefresh = Date.now() + current.refreshSeconds * 1000;
      feed.hasMore = snapshot.hasMore && feed.posts.length < MAX_POSTS;
    } else {
      source.failures += 1;
      feed.status = state.settings.paused || current.paused ? 'paused' : snapshot.status === 'loading' ? 'error' : snapshot.status;
      feed.error = snapshot.error ?? ({
        loading: 'X is still loading. Open the source in X, then refresh this column.',
        'login-required': 'Sign in to X in this browser profile, then refresh this column.',
        'rate-limited': 'X has temporarily limited searches. Refreshes will resume after a cooldown.',
        error: 'X could not load this feed. Your cached posts are still available.',
      }[snapshot.status]);
      const delay = Math.min(1800, 60 * 2 ** Math.min(source.failures, 5));
      feed.nextRefresh = Date.now() + delay * 1000;
      if (snapshot.status === 'rate-limited') {
        runtime.cooldownUntil = Date.now() + Math.max(300, delay) * 1000;
        feed.nextRefresh = runtime.cooldownUntil;
      }
      if (snapshot.status === 'login-required') { source.suspended = true; source.requested = undefined; source.requestedAt = undefined; feed.nextRefresh = undefined; }
    }
    if (feed.posts.length >= MAX_POSTS) feed.hasMore = false;
    if (source.requested && !state.settings.paused && !current.paused) {
      if (source.requested === 'older') feed.loadingOlder = true;
      else feed.status = 'loading';
    }
    state.feeds[current.id] = feed;
  });
  return true;
}

async function scheduleWake() {
  const when = await transaction((state, runtime) => {
    if (!state.connected || state.settings.paused) return undefined;
    const now = Date.now();
    if (runtime.busy) return Math.max(now + 500, runtime.busy.since + JOB_LEASE);
    const deadlines = state.columns.filter(column => !column.paused && !runtime.sources[column.id]?.suspended).map(column => {
      const source = runtime.sources[column.id];
      const due = source?.requested ? now : state.feeds[column.id]?.nextRefresh ?? now;
      const navigation = source?.requested === 'older' && source.tabId !== undefined ? now : runtime.nextNavigation;
      return Math.max(now + 500, due, navigation, runtime.cooldownUntil);
    });
    return deadlines.length ? Math.min(...deadlines) : undefined;
  });
  // One-shot alarms may be delayed to Chrome's minimum interval. The recurring
  // alarm also survives worker termination and remains the recovery fallback.
  if (when === undefined) await chrome.alarms.clear(WAKE_ALARM);
  else await chrome.alarms.create(WAKE_ALARM, { when });
}

function kick() {
  if (activePump) return activePump;
  activePump = (async () => {
    // Finish ready work queued while a read was in flight. Navigation limits
    // stop this loop; future work is recorded in alarms before the worker idles.
    while (await pumpOnce()) { /* Work and scheduler state are persisted per job. */ }
  })().catch(error => console.warn('TDeck refresh failed:', error instanceof Error ? error.message : 'Unknown error'))
    .finally(async () => {
      activePump = undefined;
      try { await scheduleWake(); } catch { /* The recurring alarm is the fallback if a one-shot cannot be saved. */ }
    });
  return activePump;
}

const listsMarker = (job: ListsJob) => `#tdeck-lists=${job.token}`;
const ownListsUrl = (job: ListsJob) => `https://x.com/${job.handle}/lists${listsMarker(job)}`;

function ownedListsUrl(url: string | undefined, job: ListsJob): boolean {
  try { const parsed = new URL(url ?? ''); return parsed.origin === 'https://x.com' && !parsed.username && !parsed.password && parsed.hash === listsMarker(job); }
  catch { return false; }
}

function sameListsDirectory(url: string | undefined, job: ListsJob): boolean {
  try {
    const parsed = new URL(url ?? '');
    return parsed.origin === 'https://x.com' && !parsed.username && !parsed.password && parsed.pathname === `/${job.handle}/lists`;
  } catch { return false; }
}

function numericListUrl(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(url ?? '');
    return parsed.origin === 'https://x.com' && !parsed.username && !parsed.password ? parsed.pathname.match(/^\/i\/lists\/(\d{1,25})\/?$/)?.[1] : undefined;
  } catch { return undefined; }
}

async function cleanupListsTab(job: ListsJob) {
  if (job.tabId === undefined) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (!tab.active && ownedListsUrl(tab.pendingUrl ?? tab.url, job)) await chrome.tabs.remove(job.tabId);
  } catch { /* A closed or user-navigated tab is left alone. */ }
}

async function currentListsJob(job: ListsJob): Promise<ListsJob> {
  const current = await transaction((_state, runtime) => runtime.listsJob?.token === job.token ? structuredClone(runtime.listsJob) : undefined);
  if (!current) throw new CancelledJob('List discovery was cancelled. Load your lists again.');
  return current;
}

async function listTab(job: ListsJob): Promise<chrome.tabs.Tab> {
  const current = await currentListsJob(job);
  if (current.tabId === undefined) throw new Error('The list discovery tab is unavailable. Try again.');
  const tab = await chrome.tabs.get(current.tabId);
  if (loginPage(tab.pendingUrl ?? tab.url)) throw new LoginRequired('Sign in to X in this browser profile, then load your lists again.');
  if (!ownedListsUrl(tab.pendingUrl ?? tab.url, current)) throw new Error('The list discovery tab navigated away. Load your lists again.');
  return tab;
}

async function listMessage(job: ListsJob, request: SourceRequest): Promise<unknown> {
  let tab = await listTab(job);
  await waitForPage(tab.id!);
  const attempt = async () => {
    tab = await listTab(job);
    if ((request.type === 'TDECK_SELECT_LIST' || (request.type === 'TDECK_LISTS' && request.scroll)) && tab.active) {
      throw new Error('Switch back to TDeck so it can finish reading your lists.');
    }
    const remaining = Math.min(RESPONSE_TIMEOUT, LISTS_LEASE - (Date.now() - job.since));
    if (remaining <= 0) throw new SourceTimeout('X took too long to load your lists. Try again.');
    return withTimeout(chrome.tabs.sendMessage(tab.id!, request, { frameId: 0 }), remaining);
  };
  try { return await attempt(); }
  catch (error) {
    if (error instanceof CancelledJob || error instanceof SourceTimeout || error instanceof LoginRequired || request.type === 'TDECK_SELECT_LIST') throw error;
    await new Promise(resolve => setTimeout(resolve, 350));
    return attempt();
  }
}

function listResponse(value: unknown): Record<string, unknown> {
  if (!object(value) || typeof value.pageUrl !== 'string' || !['ready', 'loading', 'login-required', 'error'].includes(String(value.status))) throw new Error('X returned an unreadable list response. Try again.');
  if (value.status === 'login-required') throw new LoginRequired('Sign in to X in this browser profile, then load your lists again.');
  if (value.status !== 'ready') throw new Error(typeof value.error === 'string' ? value.error.slice(0, 500) : 'X could not finish loading your lists. Try again.');
  return value;
}

async function resolveSelectedList(job: ListsJob): Promise<string> {
  const raw = listResponse(await listMessage(job, { type: 'TDECK_SELECT_LIST', selectionKey: job.selectionKey! })) as unknown as ListSelectionSnapshot;
  const id = numericListUrl(raw.pageUrl);
  const tab = await chrome.tabs.get((await currentListsJob(job)).tabId!);
  if (!id || id !== raw.id || numericListUrl(tab.pendingUrl ?? tab.url) !== id) throw new Error('X did not open the selected list. Load your lists again.');
  // X's ordinary card navigation can drop the fragment. Only reclaim the
  // verified destination of our explicit click, in the same inactive tab.
  if (!tab.active && !ownedListsUrl(tab.pendingUrl ?? tab.url, job)) {
    await chrome.tabs.update(tab.id!, { url: `https://x.com/i/lists/${id}${listsMarker(job)}` });
  }
  return id;
}

async function performLists(selectionKey?: string): Promise<void> {
  let retired: ListsJob | undefined;
  let job = await transaction((state, runtime) => {
    if (selectionKey && !(state.lists ?? []).some(list => list.selectionKey === selectionKey)) throw new Error('That list is no longer available. Load your lists again.');
    if (runtime.listsJob && runtime.listsJob.selectionKey !== selectionKey) { retired = structuredClone(runtime.listsJob); runtime.listsJob = undefined; }
    runtime.listsJob ??= { token: token(), since: Date.now(), selectionKey, screens: 0, lists: [] };
    runtime.listsJob.since = Date.now();
    state.listsStatus = 'loading'; state.listsError = undefined;
    return structuredClone(runtime.listsJob);
  });
  if (retired) await cleanupListsTab(retired);
  try {
    if (job.tabId !== undefined) {
      const existing = await chrome.tabs.get(job.tabId).catch(() => undefined);
      if (!existing || !ownedListsUrl(existing.pendingUrl ?? existing.url, job)) {
        // Reusing a persisted job never grants control over a replacement tab.
        job = await transaction((_state, runtime) => {
          if (runtime.listsJob?.token !== job.token) throw new CancelledJob();
          Object.assign(runtime.listsJob, { tabId: undefined, handle: undefined, screens: 0, lists: [] });
          return structuredClone(runtime.listsJob);
        });
      }
    }
    if (job.tabId === undefined) {
      const created = await chrome.tabs.create({ url: `https://x.com/home${listsMarker(job)}`, active: false });
      if (created.id === undefined) throw new Error('Could not open X to read your lists.');
      const owned = { ...job, tabId: created.id };
      const claimed = await transaction((_state, runtime) => {
        if (runtime.listsJob?.token !== job.token) return undefined;
        runtime.listsJob.tabId = created.id;
        return structuredClone(runtime.listsJob);
      });
      if (!claimed) { await cleanupListsTab(owned); throw new CancelledJob(); }
      job = claimed;
    }
    if (!job.handle) {
      const raw = listResponse(await listMessage(job, { type: 'TDECK_PROFILE' })) as unknown as ProfileSnapshot;
      if (!raw.handle || !/^[A-Za-z0-9_]{1,15}$/.test(raw.handle) || raw.listUrl !== `https://x.com/${raw.handle}/lists`) throw new Error('The signed-in X profile could not be identified. Open X, then try again.');
      job = await transaction((_state, runtime) => {
        if (runtime.listsJob?.token !== job.token) throw new CancelledJob();
        runtime.listsJob.handle = raw.handle;
        return structuredClone(runtime.listsJob);
      });
      const tab = await listTab(job);
      if (tab.active) throw new Error('Switch back to TDeck so it can open your lists.');
      await chrome.tabs.update(tab.id!, { url: ownListsUrl(job) });
    }
    let resolvedId: string | undefined;
    // The count is persisted before each screen request, so a restarted worker
    // cannot reset the scrolling budget of an already-pending discovery.
    while (job.screens < 3) {
      const scroll = job.screens > 0;
      job = await transaction((_state, runtime) => {
        if (runtime.listsJob?.token !== job.token) throw new CancelledJob();
        runtime.listsJob.screens += 1;
        return structuredClone(runtime.listsJob);
      });
      const raw = listResponse(await listMessage(job, { type: 'TDECK_LISTS', scroll })) as unknown as ListSnapshot;
      // Parser snapshots deliberately omit fragments. Verify their directory
      // separately from ownership of the current browser tab after the read.
      const actual = await listTab(job);
      if (!Array.isArray(raw.lists) || typeof raw.hasMore !== 'boolean' || !sameListsDirectory(raw.pageUrl, job)
        || !sameListsDirectory(actual.pendingUrl ?? actual.url, job)) throw new Error('X returned an unreadable list directory. Try again.');
      const discovered = sanitizeLists(raw.lists);
      job = await transaction((_state, runtime) => {
        if (runtime.listsJob?.token !== job.token) throw new CancelledJob();
        runtime.listsJob.lists = sanitizeLists([...runtime.listsJob.lists, ...discovered]);
        return structuredClone(runtime.listsJob);
      });
      if (selectionKey && discovered.some(list => list.selectionKey === selectionKey)) { resolvedId = await resolveSelectedList(job); break; }
      if (!raw.hasMore) break;
    }
    if (selectionKey && !resolvedId) throw new Error('That list was not found in the loaded directory. Reload your lists and try again.');
    await transaction((state, runtime) => {
      if (runtime.listsJob?.token !== job.token) return;
      if (selectionKey) state.lists = sanitizeLists((state.lists ?? []).map(list => list.selectionKey === selectionKey ? { ...list, id: resolvedId! } : list));
      else {
        const known = new Map((state.lists ?? []).filter(list => /^\d{1,25}$/.test(list.id) && list.selectionKey).map(list => [list.selectionKey, list.id]));
        state.lists = sanitizeLists(job.lists.map(list => known.has(list.selectionKey) ? { ...list, id: known.get(list.selectionKey)! } : list));
      }
      state.listsStatus = 'ready'; state.listsError = undefined;
      runtime.listsJob = undefined;
    });
  } catch (error) {
    await transaction((state, runtime) => {
      if (runtime.listsJob?.token !== job.token) return;
      state.listsStatus = error instanceof LoginRequired ? 'login-required' : 'error';
      state.listsError = error instanceof SourceTimeout ? 'X did not respond while loading your lists. Try again.' : error instanceof Error && error.message ? error.message.slice(0, 500) : 'Your lists could not be loaded. Try again.';
      runtime.listsJob = undefined;
    });
    throw error;
  } finally { await cleanupListsTab(job); }
}

function startLists(selectionKey?: string): Promise<void> {
  if (activeLists) return activeLists.selectionKey === selectionKey ? activeLists.promise : Promise.reject(new Error('Your lists are still loading. Try again when discovery finishes.'));
  const promise = performLists(selectionKey).finally(() => { activeLists = undefined; });
  activeLists = { selectionKey, promise };
  return promise;
}

async function recoverLists() {
  const expired = await transaction((state, runtime) => {
    if (!runtime.listsJob || Date.now() - runtime.listsJob.since < LISTS_LEASE) return undefined;
    const job = structuredClone(runtime.listsJob);
    runtime.listsJob = undefined;
    state.listsStatus = 'error'; state.listsError = 'List discovery was interrupted. Load your lists again.';
    return job;
  });
  if (expired) await cleanupListsTab(expired);
}

async function handle(request: Request): Promise<Response> {
  if (!request || typeof request.type !== 'string') return { ok: false, error: 'Invalid request.' };
  try {
    await ensureAlarm();
    if (request.type === 'GET_STATE') return { ok: true, state: await getState() };
    if (request.type === 'LOAD_LISTS') {
      void startLists().catch(() => { /* The persisted list status carries the failure to the picker. */ });
      return { ok: true, state: await getState() };
    }
    if (request.type === 'RESOLVE_LIST') {
      if (typeof request.selectionKey !== 'string' || !request.selectionKey || request.selectionKey.length > 512) throw new Error('Choose a list from your X account.');
      await startLists(request.selectionKey);
      return { ok: true, state: await getState() };
    }
    const retired: Source[] = [];
    let openUrl: string | undefined;
    let openSource: Source | undefined;
    await transaction((state, runtime) => {
      const columnFor = (id: string) => {
        const column = state.columns.find(item => item.id === id);
        if (!column) throw new Error('That column no longer exists.');
        return column;
      };
      const layoutFor = (id: string) => {
        const layout = state.layouts?.find(item => item.id === id);
        if (!layout) throw new Error('That saved layout no longer exists.');
        return layout;
      };
      const layoutName = (value: unknown, id?: string) => {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Name the layout using 1–80 characters.');
        const name = value.trim();
        if (state.layouts?.some(layout => layout.id !== id && layout.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('A layout with that name already exists. Choose another name or update that layout.');
        return name;
      };
      switch (request.type) {
        case 'SAVE_COLUMNS':
        case 'IMPORT_CONFIG':
        case 'LOAD_LAYOUT': {
          const layout = request.type === 'LOAD_LAYOUT' ? layoutFor(request.layoutId) : undefined;
          const columns = validateColumns(layout ? layout.columns : request.type !== 'LOAD_LAYOUT' ? request.columns : []);
          const settings = layout ? validateSettings(layout.settings) : request.type === 'IMPORT_CONFIG' ? validateSettings(request.settings) : state.settings;
          const next = applyColumns(state, columns);
          for (const old of state.columns) {
            const replacement = columns.find(c => c.id === old.id);
            if (!replacement || sourceUrl(old) !== sourceUrl(replacement)) {
              if (runtime.sources[old.id]) retired.push(runtime.sources[old.id]);
              invalidateSource(runtime, old.id);
              delete runtime.sources[old.id];
            }
          }
          Object.assign(state, next, { settings });
          for (const column of columns) {
            const feed = state.feeds[column.id];
            if (column.paused || settings.paused) pauseColumn(state, runtime, column);
            else resumeColumn(state, runtime, column);
          }
          break;
        }
        case 'UPDATE_SETTINGS': {
          state.settings = validateSettings(request.patch, state.settings);
          for (const column of state.columns) {
            const feed = state.feeds[column.id];
            if (state.settings.arrivalMode === 'automatic' && feed.pending.length) { feed.posts = dedupePosts([...feed.pending, ...feed.posts]); feed.pending = []; }
            if (state.settings.paused || column.paused) pauseColumn(state, runtime, column);
            else resumeColumn(state, runtime, column);
          }
          break;
        }
        case 'CONNECT': {
          state.connected = true;
          state.settings.paused = false;
          for (const column of state.columns) {
            const source = runtime.sources[column.id] ??= newSource(column);
            source.suspended = false;
            if (!column.paused) resumeColumn(state, runtime, column);
            state.feeds[column.id].nextRefresh = Date.now();
          }
          break;
        }
        case 'REFRESH':
        case 'LOAD_OLDER': {
          if (request.type === 'LOAD_OLDER' && typeof request.columnId !== 'string') throw new Error('Choose a column to load older posts.');
          if (!state.connected) throw new Error('Connect X to start loading your columns.');
          if (runtime.cooldownUntil > Date.now()) throw new Error('X search is cooling down. Automatic updates will resume when the limit clears.');
          if (state.settings.paused) throw new Error('Resume updates before refreshing a column.');
          const columns = request.columnId ? [columnFor(request.columnId)] : state.columns;
          for (const column of columns) {
            if (column.paused) continue;
            if (request.type === 'LOAD_OLDER' && (!state.feeds[column.id].hasMore || state.feeds[column.id].posts.length >= MAX_POSTS)) continue;
            const source = runtime.sources[column.id] ??= newSource(column);
            source.suspended = false;
            source.requested = request.type === 'LOAD_OLDER' ? 'older' : 'refresh';
            source.requestedAt = Date.now();
            if (request.type === 'LOAD_OLDER') state.feeds[column.id].loadingOlder = true;
            else state.feeds[column.id].status = 'loading';
            state.feeds[column.id].nextRefresh = Date.now();
          }
          break;
        }
        case 'MARK_READ': {
          columnFor(request.columnId);
          const feed = state.feeds[request.columnId];
          feed.posts = dedupePosts([...feed.pending, ...feed.posts]); feed.pending = [];
          break;
        }
        case 'CLEAR_COLUMN': {
          const column = columnFor(request.columnId);
          invalidateSource(runtime, request.columnId);
          state.feeds[request.columnId] = { ...structuredClone(EMPTY_FEED), status: state.settings.paused || column.paused ? 'paused' : 'idle', nextRefresh: Date.now() + column.refreshSeconds * 1000 };
          break;
        }
        case 'OPEN_SOURCE': {
          openUrl = sourceUrl(columnFor(request.columnId));
          openSource = runtime.sources[request.columnId];
          break;
        }
        case 'SAVE_LAYOUT': {
          const existing = request.id === undefined ? undefined : layoutFor(request.id);
          const name = layoutName(request.name, existing?.id);
          const layouts = state.layouts ??= [];
          if (!existing && layouts.length >= MAX_LAYOUTS) throw new Error(`You can save up to ${MAX_LAYOUTS} layouts. Delete one before saving another.`);
          const layout = { id: existing?.id ?? token(), name, columns: structuredClone(state.columns), settings: structuredClone(state.settings), updatedAt: Date.now() };
          if (existing) layouts[layouts.indexOf(existing)] = layout;
          else layouts.unshift(layout);
          validateLayoutQuota(layouts);
          break;
        }
        case 'RENAME_LAYOUT': {
          const layout = layoutFor(request.layoutId);
          layout.name = layoutName(request.name, layout.id);
          layout.updatedAt = Date.now();
          validateLayoutQuota(state.layouts!);
          break;
        }
        case 'DELETE_LAYOUT': {
          layoutFor(request.layoutId);
          state.layouts = state.layouts!.filter(layout => layout.id !== request.layoutId);
          break;
        }
        case 'BOOKMARK_TOGGLE': {
          const post = sanitizePost(request.post);
          if (!post) throw new Error('This post could not be saved.');
          const exists = state.bookmarks.some(item => item.id === post.id);
          if (!exists && state.bookmarks.length >= 300) throw new Error('You have 300 saved posts. Remove one before saving another.');
          state.bookmarks = exists ? state.bookmarks.filter(item => item.id !== post.id) : [post, ...state.bookmarks];
          break;
        }
        default: throw new Error('Unknown TDeck request.');
      }
    });
    for (const source of retired) await removeOwned(source);
    if (openSource) {
      const tab = await ownedTab(openSource);
      if (tab?.id !== undefined) {
        // Focusing/restoring is reserved for this explicit user action.
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
        openUrl = undefined;
      }
    }
    if (openUrl) await chrome.tabs.create({ url: openUrl });
    void kick();
    return { ok: true, state: await getState() };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'TDeck could not complete this action.' }; }
}

chrome.runtime.onMessage.addListener((request: Request, sender, respond) => {
  const base = chrome.runtime.getURL('');
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(base)) return false;
  void handle(request).then(respond);
  return true;
});
chrome.action.onClicked.addListener(() => { void openDeck(); });
chrome.commands.onCommand.addListener(command => { if (command === 'open-deck') void openDeck(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM || alarm.name === WAKE_ALARM) {
    void kick();
    void recoverLists().catch(() => { /* Retry persisted cleanup on the next alarm. */ });
  }
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm().then(kick);
  void recoverLists().catch(() => { /* The alarm also recovers interrupted discoveries. */ });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void transaction((state, runtime) => {
    if (runtime.listsJob?.tabId === tabId) {
      runtime.listsJob = undefined; state.listsStatus = 'error'; state.listsError = 'The list discovery tab was closed. Load your lists again.';
    }
    for (const [id, source] of Object.entries(runtime.sources)) {
      if (source.tabId !== tabId) continue;
      invalidateSource(runtime, id);
      source.tabId = undefined;
      source.suspended = true;
      source.pausedStatus = 'error';
      const feed = state.feeds[id];
      if (feed) { feed.status = state.settings.paused || state.columns.find(column => column.id === id)?.paused ? 'paused' : 'error'; feed.error = 'Source tab closed. Refresh this column to reconnect.'; feed.loadingOlder = false; feed.nextRefresh = undefined; }
    }
  }).then(() => { void kick(); }, () => { /* A later refresh retries persistence. */ });
});
