import { STORAGE_KEY, type DeckState, type Request, type Response } from '../shared/types';

export type DemoListener = (changes: Record<string, { newValue: DeckState }>, area: string) => void;

// A page-local adapter: no tabs API, cookies, credentials, network, localStorage,
// or real extension storage. Reloading /demo.html always resets the fiction.
export function createDemoRuntime(initial: DeckState) {
  let state = structuredClone(initial);
  const listeners = new Set<DemoListener>();
  function publish(): Response {
    const snapshot = structuredClone(state);
    for (const listener of listeners) listener({ [STORAGE_KEY]: { newValue: structuredClone(snapshot) } }, 'local');
    return { ok: true, state: snapshot };
  }
  async function sendMessage(message: Request): Promise<Response> {
    switch (message.type) {
      case 'GET_STATE': return { ok: true, state: structuredClone(state) };
      case 'UPDATE_SETTINGS': state.settings = { ...state.settings, ...structuredClone(message.patch) }; return publish();
      case 'BOOKMARK_TOGGLE':
        state.bookmarks = state.bookmarks.some(post => post.id === message.post.id) ? state.bookmarks.filter(post => post.id !== message.post.id) : [structuredClone(message.post), ...state.bookmarks];
        return publish();
      default: return { ok: false, error: 'This is an offline demo with fictional content. Source connections, editing, and saved-layout operations are disabled.' };
    }
  }
  return { runtime: { id: 'tdeck-fictional-demo', sendMessage }, storage: { onChanged: { addListener: (listener: DemoListener) => listeners.add(listener), removeListener: (listener: DemoListener) => listeners.delete(listener) } } };
}
