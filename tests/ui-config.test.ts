import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { cleanQuery, columnTitle, newColumn, safeUrl, sourceUrl, validateImport } from '../src/ui/config';

test('column sources preserve searches and normalize native account and list URLs', () => {
  assert.equal(cleanQuery('search', '  "space exploration" lang:en -spoilers  '), '"space exploration" lang:en -spoilers');
  assert.equal(cleanQuery('account', '@NASA'), 'NASA');
  assert.equal(cleanQuery('account', 'https://x.com/NASA/'), 'NASA');
  assert.equal(cleanQuery('list', 'https://x.com/i/lists/123456789'), '123456789');
  assert.equal(cleanQuery('list', 'https://x.com/i/lists/123456789?s=20'), '123456789');
  assert.equal(cleanQuery('account', 'https://x.com/NASA?s=20'), 'NASA');
  assert.throws(() => cleanQuery('account', 'NASA/with_replies'), /valid X handle/);
  assert.throws(() => cleanQuery('list', 'https://example.com/i/lists/123'), /numeric list ID/);
  assert.throws(() => cleanQuery('search', '   '), /Enter a search/);
  assert.throws(() => cleanQuery('search', 'a'.repeat(501)), /500/);
});

test('workspace imports reject invalid or duplicate identifiers and unsafe setting values before submission', () => {
  const column = { ...newColumn(), query: 'design', title: 'Design' };
  const workspace = { app: 'tdeck', version: 1, columns: [column], settings: { ...DEFAULT_SETTINGS } };
  assert.deepEqual(validateImport(JSON.parse(JSON.stringify(workspace))), { columns: [column], settings: DEFAULT_SETTINGS });
  assert.throws(() => validateImport({ ...workspace, columns: [column, column] }), /unique/);
  assert.throws(() => validateImport({ ...workspace, columns: [{ ...column, color: 'red; background: url(https://example.com)' }] }), /color/);
  assert.throws(() => validateImport({ ...workspace, columns: [{ ...column, refreshSeconds: 1 }] }), /between 1 and 30/);
  assert.throws(() => validateImport({ ...workspace, columns: [{ ...column, width: Number.NaN }] }), /widths/);
  assert.throws(() => validateImport({ ...workspace, columns: [{ ...column, mutedWords: [null] }] }), /Muted/);
  assert.throws(() => validateImport({ ...workspace, settings: { ...DEFAULT_SETTINGS, fontSize: 100 } }), /display settings/);
  assert.throws(() => validateImport({ ...workspace, settings: { ...DEFAULT_SETTINGS, theme: 'unknown' } }), /display settings/);
  assert.throws(() => validateImport({ ...workspace, app: 'other' }), /exported from TDeck/);
});

test('native source links encode user searches and post links reject executable protocols', () => {
  const column = { ...newColumn(), query: '"a & b" #design' };
  assert.equal(new URL(sourceUrl(column)).searchParams.get('q'), column.query);
  assert.equal(new URL(sourceUrl(column)).searchParams.get('f'), 'live');
  assert.equal(new URL(sourceUrl({ kind: 'account', query: '@NASA' })).searchParams.get('q'), 'from:NASA');
  assert.equal(columnTitle({ ...column, title: '' }), column.query);
  assert.equal(safeUrl('javascript:alert(1)'), undefined);
  assert.equal(safeUrl('data:text/html,<script>'), undefined);
  assert.equal(safeUrl('/relative/path'), undefined);
  assert.equal(safeUrl('https://x.com/NASA/status/123'), 'https://x.com/NASA/status/123');
});
