import { EMPTY_FEED, EMPTY_STATE, STORAGE_KEY, type DeckState, type Request, type Response } from '../shared/types';
import { MAX_LAYOUTS, sanitizeLayouts, validateLayoutQuota } from '../shared/core';

export const isPreview = typeof chrome === 'undefined' || !chrome.runtime?.id;
const PREVIEW_KEY = 'tdeck-preview';

function previewState(): DeckState {
  try {
    const value = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null') as DeckState | null;
    if (value?.version === 1 && Array.isArray(value.columns) && value.settings) {
      return { ...value, connected: false, layouts: sanitizeLayouts(value.layouts), feeds: Object.fromEntries(value.columns.map(column => [column.id, { ...EMPTY_FEED, hasMore: false }])) };
    }
  } catch { /* A fresh preview is safe if the local value is unavailable. */ }
  return structuredClone(EMPTY_STATE);
}

export async function request(message: Request): Promise<DeckState> {
  if (!isPreview) {
    const response = await chrome.runtime.sendMessage<Request, Response>(message);
    if (!response) throw new Error('The extension did not respond. Reload TDeck and try again.');
    if (!response.ok) throw new Error(response.error);
    return response.state;
  }
  const state = previewState();
  const layoutFor = (id: string) => {
    const layout = state.layouts?.find(item => item.id === id);
    if (!layout) throw new Error('This saved layout no longer exists.');
    return layout;
  };
  const layoutName = (value: string, id?: string) => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 80) throw new Error('Give your layout a name of 1–80 characters.');
    if (state.layouts?.some(layout => layout.id !== id && layout.name.toLowerCase() === name.toLowerCase())) throw new Error('A layout with this name already exists. Choose another name or update that layout.');
    return name;
  };
  switch (message.type) {
    case 'GET_STATE': return state;
    case 'SAVE_COLUMNS': state.columns = message.columns; break;
    case 'UPDATE_SETTINGS': state.settings = { ...state.settings, ...message.patch }; break;
    case 'IMPORT_CONFIG': state.columns = message.columns; state.settings = message.settings; break;
    case 'BOOKMARK_TOGGLE':
      state.bookmarks = state.bookmarks.some(post => post.id === message.post.id)
        ? state.bookmarks.filter(post => post.id !== message.post.id)
        : [message.post, ...state.bookmarks];
      break;
    case 'CLEAR_COLUMN': state.feeds[message.columnId] = { ...EMPTY_FEED }; break;
    case 'SAVE_LAYOUT': {
      const existing = message.id === undefined ? undefined : layoutFor(message.id);
      const name = layoutName(message.name, existing?.id);
      const layouts = state.layouts || [];
      if (!existing && layouts.length >= MAX_LAYOUTS) throw new Error(`You can save up to ${MAX_LAYOUTS} layouts. Delete one before saving another.`);
      const snapshot = { id: existing?.id || crypto.randomUUID(), name, columns: structuredClone(state.columns), settings: structuredClone(state.settings), updatedAt: Date.now() };
      const next = existing ? layouts.map(layout => layout.id === existing.id ? snapshot : layout) : [snapshot, ...layouts];
      validateLayoutQuota(next); state.layouts = next;
      break;
    }
    case 'LOAD_LAYOUT': {
      const layout = layoutFor(message.layoutId);
      state.columns = structuredClone(layout.columns); state.settings = structuredClone(layout.settings);
      state.feeds = Object.fromEntries(state.columns.map(column => [column.id, { ...EMPTY_FEED, hasMore: false }]));
      break;
    }
    case 'RENAME_LAYOUT': {
      const layout = layoutFor(message.layoutId);
      const name = layoutName(message.name, layout.id);
      const next = state.layouts!.map(item => item.id === layout.id ? { ...item, name, updatedAt: Date.now() } : item);
      validateLayoutQuota(next); state.layouts = next;
      break;
    }
    case 'DELETE_LAYOUT': layoutFor(message.layoutId); state.layouts = state.layouts!.filter(layout => layout.id !== message.layoutId); break;
    case 'CONNECT': throw new Error('Live X feeds are available in the installed extension. Load the extension in Chrome or Brave, then open TDeck from its toolbar icon.');
    case 'LOAD_LISTS': throw new Error('Install TDeck in Chrome or Brave to discover lists from your signed-in X account.');
    case 'RESOLVE_LIST': throw new Error('Install TDeck in Chrome or Brave to open a list from your signed-in X account.');
    default: throw new Error('This is a design preview. Install the extension to connect to X and read real posts.');
  }
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(state));
  return state;
}

export function subscribe(listener: (state: DeckState) => void): () => void {
  if (isPreview) return () => {};
  const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[STORAGE_KEY]?.newValue) listener(changes[STORAGE_KEY].newValue as DeckState);
  };
  chrome.storage.onChanged.addListener(onChange);
  return () => chrome.storage.onChanged.removeListener(onChange);
}
