import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDemoState } from '../src/demo/fixtures';
import { createDemoRuntime } from '../src/demo/runtime';

test('demo fixtures use fictional identifiers and exclusively local image assets', () => {
  const now = 1_800_000_000_000;
  const state = createDemoState('http://127.0.0.1:5173', now);
  assert.equal(state.connected, false);
  assert.deepEqual(state.columns.map(column => column.kind), ['search', 'account', 'list']);
  assert.equal(state.columns.find(column => column.kind === 'list')?.query, 'fictional-curiosity-list');
  const posts = Object.values(state.feeds).flatMap(feed => feed.posts);
  assert.equal(posts.length, 12);
  for (const post of posts) {
    assert.match(post.id, /^fictional-/);
    assert.match(post.author.handle, /\.demo$/);
    assert.equal(new URL(post.url).hostname, 'demo.invalid');
    assert.ok(Date.parse(post.createdAt) < now);
    for (const resource of [post.author.avatar, ...post.media.map(media => media.url)].filter(Boolean) as string[]) {
      const url = new URL(resource);
      assert.equal(url.origin, 'http://127.0.0.1:5173');
      assert.match(url.pathname, /^\/src\/demo\/assets\/[a-z-]+\.svg$/);
    }
  }
});

test('demo assets stay in their actual directory when the base has no trailing slash', async () => {
  const state = createDemoState('http://127.0.0.1:5173/src/demo', 1_800_000_000_000);
  const urls = new Set(Object.values(state.feeds).flatMap(feed => feed.posts.flatMap(post => [post.author.avatar!, ...post.media.map(media => media.url)])));
  assert.equal(urls.size, 7);
  for (const resource of urls) {
    const path = new URL(resource).pathname;
    assert.match(path, /^\/src\/demo\/assets\//);
    const svg = await readFile(new URL(`..${path}`, import.meta.url), 'utf8');
    assert.match(svg, /^<svg\s/);
  }
});

test('demo runtime owns isolated memory and rejects real source or persistent-workspace operations', async () => {
  const initial = createDemoState('http://127.0.0.1:5173/src/demo/', 1_800_000_000_000);
  const demo = createDemoRuntime(initial);
  const first = await demo.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error('The demo state should be available.');
  first.state.columns.length = 0;
  const next = await demo.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(next.ok && next.state.columns.length, 3);
  for (const message of [{ type: 'CONNECT' }, { type: 'REFRESH' }, { type: 'LOAD_LISTS' }, { type: 'SAVE_LAYOUT', name: 'A real layout' }] as const) {
    const response = await demo.runtime.sendMessage(message);
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.error, /offline demo/);
  }
  const changed = await demo.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { theme: 'light' } });
  assert.equal(changed.ok && changed.state.settings.theme, 'light');
  assert.equal(initial.settings.theme, 'dark', 'the fixture is not mutated');
  const fresh = await createDemoRuntime(initial).runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(fresh.ok && fresh.state.settings.theme, 'dark', 'a fresh page gets a fresh isolated workspace');
  assert.equal('tabs' in demo, false);
  assert.equal('local' in demo.storage, false);
});

test('demo entry declares its fiction and stays outside the production build', async () => {
  const html = await readFile(new URL('../demo.html', import.meta.url), 'utf8');
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(html, /Fictional accounts and posts/);
  assert.match(html, /No X connection/);
  assert.match(html, /img-src 'self'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(build, /src\/demo|demo\.html/);
});
