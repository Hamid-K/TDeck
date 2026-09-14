import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MAX_POSTS } from '../src/shared/core';
import { DEFAULT_SETTINGS, EMPTY_FEED, type ColumnConfig, type DeckState, type Post, type Request } from '../src/shared/types';
import { Column } from '../src/ui/Column';
import { PostCard } from '../src/ui/PostCard';
import { newColumn } from '../src/ui/config';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options?: { url: string }) => { window: Window & typeof globalThis & { close: () => void } };
};

function post(id: number): Post {
  return {
    id: String(id), url: `https://x.com/alice/status/${id}`, text: `Post ${id}`,
    author: { name: 'Alice', handle: 'alice', verified: false },
    createdAt: '2026-09-14T08:00:00.000Z', media: [], counts: { replies: '', reposts: '', likes: '' }, isReply: false,
  };
}

function stateFor(columns: ColumnConfig[], posts: Post[], hasMore = false): DeckState {
  return { version: 1, connected: true, settings: { ...DEFAULT_SETTINGS }, bookmarks: [], columns,
    feeds: Object.fromEntries(columns.map(column => [column.id, { ...EMPTY_FEED, status: 'ready', posts, pending: [], hasMore }])) };
}

function setup() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost:5173/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const observers: Observer[] = [];
  class Observer {
    target: Element | null = null;
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
    observe(target: Element) { this.target = target; }
    disconnect() { this.target = null; }
    trigger() { if (this.target) this.callback([{ isIntersecting: true, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  }
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const heights = new Map<string, number>();
  const rect = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 380, width: 380, height, toJSON() { return {}; } });
  // jsdom has no layout engine. Model real, variable-height stacked cards and a scroll viewport;
  // the assertions below check actual mounted React behavior after insertions and scroll events.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('column-scroll')) return rect(100, 420);
    if (this.dataset.postId) {
      const scroller = this.closest<HTMLElement>('.column-scroll');
      if (scroller) {
        let before = 0;
        for (const card of scroller.querySelectorAll<HTMLElement>('[data-post-id]')) {
          if (card === this) break;
          before += heights.get(card.dataset.postId!) ?? 150;
        }
        return rect(100 + before - scroller.scrollTop, heights.get(this.dataset.postId) ?? 150);
      }
    }
    return rect(0, 0);
  };
  dom.window.HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number = {}, y?: number) {
    this.scrollTop = typeof options === 'number' ? y || 0 : options.top || 0;
    this.dispatchEvent(new dom.window.Event('scroll'));
  };
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  return { root, container, dom, heights, observers,
    async close() {
      await act(() => root.unmount()); dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const noop = () => {};
function columnView(column: ColumnConfig, state: DeckState, send: (request: Request) => Promise<boolean> = async () => true) {
  return createElement(Column, { key: column.id, column, state, index: 0, total: state.columns.length, send,
    onEdit: noop, onMove: noop, onSave: noop, notify: noop, onDrop: noop, onDragStart: noop, onDragEnd: noop, dragging: false });
}

test('automatic arrivals retain the visible post and pixel offset in one column without scrolling another', async () => {
  const app = setup();
  const alpha = { ...newColumn(), id: 'alpha', query: 'space' };
  const beta = { ...newColumn(), id: 'beta', query: 'design' };
  const initial = [post(90), post(80), post(70), post(60), post(50), post(40)];
  let state = stateFor([alpha, beta], initial);
  app.heights.set('90', 150); app.heights.set('80', 200);
  app.heights.set('100', 95); app.heights.set('110', 185);
  try {
    await act(() => app.root.render(createElement('div', null, columnView(alpha, state), columnView(beta, state))));
    const [first, second] = Array.from(app.container.querySelectorAll<HTMLElement>('.column-scroll'));
    await act(() => { first.scrollTop = 268; first.dispatchEvent(new Event('scroll')); second.scrollTop = 100; second.dispatchEvent(new Event('scroll')); });
    const reading = first.querySelector<HTMLElement>('[data-post-id="80"]')!;
    const originalOffset = reading.getBoundingClientRect().top - first.getBoundingClientRect().top;
    assert.equal(originalOffset, -118, 'the reader is partway through the second variable-height card');
    state = { ...state, feeds: { ...state.feeds, alpha: { ...state.feeds.alpha, posts: [post(110), post(100), ...initial] } } };
    await act(() => app.root.render(createElement('div', null, columnView(alpha, state), columnView(beta, state))));
    assert.equal(first.scrollTop, 548, 'the scroll position accounts for both newly inserted card heights');
    assert.equal(reading.getBoundingClientRect().top - first.getBoundingClientRect().top, originalOffset);
    assert.equal(first.querySelector('[data-post-id="80"]'), reading, 'stable keys keep the reader’s existing card mounted');
    assert.equal(second.scrollTop, 100, 'another independently scrolled column does not move');
    await act(() => { first.scrollTop = 0; first.dispatchEvent(new Event('scroll')); });
    state = { ...state, feeds: { ...state.feeds, alpha: { ...state.feeds.alpha, posts: [post(120), ...state.feeds.alpha.posts] } } };
    await act(() => app.root.render(createElement('div', null, columnView(alpha, state), columnView(beta, state))));
    assert.equal(first.scrollTop, 0, 'a reader already at the top sees incoming posts immediately');
    assert.equal(first.querySelector<HTMLElement>('[data-post-id]')?.dataset.postId, '120');
    assert.equal(second.scrollTop, 100);
  } finally { await app.close(); }
});

test('the recent-post cache cap disconnects older-post observation and offers the native source even when filters hide posts', async () => {
  const app = setup();
  const column = { ...newColumn(), id: 'alpha', query: 'space' };
  const requests: Request[] = [];
  const send = async (request: Request) => { requests.push(request); return true; };
  let state = stateFor([column], Array.from({ length: MAX_POSTS - 1 }, (_, index) => post(1000 - index)), true);
  try {
    await act(() => app.root.render(columnView(column, state, send)));
    assert.equal(app.observers.filter(observer => observer.target).length, 1);
    await act(() => app.observers.forEach(observer => observer.trigger()));
    assert.equal(requests.filter(request => request.type === 'LOAD_OLDER').length, 1);
    state = { ...state, feeds: { ...state.feeds, alpha: { ...state.feeds.alpha, posts: [post(1001), ...state.feeds.alpha.posts] } } };
    await act(() => app.root.render(columnView(column, state, send)));
    await act(() => app.observers.forEach(observer => observer.trigger()));
    assert.equal(app.observers.filter(observer => observer.target).length, 0);
    assert.equal(requests.filter(request => request.type === 'LOAD_OLDER').length, 1, 'no further older request at the cache cap');
    assert.match(app.container.textContent || '', /Recent-post cache is full/);
    assert.match(app.container.textContent || '', /Continue on X/);
    assert.doesNotMatch(app.container.textContent || '', /Load earlier posts|reached the end/);
    const filtered = { ...column, mediaOnly: true };
    state = { ...state, columns: [filtered], feeds: { ...state.feeds, alpha: { ...state.feeds.alpha, hasMore: false } } };
    await act(() => app.root.render(columnView(filtered, state, send)));
    assert.match(app.container.textContent || '', /Recent-post cache is full/);
    assert.equal(app.observers.filter(observer => observer.target).length, 0, 'the cap uses the underlying cache, not filtered visible count');
  } finally { await app.close(); }
});

test('image viewing stays in TDeck, arrows switch real photos, Escape closes, and video opens on X', async () => {
  const app = setup();
  const content = { ...post(12345), media: [
    { type: 'image' as const, url: 'https://pbs.twimg.com/media/one.jpg', alt: 'First image' },
    { type: 'video' as const, url: 'https://pbs.twimg.com/ext_tw_video_thumb/video.jpg', alt: 'Video preview' },
    { type: 'image' as const, url: 'https://pbs.twimg.com/media/two.jpg', alt: 'Second image' },
  ] };
  try {
    await act(() => app.root.render(createElement(PostCard, { post: content, saved: false, settings: DEFAULT_SETTINGS, onSave: noop, notify: noop })));
    const image = app.container.querySelector<HTMLButtonElement>('button.media-item')!;
    image.focus();
    await act(() => image.click());
    assert.equal(document.querySelector('.lightbox-stage > img')?.getAttribute('src'), content.media[0].url);
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    assert.equal(document.querySelector('.lightbox-stage > img')?.getAttribute('src'), content.media[2].url);
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    assert.equal(document.querySelector('.lightbox-stage > img')?.getAttribute('src'), content.media[0].url);
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, image, 'closing the viewer restores focus to the originating image');
    const video = app.container.querySelector<HTMLAnchorElement>('a.media-item')!;
    assert.equal(video.href, content.url);
    assert.equal(video.target, '_blank');
    assert.equal(video.title, 'Watch video on X');
  } finally { await app.close(); }
});
