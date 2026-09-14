import type { Author, ListSelectionSnapshot, ListSnapshot, Post, ProfileSnapshot, SourceSnapshot, XList } from '../shared/types';

const MAX_POSTS = 100;
const TWEET = '[data-testid="tweet"]';
const QUOTE = '[data-testid="quoteTweet"], [data-testid="quotedTweet"]';
const RESERVED_PROFILES = new Set(['home', 'search', 'explore', 'notifications', 'messages', 'settings', 'login', 'logout', 'signup', 'compose', 'intent', 'share', 'i']);

/** Keep links inert until the dashboard chooses to open a known X destination. */
export function safeXUrl(value: string | null, base = 'https://x.com/'): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(url.hostname) || url.port || url.username || url.password) return undefined;
    const status = url.pathname.match(/^\/([A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,30})(?:\/(?:photo|video)\/\d+)?\/?$/);
    if (status) return `https://x.com/${status[1]}/status/${status[2]}`;
    const profile = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (profile && !RESERVED_PROFILES.has(profile[1].toLowerCase())) return `https://x.com/${profile[1]}`;
  } catch { /* A malformed or non-web URL is not a usable destination. */ }
  return undefined;
}

export function safeMediaUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.port || url.username || url.password) return undefined;
    if (!/^\/(?:media|profile_images|profile_banners|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname)) return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

function imageUrl(image: Element): string | undefined {
  // currentSrc is the browser-selected image when X uses picture/srcset.
  const currentSrc = (image as HTMLImageElement).currentSrc;
  return (typeof currentSrc === 'string' ? safeMediaUrl(currentSrc) : undefined) ?? safeMediaUrl(image.getAttribute('src'));
}

/** textContent loses emoji represented by images. Never copy markup from X. */
export function renderedText(element: Element | null, limit = 20_000): string {
  if (!element) return '';
  const pieces: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      pieces.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    const tagName = child.tagName.toUpperCase();
    if (['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEMPLATE'].includes(tagName) || child.hasAttribute('hidden')) return;
    if (tagName === 'IMG') {
      pieces.push(child.getAttribute('alt') ?? '');
      return;
    }
    if (tagName === 'BR') {
      pieces.push('\n');
      return;
    }
    for (const descendant of child.childNodes) walk(descendant);
  };
  walk(element);
  return pieces.join('').replace(/\r\n?/g, '\n').replace(/[\t\u00a0\u202f ]+/g, ' ').replace(/ *\n */g, '\n').trim().slice(0, limit);
}

function ownElements(root: Element, selector: string, quotes: Element[] = []): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((element) => element.closest(TWEET) === root && !quotes.some((quote) => quote.contains(element)));
}

function statusUrl(link: Element | null, pageUrl: string): string | undefined {
  const url = safeXUrl(link?.getAttribute('href') ?? null, pageUrl);
  return url?.includes('/status/') ? url : undefined;
}

function timeLink(time: Element): Element | null {
  return time.closest('a[href]');
}

function explicitQuoteRoots(article: Element): Element[] {
  return Array.from(article.querySelectorAll(QUOTE)).filter((element) => element.closest(TWEET) === article);
}

/** X renders quote cards as role=link containers, with their own timestamp. */
function quoteRoots(article: Element, primaryHeader: Element | undefined, primaryTime: Element | undefined, pageUrl: string): Element[] {
  const roots = explicitQuoteRoots(article);
  const primaryUrl = primaryTime ? statusUrl(timeLink(primaryTime), pageUrl) : undefined;
  for (const time of ownElements(article, 'time')) {
    if (time === primaryTime || primaryHeader?.contains(time) || roots.some((root) => root.contains(time))) continue;
    const url = statusUrl(timeLink(time), pageUrl);
    if (url && url === primaryUrl) continue;
    let candidate = time.parentElement;
    while (candidate && candidate !== article && !candidate.contains(primaryHeader ?? primaryTime ?? article)) {
      if (candidate.matches('[role="link"]:not(a), [data-testid="card.wrapper"]')) {
        roots.push(candidate);
        break;
      }
      candidate = candidate.parentElement;
    }
    if (candidate && candidate !== article && roots.includes(candidate)) continue;

    // A conservative fallback for cards without role=link: the smallest branch
    // containing both their timestamp and text, never the outer tweet body.
    candidate = time.parentElement;
    while (candidate && candidate !== article && !candidate.contains(primaryHeader ?? primaryTime ?? article)) {
      const text = candidate.querySelector('[data-testid="tweetText"]');
      if (text && Boolean(time.compareDocumentPosition(text) & 4)) {
        const earlierText = Array.from(candidate.querySelectorAll('[data-testid="tweetText"]')).some((item) => Boolean(item.compareDocumentPosition(time) & 4));
        if (!earlierText) roots.push(candidate);
        break;
      }
      candidate = candidate.parentElement;
    }
  }
  return roots.filter((root, index) => !roots.some((other, otherIndex) => otherIndex !== index && other !== root && other.contains(root)) && roots.indexOf(root) === index);
}

function authorFromHeader(header: Element | undefined, article: Element, quotes: Element[], pageUrl: string): Author {
  const profileLinks = header ? Array.from(header.querySelectorAll('a[href]')).filter((link) => {
    const url = safeXUrl(link.getAttribute('href'), pageUrl);
    return url && !url.includes('/status/');
  }) : [];
  const profileUrl = safeXUrl(profileLinks[0]?.getAttribute('href') ?? null, pageUrl);
  const handle = profileUrl ? profileUrl.slice('https://x.com/'.length) : '';
  const name = renderedText(profileLinks.find((link) => !renderedText(link).startsWith('@')) ?? profileLinks[0] ?? null, 200) || handle;
  const avatar = ownElements(article, '[data-testid^="UserAvatar-Container-"] img, [data-testid="Tweet-User-Avatar"] img', quotes)
    .map(imageUrl).find(Boolean);
  return {
    name,
    handle,
    ...(avatar ? { avatar } : {}),
    verified: Boolean(header?.querySelector('[data-testid="icon-verified"], [aria-label="Verified account"], [aria-label="Verified"]')),
  };
}

function extractCount(article: Element, selector: string, quotes: Element[]): string {
  const control = ownElements(article, selector, quotes)[0];
  if (!control) return '0';
  const visible = renderedText(control.querySelector('[data-testid="app-text-transition-container"]') ?? control, 100);
  const match = visible.match(/\d[\d.,\u00a0\u202f]*(?:\s?[KMBkmb])?/) ?? control.getAttribute('aria-label')?.match(/\d[\d.,\u00a0\u202f]*(?:\s?[KMBkmb])?/);
  return match?.[0].replace(/\s+/g, '') ?? '0';
}

function isPromoted(article: Element): boolean {
  return Boolean(article.closest('[data-testid="placementTracking"]') || article.querySelector('[data-testid="promotedIndicator"], [data-testid="promotedLabel"], [aria-label="Promoted"], [aria-label="Advertisement"]'));
}

function extractMedia(article: Element, quotes: Element[]): Post['media'] {
  const media: Post['media'] = [];
  const seen = new Set<string>();
  for (const video of ownElements(article, 'video[poster]', quotes)) {
    const url = safeMediaUrl(video.getAttribute('poster'));
    if (url && !seen.has(url)) {
      media.push({ type: 'video', url });
      seen.add(url);
    }
  }
  for (const photo of ownElements(article, '[data-testid="tweetPhoto"] img, [data-testid="videoPlayer"] img', quotes)) {
    const url = imageUrl(photo);
    if (!url || seen.has(url)) continue;
    const video = Boolean(photo.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]'));
    const alt = photo.getAttribute('alt')?.trim().slice(0, 1_000);
    media.push({ type: video ? 'video' : 'image', url, ...(alt ? { alt } : {}) });
    seen.add(url);
  }
  return media.slice(0, 8);
}

export function extractPost(article: Element, pageUrl: string): Post | undefined {
  if (!article.matches(TWEET) || article.parentElement?.closest(TWEET) || isPromoted(article)) return undefined;
  const explicitQuotes = explicitQuoteRoots(article);
  const header = ownElements(article, '[data-testid="User-Name"]', explicitQuotes)[0];
  const time = header ? Array.from(header.querySelectorAll('time')).find((item) => statusUrl(timeLink(item), pageUrl))
    : ownElements(article, 'time', explicitQuotes).find((item) => statusUrl(timeLink(item), pageUrl));
  const url = time ? statusUrl(timeLink(time), pageUrl) : undefined;
  if (!url) return undefined;
  const id = url.match(/\/status\/(\d+)$/)?.[1];
  if (!id) return undefined;
  const quotes = quoteRoots(article, header, time, pageUrl);
  const author = authorFromHeader(header, article, quotes, pageUrl);
  if (!author.handle) {
    const fromUrl = url.match(/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\//)?.[1];
    if (!fromUrl) return undefined;
    author.handle = fromUrl;
    author.name ||= fromUrl;
  }
  const datetime = time?.getAttribute('datetime');
  const timestamp = datetime ? Date.parse(datetime) : NaN;
  const text = renderedText(ownElements(article, '[data-testid="tweetText"]', quotes)[0] ?? null);
  const socialContext = ownElements(article, '[data-testid="socialContext"]', quotes)[0];
  const socialText = renderedText(socialContext ?? null, 250);
  const repostedBy = socialText.match(/^(.+?)\s+(?:reposted|retweeted)$/i)?.[1];
  const reply = ownElements(article, '[data-testid="replyContext"], div, span', quotes).some((element) => {
    if (element.closest('[data-testid="tweetText"], [data-testid="User-Name"]') || element.querySelector('[data-testid="tweetText"], [data-testid="User-Name"]')) return false;
    const value = renderedText(element, 220);
    return value.length < 220 && /^Replying to(?:\s|$)/i.test(value);
  });
  const quoted = quotes[0];
  let quote: Post['quote'];
  if (quoted) {
    const quoteHeader = quoted.querySelector('[data-testid="User-Name"]');
    const quoteProfile = Array.from((quoteHeader ?? quoted).querySelectorAll('a[href]')).find((link) => {
      const href = safeXUrl(link.getAttribute('href'), pageUrl);
      return href && !href.includes('/status/');
    });
    const quoteUrl = Array.from(quoted.querySelectorAll('time')).map((item) => statusUrl(timeLink(item), pageUrl)).find(Boolean);
    const quotedAuthor = quoteProfile ? renderedText(quoteProfile, 200) : renderedText(quoteHeader, 200);
    quote = {
      text: renderedText(quoted.querySelector('[data-testid="tweetText"]')),
      author: quotedAuthor || (quoteUrl?.match(/^https:\/\/x\.com\/([^/]+)\//)?.[1] ?? 'Quoted post'),
      ...(quoteUrl ? { url: quoteUrl } : {}),
    };
  }
  const views = ownElements(article, 'a[href*="/analytics"], [data-testid="analytics"]', quotes)[0];
  return {
    id, url, text, author,
    createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '',
    media: extractMedia(article, quotes),
    counts: {
      replies: extractCount(article, '[data-testid="reply"]', quotes),
      reposts: extractCount(article, '[data-testid="retweet"], [data-testid="unretweet"]', quotes),
      likes: extractCount(article, '[data-testid="like"], [data-testid="unlike"]', quotes),
      ...(views ? { views: extractCount(article, 'a[href*="/analytics"], [data-testid="analytics"]', quotes) } : {}),
    },
    ...(quote ? { quote } : {}),
    ...(repostedBy ? { repostedBy } : {}),
    isReply: reply,
  };
}

function outsidePosts(element: Element): boolean {
  return !element.closest(TWEET) && !element.closest('[data-testid="placementTracking"]');
}

function statusMessages(root: ParentNode): string[] {
  const messages = Array.from(root.querySelectorAll('[role="alert"], [role="status"], [data-testid="emptyState"], [data-testid="error-detail"], [data-testid="errorDetail"]'))
    .filter((element) => outsidePosts(element) && !element.querySelector(TWEET))
    .map((element) => renderedText(element, 800));
  for (const button of root.querySelectorAll('button, [role="button"]')) {
    if (!outsidePosts(button) || !/^(?:Retry|Reload|Try again|Refresh)$/i.test(renderedText(button, 80))) continue;
    let parent = button.parentElement;
    for (let depth = 0; depth < 3 && parent && !parent.querySelector(TWEET); depth++, parent = parent.parentElement) {
      const text = renderedText(parent, 801);
      if (text.length <= 800) messages.push(text);
    }
  }
  return messages;
}

function isEmptyMessage(message: string): boolean {
  return /^(?:No (?:results|posts|tweets|items|matches)(?:\b|\s)|Nothing to see here(?:\b|\s)|This (?:list|timeline) is empty(?:\b|\s))/i.test(message);
}

function needsLogin(document: Document, root: ParentNode, pageUrl: string, hasPosts: boolean): boolean {
  try {
    if (/^\/(?:login|i\/flow\/(?:login|signup))(?:\/|$)/.test(new URL(pageUrl).pathname)) return true;
  } catch { /* A URL alone cannot confirm authentication state. */ }
  const scopes: ParentNode[] = Array.from(document.querySelectorAll('[role="dialog"]')).filter(outsidePosts);
  if (!hasPosts) scopes.push(root);
  return scopes.some((scope) => {
    const password = Array.from(scope.querySelectorAll('input[type="password"], input[autocomplete="current-password"]')).some(outsidePosts);
    if (password) return true;
    const heading = Array.from(scope.querySelectorAll('h1, h2, [role="heading"]')).filter(outsidePosts).some((element) => /^(?:Log in|Sign in)(?: to X| to Twitter)?$/i.test(renderedText(element, 100)));
    const action = Array.from(scope.querySelectorAll('a[href], button, [role="button"], input[autocomplete="username"]')).filter(outsidePosts).some((element) => {
      const href = element.getAttribute('href') ?? '';
      return /^(?:https:\/\/x\.com)?\/(?:login|i\/flow\/login)(?:\?|$)/.test(href) || /^(?:Log in|Sign in|Next)$/i.test(renderedText(element, 100)) || element.matches('input[autocomplete="username"]');
    });
    return heading && action;
  });
}

function cleanPageUrl(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(url.hostname) || url.port || url.username || url.password) return 'https://x.com/';
    url.hash = '';
    return url.href;
  } catch { return 'https://x.com/'; }
}

export function extractSnapshot(document: Document, pageUrl: string): SourceSnapshot {
  const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main, [role="main"]') ?? document.body;
  const posts: Post[] = [];
  const seen = new Set<string>();
  for (const article of root?.querySelectorAll(TWEET) ?? []) {
    const post = extractPost(article, pageUrl);
    if (post && !seen.has(post.id)) {
      posts.push(post);
      seen.add(post.id);
      if (posts.length >= MAX_POSTS) break;
    }
  }
  const result: SourceSnapshot = { posts, status: 'ready', hasMore: false, pageUrl: cleanPageUrl(pageUrl) };
  const scope = root ?? document;
  if (needsLogin(document, scope, pageUrl, posts.length > 0)) {
    return { ...result, status: 'login-required', error: 'Sign in to X in this browser, then refresh this column.' };
  }
  const messages = statusMessages(scope);
  const actionable = messages.filter((message) => !isEmptyMessage(message));
  if (actionable.some((message) => /^(?:Rate limit (?:exceeded|reached)|(?:You are|You['’]re)(?: being)? rate limited|Too many requests|You have exceeded (?:the|your) (?:rate|request) limit)\b/i.test(message))) {
    return { ...result, status: 'rate-limited', error: 'X is limiting requests. This column will retry after a cooldown.' };
  }
  if (actionable.some((message) => /^(?:Something went wrong|An error (?:occurred|has occurred)|Could not (?:load|retrieve)|Unable to (?:load|retrieve)|This (?:page|list|account) (?:doesn['’]t exist|isn['’]t available|is unavailable)|Account suspended|These posts are protected|You['’]re blocked)\b/i.test(message))) {
    return { ...result, status: 'error', error: 'X could not display this timeline. Open the source tab for details.' };
  }
  const loading = Array.from(scope.querySelectorAll('[role="progressbar"], [data-testid="spinner"], [aria-label="Loading"]')).some(outsidePosts);
  const ended = messages.some((message) => /^(?:You['’]re all caught up|No more (?:posts|tweets|results)|That['’]s all for now)\b/i.test(message));
  const empty = messages.some(isEmptyMessage);
  if (!posts.length) {
    if (empty && !loading) return { ...result, status: 'empty' };
    return { ...result, status: 'loading', hasMore: loading };
  }
  const scrolling = document.scrollingElement ?? document.documentElement;
  const viewport = document.defaultView?.innerHeight ?? scrolling.clientHeight;
  const layoutKnown = scrolling.scrollHeight > 0 && viewport > 0;
  const canScroll = layoutKnown && scrolling.scrollHeight - scrolling.scrollTop - viewport > 40;
  const feed = scope.querySelector('[aria-label^="Timeline:"], [role="feed"], [data-testid="cellInnerDiv"]');
  result.hasMore = !ended && !empty && (loading || canScroll || (!layoutKnown && Boolean(feed)));
  return result;
}

export function extractProfileSnapshot(document: Document, pageUrl: string): ProfileSnapshot {
  const cleanUrl = cleanPageUrl(pageUrl);
  const root = document.querySelector('[data-testid="primaryColumn"], main, [role="main"]') ?? document;
  if (needsLogin(document, root, pageUrl, false)) return { status: 'login-required', pageUrl: cleanUrl, error: 'Sign in to X in this browser to find your lists.' };
  const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const profile = link && outsidePosts(link) ? safeXUrl(link.getAttribute('href'), pageUrl) : undefined;
  const handle = profile?.match(/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})$/)?.[1];
  return handle ? { status: 'ready', handle, listUrl: `https://x.com/${handle}/lists`, pageUrl: cleanUrl } : { status: 'loading', pageUrl: cleanUrl };
}

function hasListPinControl(card: Element): boolean {
  return Array.from(card.querySelectorAll('button, [role="button"]')).some((button) => /^(?:Unpin|Pin) List$/i.test(button.getAttribute('aria-label') ?? renderedText(button, 100)));
}

function listSectionHeading(card: Element, root: ParentNode): string {
  const scoped = card.closest('section, [role="region"]') ?? root;
  const headings = Array.from(scoped.querySelectorAll('h1, h2, h3, [role="heading"]')).filter((heading) => !heading.closest('[data-testid="listCell"], a[href*="/i/lists/"]') && Boolean(heading.compareDocumentPosition(card) & 4));
  return renderedText(headings.at(-1) ?? null, 200);
}

function listIdFromHref(value: string | null, pageUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, pageUrl);
    if (url.origin !== 'https://x.com' || url.username || url.password) return undefined;
    return url.pathname.match(/^\/i\/lists\/(\d{1,25})\/?$/)?.[1];
  } catch { return undefined; }
}

function signatureHash(value: string): string {
  // Compact, stable keys distinguish equal names without exposing DOM markup.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

function discoveredListCards(document: Document, pageUrl: string): { list: XList; card: Element }[] {
  const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main, [role="main"]') ?? document.body;
  if (!root) return [];
  const found: { list: XList; card: Element }[] = [];
  const seenCards = new Set<Element>();
  const seenIds = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const element of root.querySelectorAll('[data-testid="listCell"], a[href*="/i/lists/"]')) {
    const card = element.closest('[data-testid="listCell"]') ?? element;
    if (seenCards.has(card) || !outsidePosts(card)) continue;
    seenCards.add(card);
    const heading = listSectionHeading(card, root);
    const pinned = hasListPinControl(card);
    if (!pinned && /^(?:Discover|Recommended|Suggested|Lists for you|Popular lists)\b/i.test(heading)) continue;
    if (!pinned && Array.from(card.querySelectorAll('button, [role="button"]')).some((button) => /^Follow$/i.test(button.getAttribute('aria-label') ?? renderedText(button, 100)))) continue;
    const ownSection = /^(?:Your Lists|Pinned Lists|Lists (?:you own|you follow|created by)|Created by)\b/i.test(heading);
    if (!pinned && !ownSection) continue;
    const href = card.getAttribute('href') ?? card.querySelector('a[href*="/i/lists/"]')?.getAttribute('href') ?? null;
    const id = listIdFromHref(href, pageUrl);
    if (href && !id) continue;
    if (id && seenIds.has(id)) continue;
    const textElements = Array.from(card.querySelectorAll('span')).filter((node) => !node.closest('button, [role="button"]'));
    const textParts = textElements.map((node) => renderedText(node, 1_000)).filter(Boolean);
    const title = textParts.find((text) => !/^(?:\d[\d, .]*[KMB]?\s+members?\b|@|Follow$|Pin List$|Unpin List$)/i.test(text));
    const name = (title ?? renderedText(card.querySelector('h1, h2, h3, [role="heading"]'), 160)).trim().slice(0, 160);
    if (!name) continue;
    const memberPattern = /(?:^|[^\d])(\d[\d,. ]*(?:[KMB])?)\s*members?\b/i;
    const memberText = textParts.find((text) => memberPattern.test(text)) ?? renderedText(card, 4_000);
    const members = memberText.match(memberPattern)?.[1].trim().slice(0, 40);
    const descriptionElement = card.querySelector('[data-testid="listDescription"]');
    const description = renderedText(descriptionElement, 500);
    const image = Array.from(card.querySelectorAll('img')).map(imageUrl).find(Boolean);
    const signature = JSON.stringify([name, members ?? '', description]);
    const ordinal = occurrences.get(signature) ?? 0;
    occurrences.set(signature, ordinal + 1);
    const selectionKey = `list:${signatureHash(signature)}:${ordinal}`;
    const list: XList = { id: id ?? `pick:${found.length}`, name, selectionKey, ...(members ? { members } : {}), ...(description ? { description } : {}), ...(image ? { image } : {}) };
    found.push({ list, card });
    if (id) seenIds.add(id);
    if (found.length >= 100) break;
  }
  return found;
}

export function extractListsSnapshot(document: Document, pageUrl: string): ListSnapshot {
  const cleanUrl = cleanPageUrl(pageUrl);
  const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main, [role="main"]') ?? document;
  if (needsLogin(document, root, pageUrl, false)) return { lists: [], status: 'login-required', hasMore: false, pageUrl: cleanUrl, error: 'Sign in to X in this browser to find your lists.' };
  const messages = statusMessages(root);
  if (messages.some((message) => /^(?:Something went wrong|Rate limit (?:exceeded|reached)|(?:You are|You['’]re)(?: being)? rate limited|Too many requests)\b/i.test(message))) return { lists: [], status: 'error', hasMore: false, pageUrl: cleanUrl, error: 'X could not load your lists. Open the list source and try again.' };
  const lists = discoveredListCards(document, pageUrl).map(({ list }) => list);
  const loading = Array.from(root.querySelectorAll('[role="progressbar"], [data-testid="spinner"], [aria-label="Loading"]')).some(outsidePosts);
  const ownHeading = Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"]')).some((element) => outsidePosts(element) && /^(?:Your Lists|Pinned Lists|Lists (?:you own|you follow|created by)|Created by)\b/i.test(renderedText(element, 200)));
  const scrolling = document.scrollingElement ?? document.documentElement;
  const viewport = document.defaultView?.innerHeight ?? scrolling.clientHeight;
  const canScroll = scrolling.scrollHeight > 0 && viewport > 0 && scrolling.scrollHeight - scrolling.scrollTop - viewport > 40;
  return { lists, status: lists.length || (ownHeading && !loading) ? 'ready' : 'loading', hasMore: loading || canScroll, pageUrl: cleanUrl };
}

export function findListSelection(document: Document, pageUrl: string, selectionKey: string): Element | undefined {
  if (!/^list:[0-9a-f]{16}:\d{1,3}$/.test(selectionKey)) return undefined;
  return discoveredListCards(document, pageUrl).find(({ list }) => list.selectionKey === selectionKey)?.card;
}

export function extractListSelectionSnapshot(document: Document, pageUrl: string): ListSelectionSnapshot {
  const cleanUrl = cleanPageUrl(pageUrl);
  const root = document.querySelector('main, [role="main"]') ?? document;
  if (needsLogin(document, root, pageUrl, false)) return { status: 'login-required', pageUrl: cleanUrl, error: 'Sign in to X to open this list.' };
  const id = listIdFromHref(pageUrl, pageUrl);
  return id ? { status: 'ready', id, pageUrl: cleanUrl } : { status: 'loading', pageUrl: cleanUrl };
}
