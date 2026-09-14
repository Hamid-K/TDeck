import type { ListSelectionSnapshot, ListSnapshot, ProfileSnapshot, SourceDocumentSnapshot, SourceRequest, SourceSnapshot } from '../shared/types';
import { extractListSelectionSnapshot, extractListsSnapshot, extractProfileSnapshot, extractSnapshot, findListSelection } from './parser';

const documentToken = crypto.randomUUID();
const snapshot = (): SourceSnapshot => ({ ...extractSnapshot(document, location.href), documentToken });
type PageSnapshot = SourceSnapshot | ListSnapshot | ProfileSnapshot | ListSelectionSnapshot;

function expiredRequest(request: SourceRequest): SourceSnapshot | undefined {
  if ((request.type !== 'TDECK_READ' && request.type !== 'TDECK_SCROLL') || request.expiresAt === undefined) return undefined;
  if (typeof request.expiresAt === 'number' && Number.isFinite(request.expiresAt) && request.expiresAt > Date.now()) return undefined;
  return { posts: [], status: 'error', hasMore: false, pageUrl: location.href, documentToken, error: 'The source request expired before it could run. Refresh this column to try again.' };
}

/** Resolve after rendering becomes quiet, or at the fixed deadline. */
function waitForRender<T extends PageSnapshot>(read: () => T, options: { minimumMs: number; maximumMs: number; waitForInitialLoad?: boolean; timeoutMessage?: string }): Promise<T> {
  return new Promise((resolve) => {
    const start = Date.now();
    let quietSince = start;
    let finished = false;
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => {
        const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target as Element : mutation.target.parentElement;
        return !element?.closest('time, [data-testid="app-text-transition-container"]');
      })) quietSince = Date.now();
    });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearInterval(check);
      clearTimeout(deadline);
      const result = read();
      if (result.status === 'loading' && Date.now() - start >= options.maximumMs - 100) {
        result.error = options.timeoutMessage ?? 'X is still loading this timeline. Open the source tab if this persists.';
      }
      resolve(result);
    };
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'data-testid', 'src', 'srcset', 'poster', 'datetime'] });
    const check = setInterval(() => {
      const now = Date.now();
      if (now - start < options.minimumMs || now - quietSince < 450) return;
      if (options.waitForInitialLoad && read().status === 'loading') return;
      finish();
    }, 150);
    const deadline = setTimeout(finish, options.maximumMs);
  });
}

async function handle(request: Exclude<SourceRequest, { type: 'TDECK_DOCUMENT' }>): Promise<PageSnapshot> {
  const expired = expiredRequest(request);
  if (expired) return expired;
  if (request.type === 'TDECK_PROFILE') {
    const read = () => extractProfileSnapshot(document, location.href);
    const current = read();
    return current.status === 'loading' ? waitForRender(read, { minimumMs: 450, maximumMs: 7_000, waitForInitialLoad: true, timeoutMessage: 'X has not finished loading your profile navigation.' }) : current;
  }
  if (request.type === 'TDECK_LISTS') {
    const read = () => extractListsSnapshot(document, location.href);
    const current = read();
    if (current.status === 'login-required' || current.status === 'error') return current;
    if (request.scroll === true) {
      window.scrollBy({ top: Math.min(1_600, Math.max(320, Math.round(window.innerHeight * 0.9))), left: 0, behavior: 'instant' });
      return waitForRender(read, { minimumMs: 900, maximumMs: 9_000, waitForInitialLoad: true, timeoutMessage: 'X has not finished loading your lists.' });
    }
    return current.status === 'loading' ? waitForRender(read, { minimumMs: 450, maximumMs: 7_000, waitForInitialLoad: true, timeoutMessage: 'X has not finished loading your lists.' }) : current;
  }
  if (request.type === 'TDECK_SELECT_LIST') {
    const card = typeof request.selectionKey === 'string' ? findListSelection(document, location.href, request.selectionKey) : undefined;
    if (!card || typeof (card as HTMLElement).click !== 'function') return { status: 'error', pageUrl: location.href, error: 'This list is no longer visible. Refresh the list picker and try again.' };
    (card as HTMLElement).click();
    return waitForRender(() => extractListSelectionSnapshot(document, location.href), { minimumMs: 450, maximumMs: 7_000, waitForInitialLoad: true, timeoutMessage: 'X has not finished opening the selected list.' });
  }
  if (request.type === 'TDECK_READ') {
    const current = snapshot();
    // On inactive X tabs, text can mount before lazy avatars and media URLs.
    // Give a readable timeline one bounded paint/settle window as well.
    return current.status === 'ready' || current.status === 'loading' ? waitForRender(snapshot, { minimumMs: 1_050, maximumMs: 7_000, waitForInitialLoad: true }) : current;
  }
  if (request.type === 'TDECK_RESET') {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return waitForRender(snapshot, { minimumMs: 600, maximumMs: 7_000, waitForInitialLoad: true });
  }
  const current = snapshot();
  if (['login-required', 'rate-limited', 'error', 'empty'].includes(current.status)) return current;
  const distance = Math.min(1_600, Math.max(320, Math.round(window.innerHeight * 0.9)));
  const expiredBeforeScroll = expiredRequest(request);
  if (expiredBeforeScroll) return expiredBeforeScroll;
  window.scrollBy({ top: distance, left: 0, behavior: 'instant' });
  return waitForRender(snapshot, { minimumMs: 900, maximumMs: 9_000, waitForInitialLoad: true });
}

// Serialize reads and scrolls so an older read cannot race a reset request.
let queue: Promise<unknown> = Promise.resolve();
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || !('type' in message)) return false;
  if (!['TDECK_DOCUMENT', 'TDECK_READ', 'TDECK_SCROLL', 'TDECK_RESET', 'TDECK_PROFILE', 'TDECK_LISTS', 'TDECK_SELECT_LIST'].includes(String(message.type))) return false;
  const request = message as SourceRequest;
  if (request.type === 'TDECK_DOCUMENT') {
    sendResponse({ documentToken, pageUrl: location.href, readyState: document.readyState } satisfies SourceDocumentSnapshot);
    return false;
  }
  queue = queue.catch(() => undefined).then(() => handle(request));
  queue.then(sendResponse, () => {
    const failed = { status: 'error' as const, pageUrl: 'https://x.com/', error: 'The source page changed while it was being read. Try again.' };
    sendResponse(request.type === 'TDECK_LISTS' ? { ...failed, lists: [], hasMore: false } : request.type === 'TDECK_PROFILE' || request.type === 'TDECK_SELECT_LIST' ? failed : { ...failed, posts: [], hasMore: false, documentToken });
  });
  return true;
});

// The worker registers before navigation and uses this document's epoch to
// distinguish a fresh injection from the previous page's stale complete state.
try {
  void chrome.runtime.sendMessage({ type: 'TDECK_DOCUMENT_READY', documentToken }).catch(() => undefined);
} catch { /* Extension reloads can invalidate the previous document's context. */ }
