import { createDemoState } from './fixtures';
import { createDemoRuntime } from './runtime';
import './styles.css';

if (window.location.pathname !== '/demo.html') throw new Error('The fictional demo can only run at /demo.html.');
const demo = createDemoRuntime(createDemoState(window.location.origin));
// The production UI detects this isolated page-local adapter before its API
// module is imported. It never reaches a signed-in browser or stored workspace.
Object.defineProperty(window, 'chrome', { configurable: true, value: demo });
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener('click', event => {
  const anchor = (event.target as Element | null)?.closest('a[href]');
  if (!anchor || anchor.getAttribute('href')?.startsWith('#')) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const notice = document.querySelector<HTMLElement>('.demo-link-notice');
  if (notice) { notice.hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, 2600); }
}, true);
document.addEventListener('auxclick', event => { if ((event.target as Element | null)?.closest('a[href]')) event.preventDefault(); }, true);

await import('../ui/main');
