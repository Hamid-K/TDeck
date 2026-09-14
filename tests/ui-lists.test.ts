import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { DEFAULT_SETTINGS, type DeckState, type Request, type Response, type XList } from '../src/shared/types';
import { newColumn } from '../src/ui/config';
import { ListPicker } from '../src/ui/ListPicker';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options?: { url: string }) => { window: Window & typeof globalThis & { close: () => void } };
};

async function setup() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, chrome: { runtime: { id: 'tdeck-ui-list-test' } }, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  return { root, container, async close() {
    await act(() => root.unmount()); dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  } };
}

const base: DeckState = { version: 1, connected: false, columns: [], feeds: {}, bookmarks: [], settings: DEFAULT_SETTINGS };
const available: XList[] = [
  { id: '1111111111', name: 'Space research', description: 'People studying the universe', members: '24 members' },
  { id: '2222222222', name: 'Design voices', members: '12 members' },
];

test('the editor discovers existing lists explicitly, shows loading truthfully, and saves a selected list only after Add column', async () => {
  const app = await setup();
  const { ColumnEditor } = await import('../src/ui/Dialogs');
  const requests: Request[] = [];
  const send = async (message: Request) => { requests.push(message); return true; };
  const initial = newColumn('list');
  let state = { ...base };
  let closed = 0;
  const render = () => app.root.render(createElement(ColumnEditor, { initial, editing: false, state, send, onClose: () => { closed++; } }));
  try {
    await act(async () => render());
    assert.equal(requests.length, 0, 'opening the editor while disconnected does not create source tabs');
    const discover = Array.from(app.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('Find my X lists'))!;
    assert.ok(discover);
    await act(async () => discover.click());
    assert.deepEqual(requests, [{ type: 'LOAD_LISTS' }]);
    state = { ...state, listsStatus: 'loading', lists: [] };
    await act(async () => render());
    assert.match(app.container.textContent || '', /Reading the lists visible/);
    assert.doesNotMatch(app.container.textContent || '', /No lists were visible/);
    state = { ...state, listsStatus: 'ready', lists: available };
    await act(async () => render());
    const selected = app.container.querySelector<HTMLButtonElement>('.list-option')!;
    await act(async () => selected.click());
    assert.equal(app.container.querySelector<HTMLInputElement>('#column-query')?.value, available[0].id);
    assert.equal(app.container.querySelector<HTMLInputElement>('#column-title')?.value, available[0].name);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.equal(requests.length, 1, 'choosing a list does not save or start a feed');
    assert.equal(closed, 0, 'the editor stays open for the user to review its settings');
    await act(async () => { app.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const save = requests.find(request => request.type === 'SAVE_COLUMNS');
    assert.equal(save?.type, 'SAVE_COLUMNS');
    if (save?.type === 'SAVE_COLUMNS') {
      assert.equal(save.columns[0].kind, 'list');
      assert.equal(save.columns[0].query, available[0].id);
      assert.equal(save.columns[0].title, available[0].name);
    }
    assert.equal(closed, 1);
  } finally { await app.close(); }
});

test('connected list discovery runs once; errors preserve cached choices and preview never requests the account', async () => {
  const app = await setup();
  const requests: Request[] = [];
  const send = async (request: Request) => { requests.push(request); return true; };
  let state: DeckState = { ...base, connected: true, listsStatus: 'idle' };
  let preview = false;
  const render = () => app.root.render(createElement(ListPicker, { state, selected: '', send, onSelect: () => {}, preview }));
  try {
    await act(async () => render());
    await act(async () => render());
    assert.deepEqual(requests, [{ type: 'LOAD_LISTS' }], 'automatic discovery is triggered only once for this opening');
    state = { ...state, listsStatus: 'login-required', listsError: 'X asked you to sign in.', lists: available };
    await act(async () => render());
    assert.match(app.container.textContent || '', /X asked you to sign in/);
    assert.equal(app.container.querySelector<HTMLAnchorElement>('.list-error a')?.href, 'https://x.com/home');
    assert.equal(app.container.querySelectorAll('.list-option').length, 2, 'cached lists remain available during account recovery');
    state = { ...state, listsStatus: 'ready', lists: [] };
    await act(async () => render());
    assert.match(app.container.textContent || '', /No lists were visible on X/);
    preview = true;
    state = { ...base, connected: true };
    await act(async () => render());
    assert.match(app.container.textContent || '', /Install TDeck in Chrome or Brave/);
    assert.equal(requests.length, 1, 'preview mode never sends discovery requests');
    assert.equal(app.container.querySelectorAll('.list-option').length, 0);
  } finally { await app.close(); }
});

test('temporary list cards resolve by their unique key before populating a source, including duplicate names', async () => {
  const app = await setup();
  const { ColumnEditor } = await import('../src/ui/Dialogs');
  const lists: XList[] = [
    { id: 'pick:0', selectionKey: 'research-small', name: 'Research', members: '4 members' },
    { id: 'pick:1', selectionKey: 'research-large', name: 'Research', members: '44 members' },
  ];
  const state: DeckState = { ...base, listsStatus: 'ready', lists };
  const runtimeRequests: Request[] = [];
  let finish!: (response: Response) => void;
  Object.assign(chrome.runtime, { sendMessage: (message: Request) => {
    runtimeRequests.push(message);
    return new Promise<Response>(resolve => { finish = resolve; });
  } });
  const sent: Request[] = [];
  try {
    await act(async () => app.root.render(createElement(ColumnEditor, { initial: newColumn('list'), editing: false, state,
      send: async (request: Request) => { sent.push(request); return true; }, onClose: () => {} })));
    const cards = app.container.querySelectorAll<HTMLButtonElement>('.list-option');
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent || '', /4 members/);
    assert.match(cards[1].textContent || '', /44 members/);
    await act(async () => cards[1].click());
    assert.deepEqual(runtimeRequests, [{ type: 'RESOLVE_LIST', selectionKey: 'research-large' }]);
    assert.equal(app.container.querySelector<HTMLInputElement>('#column-query')?.value, '', 'temporary IDs never enter the column form');
    assert.match(app.container.textContent || '', /Opening this list on X/);
    await act(async () => { finish({ ok: true, state: { ...state, lists: [lists[0], { ...lists[1], id: '9876543210' }] } }); });
    assert.equal(app.container.querySelector<HTMLInputElement>('#column-query')?.value, '9876543210');
    assert.equal(app.container.querySelector<HTMLInputElement>('#column-title')?.value, 'Research');
    assert.equal(sent.length, 0, 'resolving a card does not create a column');
    await act(async () => cards[0].click());
    await act(async () => { finish({ ok: false, error: 'X did not open the selected list.' }); });
    assert.match(app.container.querySelector('[role="alert"]')?.textContent || '', /X did not open/);
    assert.equal(app.container.querySelector<HTMLInputElement>('#column-query')?.value, '9876543210', 'a failed selection leaves the last valid source intact');
    assert.equal(sent.length, 0);
  } finally { await app.close(); }
});
