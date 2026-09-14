import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { extractListSelectionSnapshot, extractListsSnapshot, extractPost, extractProfileSnapshot, extractSnapshot, findListSelection, renderedText, safeMediaUrl, safeXUrl } from '../src/source/parser';
import type { ListSelectionSnapshot, ListSnapshot, ProfileSnapshot, SourceDocumentSnapshot, SourceSnapshot } from '../src/shared/types';

// Keep the fixture dependency local; production parsing only needs DOM types.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options?: { url: string }) => { window: Window & { document: Document; MutationObserver: typeof MutationObserver; Node: typeof Node } };
};
const PAGE = 'https://x.com/search?q=typescript&f=live';

function documentFor(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: PAGE }).window.document;
}

function header(handle: string, id: string, name = handle): string {
  return `<div data-testid="User-Name"><div><a href="/${handle}"><span>${name}</span></a><svg data-testid="icon-verified"></svg></div><div><a href="/${handle}"><span>@${handle}</span></a><a href="/${handle}/status/${id}"><time datetime="2026-09-14T09:10:11.000Z">2m</time></a></div></div>`;
}

function tweet(id = '123456789', content = '<div data-testid="tweetText">A normal post.</div>', extra = ''): string {
  return `<article data-testid="tweet"><div data-testid="Tweet-User-Avatar"><div data-testid="UserAvatar-Container-alice"><img alt="Alice" src="https://pbs.twimg.com/profile_images/123/avatar_normal.jpg"></div></div><div>${header('alice', id, 'Alice')}<div>${content}</div><div role="group"><button data-testid="reply" aria-label="2 Replies. Reply"><span data-testid="app-text-transition-container">2</span></button><button data-testid="retweet" aria-label="4 reposts. Repost"><span>4</span></button><button data-testid="like" aria-label="1,234 Likes. Like"><span data-testid="app-text-transition-container">1.2K</span></button><a href="/alice/status/${id}/analytics" aria-label="5,678 views. View post analytics"><span>5,678</span></a></div>${extra}</div></article>`;
}

function timeline(content: string): string {
  return `<main><div data-testid="primaryColumn"><section aria-label="Timeline: Search timeline"><div data-testid="cellInnerDiv">${content}</div></section></div></main>`;
}

function listCard(name: string, members: string, button = 'Pin List'): string {
  return `<div data-testid="listCell" role="link" aria-checked="false" tabindex="0"><span>${name}</span><span>·</span><span>·</span><span>${members} ${members === '1' ? 'member' : 'members'}</span><span>Example Reader</span><span>Example Reader</span><span></span><span>@example_reader</span><button aria-label="${button}"></button></div>`;
}

function listsPage(content: string): string {
  return `<nav><a data-testid="AppTabBar_Profile_Link" href="/example_reader">Profile</a></nav><main><div data-testid="primaryColumn"><h1>Lists created by @example_reader</h1>${content}</div></main>`;
}

test('resolves the signed-in profile only from its native navigation link', () => {
  const document = documentFor(listsPage(''));
  assert.deepEqual(extractProfileSnapshot(document, 'https://x.com/home#tdeck-lists=123'), { status: 'ready', handle: 'example_reader', listUrl: 'https://x.com/example_reader/lists', pageUrl: 'https://x.com/home' });
  for (const href of ['https://evil.example/example_reader', '/example_reader/status/123456789', 'javascript:alert(1)', '/i']) {
    document.querySelector('[data-testid="AppTabBar_Profile_Link"]')!.setAttribute('href', href);
    assert.equal(extractProfileSnapshot(document, 'https://x.com/home').status, 'loading');
  }
  assert.equal(extractProfileSnapshot(documentFor(timeline(tweet('1', '<div data-testid="tweetText"><a data-testid="AppTabBar_Profile_Link" href="/fake">Profile</a></div>'))), PAGE).status, 'loading');
  assert.equal(extractProfileSnapshot(documentFor('<main><h1>Sign in to X</h1><button>Next</button></main>'), 'https://x.com/i/flow/login').status, 'login-required');
});

test('discovers native own-list cards, excluding recommendations and preserving duplicate names', () => {
  const document = documentFor(listsPage(`<h2>Discover new Lists</h2>${listCard('Recommended', '90', 'Follow')}<h2>Your Lists</h2>${listCard('Reading sample', '7')}${listCard('Reading sample', '1', 'Unpin List')}${listCard('News sample', '25')}`));
  const snapshot = extractListsSnapshot(document, 'https://x.com/example_reader/lists#tdeck-lists=123');
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.lists.map(({ id, name, members }) => ({ id, name, members })), [{ id: 'pick:0', name: 'Reading sample', members: '7' }, { id: 'pick:1', name: 'Reading sample', members: '1' }, { id: 'pick:2', name: 'News sample', members: '25' }]);
  assert.equal(new Set(snapshot.lists.map(list => list.selectionKey)).size, 3);
  assert.equal(snapshot.pageUrl, 'https://x.com/example_reader/lists');
  const repeated = extractListsSnapshot(documentFor(listsPage(`<h2>Your Lists</h2>${listCard('Same', '3')}${listCard('Same', '3')}`)), 'https://x.com/example_reader/lists');
  assert.notEqual(repeated.lists[0].selectionKey, repeated.lists[1].selectionKey);
});

test('own-list keys remain stable, select exact current cards and cannot target recommendations', () => {
  const html = listsPage(`<h2>Your Lists</h2>${listCard('Reading sample', '7')}${listCard('Reading sample', '1')}<h2>Discover new Lists</h2>${listCard('Other', '99', 'Follow')}`);
  const first = documentFor(html);
  const second = documentFor(html);
  const lists = extractListsSnapshot(first, 'https://x.com/example_reader/lists').lists;
  assert.deepEqual(extractListsSnapshot(second, 'https://x.com/example_reader/lists').lists, lists);
  const chosen = findListSelection(first, 'https://x.com/example_reader/lists', lists[1].selectionKey!);
  assert.equal(chosen, first.querySelectorAll('[data-testid="listCell"]')[1]);
  chosen!.querySelector('span')!.textContent = 'Changed';
  assert.equal(findListSelection(first, 'https://x.com/example_reader/lists', lists[1].selectionKey!), undefined);
  assert.equal(findListSelection(first, 'https://x.com/example_reader/lists', 'button[aria-label="Follow"]'), undefined);
});

test('native pin controls retain own-list identity when section headings have been virtualized away', () => {
  const document = documentFor(listsPage(`<h2>Discover new Lists</h2>${listCard('Still my list', '4')}${listCard('Suggested', '5', 'Follow')}`));
  assert.deepEqual(extractListsSnapshot(document, 'https://x.com/example_reader/lists').lists.map(list => list.name), ['Still my list']);
});

test('list anchors use verified numeric X destinations and discovery reads remain bounded', () => {
  const document = documentFor(listsPage('<h2>Your Lists</h2><a href="/i/lists/123456789"><span>Anchored list</span><span>20 members</span></a><a href="https://evil.example/i/lists/123456780"><span>External</span></a><a href="/i/lists/123456789"><span>Duplicate</span></a>'));
  assert.deepEqual(extractListsSnapshot(document, 'https://x.com/example_reader/lists').lists.map(list => list.id), ['123456789']);
  const many = documentFor(listsPage(`<h2>Your Lists</h2>${Array.from({ length: 110 }, (_, index) => listCard(`List ${index}`, String(index))).join('')}`));
  assert.equal(extractListsSnapshot(many, 'https://x.com/example_reader/lists').lists.length, 100);
});

test('list discovery distinguishes loading, ready-empty, login and native error states', () => {
  assert.equal(extractListsSnapshot(documentFor(listsPage('<div role="progressbar"></div>')), 'https://x.com/example_reader/lists').status, 'loading');
  assert.equal(extractListsSnapshot(documentFor(listsPage('<h2>Your Lists</h2><p>You have not created any lists yet.</p>')), 'https://x.com/example_reader/lists').status, 'ready');
  assert.equal(extractListsSnapshot(documentFor('<main></main>'), 'https://x.com/i/flow/login').status, 'login-required');
  assert.equal(extractListsSnapshot(documentFor(listsPage('<div role="alert">Rate limit exceeded</div>')), 'https://x.com/example_reader/lists').status, 'error');
  const document = documentFor(listsPage(`<h2>Your Lists</h2>${listCard('Rate limit exceeded', '3')}`));
  assert.equal(extractListsSnapshot(document, 'https://x.com/example_reader/lists').status, 'ready');
});

test('selected list resolution accepts only a real numeric X list route', () => {
  const document = documentFor('<main></main>');
  assert.deepEqual(extractListSelectionSnapshot(document, 'https://x.com/i/lists/123456789#tdeck-lists=123'), { status: 'ready', id: '123456789', pageUrl: 'https://x.com/i/lists/123456789' });
  for (const url of ['https://evil.example/i/lists/123456789', 'https://x.com/example_reader/lists', 'https://x.com/i/lists/nope', 'https://user:pass@x.com/i/lists/123456789']) assert.equal(extractListSelectionSnapshot(document, url).status, 'loading');
});

test('extracts rendered posts with emoji, author, timestamps and visible engagement counts', () => {
  const document = documentFor(timeline(tweet('123456789', '<div data-testid="tweetText">Hello <img alt="👋" src="https://abs.twimg.com/emoji.svg"> world<br>second line <span>&lt;script&gt;literal&lt;/script&gt;</span><script>ignored()</script></div><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/photo?format=jpg&amp;name=small" alt="A mountain"></div>')));
  const snapshot = extractSnapshot(document, PAGE);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.posts.length, 1);
  assert.equal(snapshot.hasMore, true);
  assert.deepEqual(snapshot.posts[0], {
    id: '123456789', url: 'https://x.com/alice/status/123456789',
    text: 'Hello 👋 world\nsecond line <script>literal</script>',
    author: { name: 'Alice', handle: 'alice', avatar: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg', verified: true },
    createdAt: '2026-09-14T09:10:11.000Z',
    media: [{ type: 'image', url: 'https://pbs.twimg.com/media/photo?format=jpg&name=small', alt: 'A mountain' }],
    counts: { replies: '2', reposts: '4', likes: '1.2K', views: '5,678' }, isReply: false,
  });
});

test('keeps quote author, text, timestamp, media and counts separate from the outer post', () => {
  const quote = `<div role="link" tabindex="0"><div data-testid="UserAvatar-Container-bob"><img src="https://pbs.twimg.com/profile_images/456/bob.jpg"></div>${header('bob', '987654321', 'Bob')}<div data-testid="tweetText">Quoted words <img alt="🧵" src="https://abs.twimg.com/emoji.svg"></div><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quoted.jpg" alt="Quoted photo"></div><video poster="https://pbs.twimg.com/ext_tw_video_thumb/quoted.jpg"></video><button data-testid="like">99</button></div>`;
  const document = documentFor(timeline(tweet('123456789', `<div data-testid="tweetText">Outer words</div>${quote}<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/outer.jpg"></div>`)));
  const post = extractSnapshot(document, PAGE).posts[0];
  assert.equal(post.id, '123456789');
  assert.equal(post.author.handle, 'alice');
  assert.equal(post.text, 'Outer words');
  assert.equal(post.counts.likes, '1.2K');
  assert.deepEqual(post.quote, { author: 'Bob', text: 'Quoted words 🧵', url: 'https://x.com/bob/status/987654321' });
  assert.deepEqual(post.media, [{ type: 'image', url: 'https://pbs.twimg.com/media/outer.jpg' }]);
});

test('does not promote quote-only text or avatars into a textless outer post', () => {
  const quote = `<div role="link">${header('bob', '987654321', 'Bob')}<div data-testid="UserAvatar-Container-bob"><img src="https://pbs.twimg.com/profile_images/456/bob.jpg"></div><div data-testid="tweetText">Only the quote has text</div><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quoted.jpg"></div></div>`;
  const document = documentFor(timeline(`<article data-testid="tweet">${header('alice', '123456789', 'Alice')}${quote}<video poster="https://pbs.twimg.com/ext_tw_video_thumb/outer.jpg" src="blob:https://x.com/ignored"></video></article>`));
  const post = extractSnapshot(document, PAGE).posts[0];
  assert.equal(post.text, '');
  assert.equal(post.author.avatar, undefined);
  assert.equal(post.author.handle, 'alice');
  assert.equal(post.quote?.text, 'Only the quote has text');
  assert.deepEqual(post.media, [{ type: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/outer.jpg' }]);
});

test('supports explicitly marked quotes and a quote without a role attribute', () => {
  for (const attributes of ['data-testid="quoteTweet"', '']) {
    const quote = `<div ${attributes}>${header('bob', '987654321', 'Bob')}<div data-testid="tweetText">The quote</div></div>`;
    const document = documentFor(timeline(tweet('123456789', `<div data-testid="tweetText">Before the quote</div>${quote}`)));
    const post = extractSnapshot(document, PAGE).posts[0];
    assert.equal(post.text, 'Before the quote');
    assert.equal(post.quote?.text, 'The quote');
  }
});

test('a quote timestamp without an anchor still identifies its rendered card', () => {
  const quote = `<div role="link">${header('bob', '987654321', 'Bob').replace('<a href="/bob/status/987654321">', '<span>').replace('</time></a>', '</time></span>')}<div data-testid="tweetText">Quote with no permalink</div><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quoted.jpg"></div></div>`;
  const document = documentFor(timeline(tweet('123456789', `<div data-testid="tweetText">Outer</div>${quote}`)));
  const post = extractSnapshot(document, PAGE).posts[0];
  assert.equal(post.text, 'Outer');
  assert.deepEqual(post.media, []);
  assert.deepEqual(post.quote, { author: 'Bob', text: 'Quote with no permalink' });
});

test('recognizes replies and repost context without interpreting their text as context', () => {
  const document = documentFor(timeline(tweet('1', '<div data-testid="replyContext">Replying to <a href="/bob">@bob</a></div><div data-testid="tweetText">Some words</div>', '<div data-testid="socialContext"><span>Carol reposted</span></div>') + tweet('2', '<div data-testid="tweetText">Replying to nobody. Carol reposted this.</div>')));
  const posts = extractSnapshot(document, PAGE).posts;
  assert.equal(posts[0].isReply, true);
  assert.equal(posts[0].repostedBy, 'Carol');
  assert.equal(posts[1].isReply, false);
  assert.equal(posts[1].repostedBy, undefined);
});

test('skips promoted placements and explicit ad markers, preserving posts discussing ads', () => {
  const document = documentFor(timeline(`<div data-testid="placementTracking">${tweet('1')}</div>${tweet('2', '<div data-testid="tweetText">Ad blockers, promoted posts and rate limit exceeded messages</div>')}${tweet('3', '<div data-testid="promotedIndicator">Promoted</div>')}`));
  assert.deepEqual(extractSnapshot(document, PAGE).posts.map((post) => post.id), ['2']);
});

test('deduplicates post IDs, ignores nested articles and caps each read at 100 posts', () => {
  const document = documentFor(timeline(tweet('1', `<div data-testid="tweetText">Outer</div>${tweet('9999')}`) + tweet('1') + Array.from({ length: 110 }, (_, index) => tweet(String(index + 2))).join('')));
  const posts = extractSnapshot(document, PAGE).posts;
  assert.equal(posts.length, 100);
  assert.equal(posts.filter((post) => post.id === '1').length, 1);
  assert.equal(posts.some((post) => post.id === '9999'), false);
});

test('accepts only canonical X post/profile destinations', () => {
  assert.equal(safeXUrl('/alice/status/123/photo/1?ref=test#part'), 'https://x.com/alice/status/123');
  assert.equal(safeXUrl('https://www.x.com/i/web/status/123'), 'https://x.com/i/web/status/123');
  assert.equal(safeXUrl('/alice?token=discarded'), 'https://x.com/alice');
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', '//evil.example/alice/status/123', 'https://x.com.evil.example/alice', 'http://x.com/alice', 'https://user:pass@x.com/alice', 'https://x.com:8443/alice', 'https://twitter.com/alice', '/settings', '/i/flow/login', '/alice/status/not-numeric', '/alice/status/123/analytics', '/alice/../../logout', 'https://x.com/%61lice']) {
    assert.equal(safeXUrl(value), undefined, value);
  }
});

test('media rejects external, insecure and executable URLs, while preserving approved thumbnails', () => {
  for (const value of ['blob:https://x.com/id', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)', 'http://pbs.twimg.com/media/test.jpg', 'https://pbs.twimg.com.evil.example/media/test.jpg', 'https://evil.example/media/test.jpg', 'https://pbs.twimg.com:8443/media/test.jpg', 'https://user:secret@pbs.twimg.com/media/test.jpg', 'https://pbs.twimg.com/not-an-image', '/media/test.jpg']) {
    assert.equal(safeMediaUrl(value), undefined, value);
  }
  assert.equal(safeMediaUrl('https://pbs.twimg.com/amplify_video_thumb/123/image.jpg?name=small#ignored'), 'https://pbs.twimg.com/amplify_video_thumb/123/image.jpg?name=small');
  const document = documentFor(timeline(tweet('1', '<div data-testid="tweetText">Media test</div><div data-testid="tweetPhoto"><img src="https://evil.example/track.jpg"><img src="data:image/png,abc"><img src="https://pbs.twimg.com/media/good.jpg"></div><video src="blob:https://x.com/video" poster="javascript:alert(1)"></video>')));
  assert.deepEqual(extractSnapshot(document, PAGE).posts[0].media, [{ type: 'image', url: 'https://pbs.twimg.com/media/good.jpg' }]);
});

test('uses browser-selected responsive images for avatars and native media containers', () => {
  const document = documentFor(timeline(tweet('123456789', '<div data-testid="tweetText">Responsive image</div><div data-testid="tweetPhoto"><picture><img src="data:image/gif;base64,placeholder" alt="Responsive photo"></picture></div>')));
  const avatar = document.querySelector('[data-testid="Tweet-User-Avatar"] img')!;
  const photo = document.querySelector('[data-testid="tweetPhoto"] img')!;
  Object.defineProperty(avatar, 'currentSrc', { configurable: true, value: 'https://pbs.twimg.com/profile_images/123/responsive.jpg' });
  Object.defineProperty(photo, 'currentSrc', { configurable: true, value: 'https://pbs.twimg.com/media/responsive.jpg' });
  const post = extractSnapshot(document, PAGE).posts[0];
  assert.equal(post.author.avatar, 'https://pbs.twimg.com/profile_images/123/responsive.jpg');
  assert.deepEqual(post.media, [{ type: 'image', url: 'https://pbs.twimg.com/media/responsive.jpg', alt: 'Responsive photo' }]);
  Object.defineProperty(photo, 'currentSrc', { configurable: true, value: 'https://evil.example/track.jpg' });
  assert.deepEqual(extractSnapshot(document, PAGE).posts[0].media, []);
});

test('unreadable or untrusted permalinks cannot become posts', () => {
  const invalid = tweet().replace('/alice/status/123456789"', 'https://evil.example/alice/status/123456789"');
  const quoteOnly = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div><div data-testid="quoteTweet">${header('bob', '2')}<div data-testid="tweetText">Quote only</div></div></article>`;
  const document = documentFor(timeline(invalid + quoteOnly));
  assert.equal(extractSnapshot(document, PAGE).posts.length, 0);
  assert.equal(extractPost(document.createElement('div'), PAGE), undefined);
});

test('distinguishes empty and initial loading structural states', () => {
  assert.equal(extractSnapshot(documentFor(timeline('<div data-testid="emptyState"><h1>No results for “typescript”</h1><span>Try searching for something else.</span></div>')), PAGE).status, 'empty');
  assert.equal(extractSnapshot(documentFor(timeline('<div role="progressbar" aria-label="Loading"></div>')), PAGE).status, 'loading');
  assert.equal(extractSnapshot(documentFor('<main><div data-testid="primaryColumn"></div></main>'), PAGE).status, 'loading');
});

test('detects a login flow or login dialog but not ordinary login links beside readable posts', () => {
  assert.equal(extractSnapshot(documentFor('<main></main>'), 'https://x.com/i/flow/login').status, 'login-required');
  assert.equal(extractSnapshot(documentFor('<main><h1>Sign in to X</h1><input autocomplete="username"><button>Next</button></main>'), PAGE).status, 'login-required');
  assert.equal(extractSnapshot(documentFor(timeline(tweet()) + '<div role="dialog"><h1>Log in to X</h1><button>Log in</button></div>'), PAGE).status, 'login-required');
  assert.equal(extractSnapshot(documentFor(timeline(tweet()) + '<aside><a href="/i/flow/login">Log in</a></aside>'), PAGE).status, 'ready');
  assert.equal(extractSnapshot(documentFor(timeline(tweet('1', '<div data-testid="tweetText"><h1>Sign in to X</h1><button>Log in</button></div>'))), PAGE).status, 'ready');
});

test('detects rate limits and retry errors only from UI status structures', () => {
  for (const message of ['Rate limit exceeded', 'You are rate limited. Please wait a few moments.', 'Too many requests']) {
    const snapshot = extractSnapshot(documentFor(timeline(`${tweet()}<div role="alert">${message}</div>`)), PAGE);
    assert.equal(snapshot.status, 'rate-limited');
    assert.equal(snapshot.posts.length, 1);
    assert.equal(snapshot.hasMore, false);
  }
  assert.equal(extractSnapshot(documentFor(timeline('<div><span>Something went wrong. Try reloading.</span><button>Retry</button></div>')), PAGE).status, 'error');
  assert.equal(extractSnapshot(documentFor(timeline('<div data-testid="emptyState"><h1>This list doesn’t exist</h1></div>')), PAGE).status, 'error');
  assert.equal(extractSnapshot(documentFor(timeline(tweet('1', '<div data-testid="tweetText"><span role="alert">Rate limit exceeded</span><span>Something went wrong</span><button>Retry</button></div>'))), PAGE).status, 'ready');
  assert.equal(extractSnapshot(documentFor(timeline(tweet()) + '<aside><div role="alert">Rate limit exceeded</div></aside>'), PAGE).status, 'ready');
});

test('empty search queries mentioning errors do not become error states', () => {
  for (const query of ['Rate limit exceeded', 'Something went wrong', 'Log in to X']) {
    const document = documentFor(timeline(`<div data-testid="emptyState"><h1>No results for “${query}”</h1><span>Try searching for something else.</span></div>`));
    assert.equal(extractSnapshot(document, PAGE).status, 'empty');
  }
});

test('hasMore follows actual scroll room, active feed loaders and explicit end states', () => {
  const document = documentFor(timeline(tweet()));
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2_000 });
  Object.defineProperty(document.documentElement, 'scrollTop', { configurable: true, value: 0 });
  assert.equal(extractSnapshot(document, PAGE).hasMore, true);
  Object.defineProperty(document.documentElement, 'scrollTop', { configurable: true, value: 1_950 });
  assert.equal(extractSnapshot(document, PAGE).hasMore, false);
  const loader = document.createElement('div');
  loader.setAttribute('role', 'progressbar');
  document.querySelector('[data-testid="primaryColumn"]')?.append(loader);
  assert.equal(extractSnapshot(document, PAGE).hasMore, true);
  const ended = documentFor(timeline(`${tweet()}<div role="status">No more posts</div>`));
  assert.equal(extractSnapshot(ended, PAGE).hasMore, false);
});

test('ignores invalid dates and bounds text without exposing scripts or markup', () => {
  const document = documentFor(timeline(tweet('1', `<div data-testid="tweetText">${'a'.repeat(22_000)}<script>secret()</script></div>`).replace('2026-09-14T09:10:11.000Z', 'invalid')));
  const post = extractSnapshot(document, PAGE).posts[0];
  assert.equal(post.createdAt, '');
  assert.equal(post.text.length, 20_000);
  assert.equal(renderedText(documentFor('<div id="text">A <span hidden>hidden</span><style>.hidden{}</style><svg>not text</svg><img alt="🙂"><br>B</div>').getElementById('text')), 'A 🙂\nB');
  assert.equal(extractSnapshot(document, 'javascript:alert(1)').pageUrl, 'https://x.com/');
});

test('content messages reject other senders, wait for the initial DOM and make bounded scrolls', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>${timeline('<div role="progressbar"></div>')}</body></html>`, { url: PAGE });
  const scrolls: { action: string; top: number }[] = [];
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 2_400 });
  Object.defineProperty(dom.window, 'scrollBy', { configurable: true, value: (options: ScrollToOptions) => scrolls.push({ action: 'by', top: options.top ?? 0 }) });
  Object.defineProperty(dom.window, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => scrolls.push({ action: 'to', top: options.top ?? 0 }) });
  type Listener = (message: unknown, sender: { id: string }, respond: (snapshot: SourceSnapshot) => void) => boolean;
  let listener: Listener | undefined;
  const broadcasts: unknown[] = [];
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, location: dom.window.location,
    MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    chrome: { runtime: { id: 'fixture-extension', onMessage: { addListener: (callback: Listener) => { listener = callback; } }, sendMessage: (message: unknown) => { broadcasts.push(message); return Promise.reject(new Error('The worker may not be listening yet.')); } } },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    await import('../src/source/content');
    assert.ok(listener);
    const received = listener as Listener;
    assert.equal(received({ type: 'TDECK_READ' }, { id: 'other-extension' }, () => assert.fail('Foreign sender received a response')), false);
    assert.equal(received({ type: 'UNRELATED' }, { id: 'fixture-extension' }, () => assert.fail('Unknown message received a response')), false);
    const identity = (): SourceDocumentSnapshot => {
      let result: SourceDocumentSnapshot | undefined;
      assert.equal(received({ type: 'TDECK_DOCUMENT' }, { id: 'fixture-extension' }, (value) => { result = value as unknown as SourceDocumentSnapshot; }), false);
      assert.ok(result, 'Document identity responds synchronously without waiting for the read queue');
      return result;
    };
    const firstDocument = identity();
    assert.match(firstDocument.documentToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(firstDocument.pageUrl, PAGE);
    assert.deepEqual(broadcasts, [{ type: 'TDECK_DOCUMENT_READY', documentToken: firstDocument.documentToken }]);
    const request = <T = SourceSnapshot>(type: string, options: Record<string, unknown> = {}): Promise<T> => new Promise((resolve) => {
      assert.equal(received({ type, ...options }, { id: 'fixture-extension' }, (value) => resolve(value as unknown as T)), true);
    });
    const initial = request('TDECK_READ');
    assert.equal(identity().documentToken, firstDocument.documentToken, 'Identity remains instant during a pending initial load');
    setTimeout(() => { dom.window.document.querySelector('[data-testid="primaryColumn"]')!.innerHTML = timeline(tweet('1')); }, 30);
    const initialSnapshot = await initial;
    assert.equal(initialSnapshot.posts[0].id, '1');
    assert.equal(initialSnapshot.documentToken, firstDocument.documentToken);
    assert.deepEqual(scrolls, []);
    dom.window.document.querySelector('[data-testid="primaryColumn"]')!.innerHTML = timeline(tweet('1', '<div data-testid="tweetText">Ready before its media</div><div data-testid="tweetPhoto"><img src="data:image/gif;base64,placeholder"></div>'));
    const lateMedia = request('TDECK_READ');
    setTimeout(() => { dom.window.document.querySelector('[data-testid="tweetPhoto"] img')!.setAttribute('src', 'https://pbs.twimg.com/media/late.jpg'); }, 450);
    assert.equal((await lateMedia).posts[0].media[0].url, 'https://pbs.twimg.com/media/late.jpg');
    const blockingRead = request('TDECK_READ', { expiresAt: Date.now() + 5_000 });
    const staleScroll = request('TDECK_SCROLL', { expiresAt: Date.now() + 100 });
    await blockingRead;
    const expired = await staleScroll;
    assert.equal(expired.status, 'error');
    assert.match(expired.error!, /expired/);
    assert.equal(expired.documentToken, firstDocument.documentToken);
    assert.deepEqual(scrolls, [], 'A source scroll queued behind an old read cannot run after its deadline');
    const invalidDeadline = await request('TDECK_READ', { expiresAt: Infinity });
    assert.equal(invalidDeadline.status, 'error');
    assert.match(invalidDeadline.error!, /expired/);
    await request('TDECK_SCROLL');
    assert.deepEqual(scrolls, [{ action: 'by', top: 1_600 }]);
    await request('TDECK_RESET');
    assert.deepEqual(scrolls[1], { action: 'to', top: 0 });
    dom.window.document.querySelector('[data-testid="primaryColumn"]')!.innerHTML = '<div role="alert">Rate limit exceeded</div>';
    assert.equal((await request('TDECK_SCROLL')).status, 'rate-limited');
    assert.equal(scrolls.length, 2);
    dom.window.document.body.innerHTML = listsPage(`<h2>Your Lists</h2>${listCard('Reading sample', '7')}${listCard('Reading sample', '1')}`);
    dom.window.history.replaceState({}, '', 'https://x.com/example_reader/lists');
    assert.equal(identity().documentToken, firstDocument.documentToken, 'An X SPA route change does not create a new document epoch');
    assert.equal(identity().pageUrl, 'https://x.com/example_reader/lists');
    assert.equal((await request<ProfileSnapshot>('TDECK_PROFILE')).handle, 'example_reader');
    const lists = await request<ListSnapshot>('TDECK_LISTS');
    assert.equal(lists.lists.length, 2);
    assert.equal(scrolls.length, 2);
    await request<ListSnapshot>('TDECK_LISTS', { scroll: true });
    assert.deepEqual(scrolls[2], { action: 'by', top: 1_600 });
    let clicks = 0;
    dom.window.document.querySelectorAll('[data-testid="listCell"]')[1].addEventListener('click', () => {
      clicks++;
      dom.window.history.pushState({}, '', 'https://x.com/i/lists/123456789');
    });
    assert.equal((await request<ListSelectionSnapshot>('TDECK_SELECT_LIST', { selectionKey: 'invalid' })).status, 'error');
    assert.equal(clicks, 0);
    const selected = await request<ListSelectionSnapshot>('TDECK_SELECT_LIST', { selectionKey: lists.lists[1].selectionKey });
    assert.equal(selected.id, '123456789');
    assert.equal(clicks, 1);
    assert.equal(broadcasts.length, 1, 'Document readiness is broadcast only once per content initialization');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
