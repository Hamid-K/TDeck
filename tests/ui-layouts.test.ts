import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { DEFAULT_SETTINGS, type DeckState, type Layout, type Post, type Request } from '../src/shared/types';
import { newColumn } from '../src/ui/config';
import { LayoutsDialog } from '../src/ui/LayoutsDialog';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options?: { url: string }) => { window: Window & typeof globalThis & { close: () => void } };
};

async function setup() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, localStorage: dom.window.localStorage,
    chrome: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  return { root, container, change(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, async close() {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  } };
}

const savedPost: Post = { id: '123456789', url: 'https://x.com/alice/status/123456789', text: 'A saved thought', author: { name: 'Alice', handle: 'alice', verified: false }, createdAt: '2026-09-14T08:00:00.000Z', media: [], counts: { replies: '', reposts: '', likes: '' }, isReply: false };

test('named layouts save, update, rename, restore and delete through explicit UI actions with persistent preview snapshots', async () => {
  const app = await setup();
  const { request } = await import('../src/ui/api');
  const alpha = { ...newColumn('search', 'space'), id: 'alpha', title: 'Space' };
  const beta = { ...newColumn('account', 'NASA'), id: 'beta', title: 'NASA', width: 440, hideReplies: true };
  let state = await request({ type: 'SAVE_COLUMNS', columns: [alpha, beta] });
  state = await request({ type: 'BOOKMARK_TOGGLE', post: savedPost });
  const requests: Request[] = [];
  let restored = 0;
  const render = () => app.root.render(createElement(LayoutsDialog, { state, send, notify: () => {}, onClose: () => {}, onRestored: () => { restored++; } }));
  async function send(message: Request) {
    requests.push(message); state = await request(message); render(); return true;
  }
  const click = async (selector: string) => { const button = app.container.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); await act(async () => button.click()); };
  try {
    await act(async () => render());
    await act(async () => app.change(app.container.querySelector<HTMLInputElement>('#layout-name')!, '  Morning read  '));
    await act(async () => { app.container.querySelector('.layout-save-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(requests, [{ type: 'SAVE_LAYOUT', name: 'Morning read' }]);
    assert.equal(state.layouts?.length, 1);
    const id = state.layouts![0].id;
    assert.deepEqual(state.layouts![0].columns, [alpha, beta]);
    assert.equal(app.container.querySelector<HTMLInputElement>('#layout-name')!.value, '');
    assert.equal((await request({ type: 'GET_STATE' })).layouts?.[0].name, 'Morning read', 'named snapshots survive fresh reads from local storage');
    await act(async () => app.change(app.container.querySelector<HTMLInputElement>('#layout-name')!, 'MORNING READ'));
    await act(async () => { app.container.querySelector('.layout-save-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(requests.length, 1, 'duplicate names do not overwrite a snapshot');
    assert.match(app.container.querySelector('[role="alert"]')?.textContent || '', /already in your saved layouts/);

    state = await request({ type: 'SAVE_COLUMNS', columns: [beta, { ...alpha, width: 520, mutedWords: ['spoiler'] }] });
    state = await request({ type: 'UPDATE_SETTINGS', patch: { theme: 'light', density: 'compact', arrivalMode: 'queue' } });
    await act(async () => render());
    assert.deepEqual(state.layouts![0].columns, [alpha, beta], 'editing the working view does not mutate the saved snapshot');
    await click('.layout-card-actions > .text-button');
    assert.equal(requests.length, 1, 'update first asks for explicit overwrite confirmation');
    assert.match(app.container.querySelector('.layout-confirm')?.textContent || '', /previous arrangement will be overwritten/);
    await click('.layout-confirm .secondary');
    assert.equal(requests.length, 1);
    await click('.layout-card-actions > .text-button');
    await click('.layout-confirm .primary');
    assert.deepEqual(requests.at(-1), { type: 'SAVE_LAYOUT', id, name: 'Morning read' });
    assert.equal(state.layouts![0].columns[0].id, 'beta');
    assert.equal(state.layouts![0].columns[1].width, 520);
    assert.deepEqual(state.layouts![0].columns[1].mutedWords, ['spoiler']);
    assert.equal(state.layouts![0].settings.theme, 'light');

    await click('button[aria-label^="Rename layout"]');
    await act(async () => app.change(app.container.querySelector<HTMLInputElement>('#rename-layout')!, 'Evening read'));
    await act(async () => { app.container.querySelector('.layout-rename')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(requests.at(-1), { type: 'RENAME_LAYOUT', layoutId: id, name: 'Evening read' });
    assert.equal(state.layouts![0].name, 'Evening read');

    state = await request({ type: 'SAVE_COLUMNS', columns: [] });
    state = await request({ type: 'UPDATE_SETTINGS', patch: { theme: 'dark', density: 'comfortable' } });
    await act(async () => render());
    const beforeRestore = requests.length;
    await click('.restore-layout');
    assert.equal(requests.length, beforeRestore);
    assert.match(app.container.querySelector('.layout-confirm')?.textContent || '', /bookmarks stay/);
    await click('.layout-confirm .primary');
    assert.deepEqual(requests.at(-1), { type: 'LOAD_LAYOUT', layoutId: id });
    assert.equal(restored, 1);
    assert.deepEqual(state.columns.map(column => column.id), ['beta', 'alpha']);
    assert.equal(state.settings.theme, 'light');
    assert.equal(state.settings.arrivalMode, 'queue');
    assert.deepEqual(state.bookmarks, [savedPost]);
    assert.equal(state.connected, false, 'restoring a layout does not fake an X connection');
    assert.equal(state.layouts?.length, 1);

    const beforeDelete = requests.length;
    await click('button[aria-label^="Delete saved layout"]');
    assert.equal(requests.length, beforeDelete);
    await click('.layout-confirm .secondary');
    assert.equal(state.layouts?.length, 1);
    await click('button[aria-label^="Delete saved layout"]');
    await click('.layout-confirm .danger');
    assert.deepEqual(requests.at(-1), { type: 'DELETE_LAYOUT', layoutId: id });
    assert.equal(state.layouts?.length, 0);
    const persisted = await request({ type: 'GET_STATE' });
    assert.equal(persisted.layouts?.length, 0);
    assert.deepEqual(persisted.columns.map(column => column.id), ['beta', 'alpha']);
    assert.deepEqual(persisted.bookmarks, [savedPost]);
  } finally { await app.close(); }
});

test('layout operations disable competing actions while pending, retain failed confirmations, and enforce the visible library cap', async () => {
  const app = await setup();
  const layout: Layout = { id: 'layout-one', name: 'Morning', columns: [], settings: DEFAULT_SETTINGS, updatedAt: 1 };
  let state: DeckState = { version: 1, connected: false, columns: [], feeds: {}, bookmarks: [], settings: DEFAULT_SETTINGS, layouts: [layout] };
  let resolve!: (value: boolean) => void;
  let restored = false;
  const send = () => new Promise<boolean>(done => { resolve = done; });
  const render = () => app.root.render(createElement(LayoutsDialog, { state, send, requestError: 'The saved layout could not be read.', notify: () => {}, onClose: () => {}, onRestored: () => { restored = true; } }));
  try {
    await act(async () => render());
    await act(async () => app.container.querySelector<HTMLButtonElement>('.restore-layout')!.click());
    await act(async () => app.container.querySelector<HTMLButtonElement>('.layout-confirm .primary')!.click());
    assert.equal(app.container.querySelector<HTMLButtonElement>('.layout-save-form button')!.disabled, true);
    assert.equal(app.container.querySelector<HTMLButtonElement>('.layout-card-actions button')!.disabled, true);
    await act(async () => resolve(false));
    assert.equal(restored, false);
    assert.match(app.container.querySelector('[role="alert"]')?.textContent || '', /could not be read/);
    assert.ok(app.container.querySelector('.layout-confirm'), 'a failed restore remains available to retry');
    assert.equal(app.container.querySelector<HTMLButtonElement>('.layout-confirm .primary')!.disabled, false);
    state = { ...state, layouts: Array.from({ length: 20 }, (_, index) => ({ ...layout, id: `layout-${index}`, name: `View ${index + 1}` })) };
    await act(async () => render());
    assert.equal(app.container.querySelector<HTMLButtonElement>('.layout-save-form button')!.disabled, true);
    assert.match(app.container.querySelector('.layout-save-form')?.textContent || '', /20 saved layouts/);
  } finally { await app.close(); }
});

test('settings export excludes posts and layout library, import waits for confirmation, and failed preference saves are visible', async () => {
  const app = await setup();
  const { request } = await import('../src/ui/api');
  const { SettingsDialog } = await import('../src/ui/Dialogs');
  const original = { ...newColumn('search', 'original'), id: 'original', title: 'Original' };
  const replacement = { ...newColumn('search', 'replacement'), id: 'replacement', title: 'Replacement' };
  let state = await request({ type: 'SAVE_COLUMNS', columns: [original] });
  state = await request({ type: 'BOOKMARK_TOGGLE', post: savedPost });
  state = await request({ type: 'SAVE_LAYOUT', name: 'Keep this layout' });
  const requests: Request[] = [];
  let rejectSettings = false;
  let exported: Blob | undefined;
  let download = '';
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: (blob: Blob) => { exported = blob; return 'blob:tdeck-export'; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} });
  window.HTMLAnchorElement.prototype.click = function () { download = this.download; };
  async function send(message: Request) {
    requests.push(message);
    if (rejectSettings && message.type === 'UPDATE_SETTINGS') return false;
    state = await request(message); render(); return true;
  }
  const render = () => app.root.render(createElement(SettingsDialog, { state, send, requestError: 'Local storage is unavailable.', notify: () => {}, onClose: () => {}, onLayouts: () => {} }));
  const importData = { app: 'tdeck', version: 1, columns: [replacement], settings: { ...DEFAULT_SETTINGS, theme: 'light' } };
  async function chooseFile(content: unknown) {
    const input = app.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const text = JSON.stringify(content);
    Object.defineProperty(input, 'files', { configurable: true, value: [{ size: text.length, text: async () => text }] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  try {
    await act(async () => render());
    const exportButton = Array.from(app.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Export settings')!;
    await act(async () => exportButton.click());
    assert.match(download, /^tdeck-workspace-.*\.json$/);
    assert.ok(exported);
    const payload = JSON.parse(await exported.text());
    assert.deepEqual(Object.keys(payload).sort(), ['app', 'columns', 'settings', 'version']);
    assert.equal(payload.columns[0].query, 'original');
    assert.equal(payload.bookmarks, undefined);
    assert.equal(payload.layouts, undefined);
    assert.equal(requests.length, 0);
    await chooseFile(importData);
    assert.ok(app.container.querySelector('.import-confirm'));
    assert.equal(requests.length, 0, 'reading a file does not replace the workspace');
    await act(async () => app.container.querySelector<HTMLButtonElement>('.import-confirm .secondary')!.click());
    assert.equal(state.columns[0].id, 'original');
    await chooseFile(importData);
    await act(async () => app.container.querySelector<HTMLButtonElement>('.import-confirm .primary')!.click());
    assert.equal(requests.at(-1)?.type, 'IMPORT_CONFIG');
    assert.equal(state.columns[0].id, 'replacement');
    assert.equal(state.settings.theme, 'light');
    assert.deepEqual(state.bookmarks, [savedPost]);
    assert.equal(state.layouts?.[0].name, 'Keep this layout');
    const beforeInvalid = requests.length;
    await chooseFile({ ...importData, columns: [{ ...replacement, id: '__proto__' }] });
    assert.equal(requests.length, beforeInvalid);
    assert.match(app.container.querySelector('[role="alert"]')?.textContent || '', /unique and valid/);
    rejectSettings = true;
    const dark = Array.from(app.container.querySelectorAll<HTMLButtonElement>('.theme-picker button')).find(button => button.textContent === 'Dark')!;
    await act(async () => dark.click());
    assert.equal(state.settings.theme, 'light', 'failed saves do not claim a new theme');
    assert.match(app.container.querySelector('.settings-save-error')?.textContent || '', /Local storage is unavailable/);
  } finally {
    if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor); else Reflect.deleteProperty(URL, 'createObjectURL');
    if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor); else Reflect.deleteProperty(URL, 'revokeObjectURL');
    await app.close();
  }
});
