import { DEFAULT_SETTINGS, type ColumnConfig, type ColumnKind, type Settings } from '../shared/types';
import { normalizeAccount, normalizeList } from '../shared/core';

export const COLORS = ['#8adfc1', '#a99be5', '#e5be7f', '#83bee6', '#e2a0b8', '#a4c781'];
export const MAX_COLUMNS = 12;

export function newColumn(kind: ColumnKind = 'search', query = '', count = 0): ColumnConfig {
  return {
    id: crypto.randomUUID(), kind, title: '', query, color: COLORS[count % COLORS.length],
    width: 380, refreshSeconds: 120, paused: false, mediaOnly: false, hideReplies: false, mutedWords: [],
  };
}

export function cleanQuery(kind: ColumnKind, raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error(kind === 'search' ? 'Enter a search or keyword to follow.' : kind === 'account' ? 'Enter an X handle.' : 'Enter a list URL or numeric list ID.');
  if (value.length > 500) throw new Error('Keep the source under 500 characters.');
  if (kind === 'search') return value;
  if (kind === 'account') {
    try { return normalizeAccount(value); }
    catch { throw new Error('Use a valid X handle, such as @NASA, or its profile URL.'); }
  }
  try { return normalizeList(value); }
  catch { throw new Error('Use a numeric list ID or an X URL like x.com/i/lists/12345.'); }
}

export function validateImport(input: unknown): { columns: ColumnConfig[]; settings: Settings } {
  if (!input || typeof input !== 'object') throw new Error('This file is not a TDeck workspace.');
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || value.app !== 'tdeck' || !Array.isArray(value.columns)) throw new Error('Choose a workspace JSON file exported from TDeck.');
  if (value.columns.length > MAX_COLUMNS) throw new Error(`A workspace can have up to ${MAX_COLUMNS} columns.`);
  const ids = new Set<string>();
  const columns: ColumnConfig[] = value.columns.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('A column in this file is invalid.');
    const column = raw as Record<string, unknown>;
    if (!['search', 'account', 'list'].includes(String(column.kind))) throw new Error('A column has an unsupported source type.');
    if (typeof column.query !== 'string' || typeof column.title !== 'string' || column.title.length > 60) throw new Error('A column title or source is invalid.');
    if (typeof column.id !== 'string' || !/^[\w-]{1,80}$/.test(column.id) || ['__proto__', 'constructor', 'prototype'].includes(column.id) || ids.has(column.id)) throw new Error('Column IDs must be unique and valid.');
    ids.add(column.id);
    if (typeof column.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(column.color)) throw new Error('A column color is invalid.');
    if (typeof column.width !== 'number' || !Number.isFinite(column.width) || column.width < 300 || column.width > 640) throw new Error('Column widths must be between 300 and 640 pixels.');
    if (typeof column.refreshSeconds !== 'number' || !Number.isFinite(column.refreshSeconds) || column.refreshSeconds < 60 || column.refreshSeconds > 1800) throw new Error('Refresh intervals must be between 1 and 30 minutes.');
    if (typeof column.paused !== 'boolean' || typeof column.mediaOnly !== 'boolean' || typeof column.hideReplies !== 'boolean') throw new Error('A column filter is invalid.');
    if (!Array.isArray(column.mutedWords) || column.mutedWords.length > 50 || column.mutedWords.some(word => typeof word !== 'string' || word.length > 100)) throw new Error('Muted words must be a list of up to 50 short strings.');
    return {
      id: column.id, kind: column.kind as ColumnKind, title: column.title.trim(), query: cleanQuery(column.kind as ColumnKind, column.query),
      color: column.color, width: Math.round(column.width), refreshSeconds: Math.round(column.refreshSeconds),
      paused: column.paused, mediaOnly: column.mediaOnly, hideReplies: column.hideReplies, mutedWords: column.mutedWords as string[],
    };
  });
  if (!value.settings || typeof value.settings !== 'object') throw new Error('Workspace settings are missing.');
  const settings = { ...DEFAULT_SETTINGS, ...value.settings } as Settings;
  if (!['dark', 'light', 'system'].includes(settings.theme) || !['comfortable', 'compact'].includes(settings.density)
    || !['automatic', 'queue'].includes(settings.arrivalMode) || typeof settings.paused !== 'boolean'
    || typeof settings.showMedia !== 'boolean' || !Number.isFinite(settings.fontSize) || settings.fontSize < 12 || settings.fontSize > 18) {
    throw new Error('The workspace contains invalid display settings.');
  }
  return { columns, settings: { theme: settings.theme, density: settings.density, arrivalMode: settings.arrivalMode, paused: settings.paused, showMedia: settings.showMedia, fontSize: settings.fontSize } };
}

export function sourceUrl(column: Pick<ColumnConfig, 'kind' | 'query'>): string {
  if (column.kind === 'search') return `https://x.com/search?q=${encodeURIComponent(column.query)}&src=typed_query&f=live`;
  if (column.kind === 'account') return `https://x.com/search?q=${encodeURIComponent(`from:${column.query.replace(/^@/, '')}`)}&src=typed_query&f=live`;
  return `https://x.com/i/lists/${encodeURIComponent(column.query)}`;
}

export function columnTitle(column: ColumnConfig): string {
  return column.title || (column.kind === 'account' ? `@${column.query}` : column.kind === 'list' ? 'Your list' : column.query);
}

export function safeUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
