import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CheckCheck, ChevronDown, Download, ExternalLink, FileJson, Laptop, LayoutTemplate, List, Moon, Plus, Search, ShieldCheck, Sun, Trash2, Upload, UserRound } from 'lucide-react';
import type { ColumnConfig, ColumnKind, DeckState, Request, Settings } from '../shared/types';
import { cleanQuery, COLORS, columnTitle, validateImport } from './config';
import { Modal, Toggle } from './components';
import { ListPicker } from './ListPicker';
import { isPreview, request } from './api';

export function ColumnEditor({ initial, editing, state, send, onClose }: { initial: ColumnConfig; editing: boolean; state: DeckState; send: (request: Request) => Promise<boolean>; onClose: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [muted, setMuted] = useState(initial.mutedWords.join(', '));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [resolvingList, setResolvingList] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = (value: Partial<ColumnConfig>) => { setDraft(current => ({ ...current, ...value })); setError(''); };
  const sourceDescriptions = { search: 'Follow keywords, conversations, or a precise X search.', account: 'Keep up with posts from a single X account.', list: 'Bring the people in an X list into their own column.' };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (resolvingList) return;
    try {
      const query = cleanQuery(draft.kind, draft.query);
      const mutedWords = [...new Set(muted.split(',').map(word => word.trim()).filter(Boolean))];
      if (mutedWords.length > 50 || mutedWords.some(word => word.length > 100)) throw new Error('Use up to 50 muted words, each under 100 characters.');
      const title = draft.title.trim() || (draft.kind === 'list' ? 'My list' : draft.kind === 'account' ? `@${query}` : query.slice(0, 60));
      const column = { ...draft, title, query, mutedWords };
      setSaving(true);
      const columns = editing ? state.columns.map(item => item.id === initial.id ? column : item) : [...state.columns, column];
      if (await send({ type: 'SAVE_COLUMNS', columns })) onClose();
      else setError('The column could not be saved. Check the message and try again.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Check the column settings.'); }
    finally { setSaving(false); }
  }
  async function remove() {
    setSaving(true);
    if (await send({ type: 'SAVE_COLUMNS', columns: state.columns.filter(column => column.id !== initial.id) })) onClose();
    else setSaving(false);
  }
  return <Modal title={editing ? 'Make it your column' : 'Find your next signal'} subtitle={editing ? 'A few details. A better view.' : 'Choose a source and make some room for it.'} onClose={onClose} className="column-editor">
    <form onSubmit={save}>
      <div className="modal-body">
        <div className="source-kind-picker" role="group" aria-label="Column source type">{([{ kind: 'search', label: 'Search', Icon: Search }, { kind: 'account', label: 'Account', Icon: UserRound }, { kind: 'list', label: 'List', Icon: List }] as const).map(({ kind, label, Icon }) => <button type="button" key={kind} className={draft.kind === kind ? 'active' : ''} aria-pressed={draft.kind === kind} disabled={resolvingList} onClick={() => patch({ kind, query: draft.kind === kind ? draft.query : '' })}><Icon size={18} /><span>{label}</span>{draft.kind === kind && <Check size={13} />}</button>)}</div>
        {draft.kind === 'list' && <ListPicker state={state} selected={draft.query} send={send} onSelect={async list => {
          setResolvingList(true);
          try {
            let selected = list;
            if (!/^\d{1,25}$/.test(list.id)) {
              if (!list.selectionKey) throw new Error('This list needs to be discovered again. Refresh your lists and retry.');
              const result = await request({ type: 'RESOLVE_LIST', selectionKey: list.selectionKey });
              const resolved = result.lists?.find(item => item.selectionKey === list.selectionKey && /^\d{1,25}$/.test(item.id));
              if (!resolved) throw new Error('X did not open this list. Refresh your lists and try again, or paste its URL below.');
              selected = resolved;
            }
            patch({ query: selected.id, title: selected.name.slice(0, 60) });
          } finally { setResolvingList(false); }
        }} preview={isPreview} />}
        <div className="field"><label htmlFor="column-query">{draft.kind === 'search' ? 'Search query' : draft.kind === 'account' ? 'X account' : 'Or paste a list URL or ID'} <span>Required</span></label><input id="column-query" data-autofocus={draft.kind === 'list' ? undefined : true} value={draft.query} disabled={resolvingList} onChange={event => patch({ query: event.target.value })} maxLength={500} placeholder={draft.kind === 'search' ? 'e.g. space exploration lang:en' : draft.kind === 'account' ? '@NASA or x.com/NASA' : 'https://x.com/i/lists/…'} autoComplete="off" spellCheck={false} required /><p className="field-hint">{sourceDescriptions[draft.kind]}</p></div>
        {draft.kind === 'search' && <div className="search-tips"><span>Make it precise</span><code>"exact phrase"</code><code>from:handle</code><code>lang:en</code><code>-exclude</code></div>}
        <div className="field"><label htmlFor="column-title">Column name <span>Optional</span></label><input id="column-title" value={draft.title} disabled={resolvingList} onChange={event => patch({ title: event.target.value })} maxLength={60} placeholder={draft.kind === 'search' ? 'e.g. The space beat' : draft.kind === 'account' ? 'e.g. NASA' : 'e.g. My reading list'} /></div>
        <div className="form-two-up"><div className="field"><label>Accent color</label><div className="color-picker" role="group" aria-label="Column accent color">{COLORS.map((color, index) => <button type="button" key={color} style={{ background: color }} aria-label={['Mint', 'Lavender', 'Amber', 'Sky', 'Rose', 'Sage'][index]} title={['Mint', 'Lavender', 'Amber', 'Sky', 'Rose', 'Sage'][index]} className={draft.color === color ? 'active' : ''} aria-pressed={draft.color === color} onClick={() => patch({ color })}>{draft.color === color && <Check size={14} />}</button>)}</div></div><div className="field"><label htmlFor="column-refresh">Check for new posts</label><div className="select-wrap"><select id="column-refresh" value={draft.refreshSeconds} onChange={event => patch({ refreshSeconds: Number(event.target.value) })}>{[60, 120, 180, 300, 600, 900, 1800].map(seconds => <option value={seconds} key={seconds}>Every {seconds / 60} {seconds === 60 ? 'minute' : 'minutes'}</option>)}</select><ChevronDown size={14} /></div></div></div>
        <div className="field range-field"><label htmlFor="column-width">Column width <span>{draft.width}px</span></label><input id="column-width" type="range" min={300} max={640} step={20} value={draft.width} onChange={event => patch({ width: Number(event.target.value) })} /><div className="range-labels"><span>Focused</span><span>Roomy</span></div></div>
        <details className="advanced-settings"><summary>Filters & update controls<ChevronDown size={15} /></summary><div className="advanced-body"><Toggle checked={draft.mediaOnly} onChange={mediaOnly => patch({ mediaOnly })} label="Only posts with media" description="Keep posts that include an image or video." /><Toggle checked={draft.hideReplies} onChange={hideReplies => patch({ hideReplies })} label="Hide replies" description="Filter posts marked as replies by X." /><Toggle checked={draft.paused} onChange={paused => patch({ paused })} label="Pause this column" description="Keep the view, take a break from updates." /><div className="field"><label htmlFor="muted-words">Muted words <span>Comma separated</span></label><input id="muted-words" value={muted} onChange={event => setMuted(event.target.value)} placeholder="giveaway, sponsored, spoiler" /><p className="field-hint">Local filters apply to posts already read from this source.</p></div></div></details>
        {!state.connected && <div className="info-note"><ShieldCheck size={17} /><p>After adding your columns, connect X to start. TDeck reads ordinary X pages in its own source window using your signed-in session. Keep that window open and unminimized for updates.</p></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {confirmDelete && <div className="delete-confirm"><strong>Remove “{columnTitle(initial)}”?</strong><p>Its cached feed and source tab will be removed. Your saved posts stay in TDeck.</p><div><button type="button" className="button secondary small" onClick={() => setConfirmDelete(false)}>Keep column</button><button type="button" className="button danger small" disabled={saving} onClick={remove}>Remove column</button></div></div>}
      </div>
      <div className="modal-footer">{editing ? <button type="button" className="text-button delete-button" disabled={saving || resolvingList} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />Remove</button> : <span className="footer-note">A little focus goes a long way.</span>}<div><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={saving || resolvingList}>{saving ? 'Saving…' : resolvingList ? 'Opening list…' : editing ? 'Save changes' : 'Add column'}{!saving && !resolvingList && (editing ? <Check size={15} /> : <Plus size={15} />)}</button></div></div>
    </form>
  </Modal>;
}

export function SettingsDialog({ state, send, notify, onClose, onLayouts, requestError }: { state: DeckState; send: (request: Request) => Promise<boolean>; notify: (message: string) => void; onClose: () => void; onLayouts: () => void; requestError?: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<ReturnType<typeof validateImport> | null>(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const patch = async (value: Partial<Settings>) => { setSaveFailed(false); if (!await send({ type: 'UPDATE_SETTINGS', patch: value })) setSaveFailed(true); };
  async function importFile(file?: File) {
    setImportError(''); setImported(null);
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error('Choose a workspace file smaller than 1 MB.');
      setImported(validateImport(JSON.parse(await file.text())));
    } catch (error) { setImportError(error instanceof Error ? error.message : 'This file could not be read.'); }
    if (fileInput.current) fileInput.current.value = '';
  }
  function exportFile() {
    const data = { app: 'tdeck', version: 1, columns: state.columns, settings: state.settings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tdeck-workspace-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Workspace settings exported');
  }
  async function applyImport() {
    if (!imported) return;
    setImporting(true); setSaveFailed(false);
    if (await send({ type: 'IMPORT_CONFIG', ...imported })) { setImported(null); notify('Workspace imported'); }
    else setSaveFailed(true);
    setImporting(false);
  }
  return <Modal title="Settle into your space" subtitle="Small adjustments. Just the way you like it." onClose={onClose} className="settings-dialog">
    <div className="modal-body">
      {saveFailed && <p className="form-error settings-save-error" role="alert">{requestError || 'Your preferences could not be saved. Please try again.'}</p>}
      <section className="settings-section"><h3>Appearance</h3><div className="theme-picker" role="group" aria-label="Color theme">{([{ value: 'dark', label: 'Dark', Icon: Moon }, { value: 'light', label: 'Light', Icon: Sun }, { value: 'system', label: 'System', Icon: Laptop }] as const).map(({ value, label, Icon }) => <button key={value} className={state.settings.theme === value ? 'active' : ''} aria-pressed={state.settings.theme === value} onClick={() => patch({ theme: value })}><span className={`theme-preview theme-${value}`}><i /><i /><i /></span><span><Icon size={13} />{label}{state.settings.theme === value && <Check size={13} />}</span></button>)}</div><div className="inline-setting"><div><span className="setting-label">Density</span><span className="setting-description">Find your reading rhythm.</span></div><div className="segmented" role="group" aria-label="Post density"><button className={state.settings.density === 'comfortable' ? 'active' : ''} aria-pressed={state.settings.density === 'comfortable'} onClick={() => patch({ density: 'comfortable' })}>Comfortable</button><button className={state.settings.density === 'compact' ? 'active' : ''} aria-pressed={state.settings.density === 'compact'} onClick={() => patch({ density: 'compact' })}>Compact</button></div></div><div className="inline-setting"><label htmlFor="font-size"><span className="setting-label">Post text size</span><span className="setting-description">A little more breathing room.</span></label><div className="font-size-control"><span>Aa</span><input id="font-size" type="range" min={12} max={18} step={1} value={state.settings.fontSize} onChange={event => patch({ fontSize: Number(event.target.value) })} /><span>{state.settings.fontSize}</span></div></div><Toggle checked={state.settings.showMedia} onChange={showMedia => patch({ showMedia })} label="Show images & video previews" description="Videos open on X when you choose to watch." /></section>
      <section className="settings-section"><h3>New posts</h3><div className="arrival-options"><label className={state.settings.arrivalMode === 'automatic' ? 'active' : ''}><input type="radio" name="arrival-mode" checked={state.settings.arrivalMode === 'automatic'} onChange={() => patch({ arrivalMode: 'automatic' })} /><span><strong>Keep it flowing</strong><span>New posts arrive at the top. Your reading position stays in place.</span></span><span className="recommended">Default</span></label><label className={state.settings.arrivalMode === 'queue' ? 'active' : ''}><input type="radio" name="arrival-mode" checked={state.settings.arrivalMode === 'queue'} onChange={() => patch({ arrivalMode: 'queue' })} /><span><strong>On your terms</strong><span>Collect new posts behind a button until you’re ready.</span></span></label></div><p className="field-hint">Sources update in turn, at least 15 seconds apart. Busy workspaces and X rate limits may take longer than a column’s interval.</p></section>
      <section className="settings-section"><h3>Your workspace</h3><button className="settings-layout-link" onClick={onLayouts}><LayoutTemplate size={18} /><span><strong>Saved layouts</strong><span>Keep named snapshots of your columns and preferences.</span></span><ArrowRight size={15} /></button><p className="setting-description">Export or import the current workspace. Named layouts, saved posts, and browser sessions are not included.</p><div className="workspace-actions"><button className="button secondary" onClick={exportFile}><Download size={15} />Export settings</button><button className="button secondary" onClick={() => fileInput.current?.click()}><Upload size={15} />Import settings</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event => void importFile(event.target.files?.[0])} /></div>{importError && <p className="form-error" role="alert">{importError}</p>}{imported && <div className="import-confirm"><FileJson size={21} /><div><strong>Replace your workspace?</strong><p>Import {imported.columns.length} {imported.columns.length === 1 ? 'column' : 'columns'} and display preferences. Existing columns will be replaced; saved posts will stay.</p><div><button className="button secondary small" onClick={() => setImported(null)}>Cancel</button><button className="button primary small" disabled={importing} onClick={applyImport}>{importing ? 'Importing…' : 'Replace & import'}</button></div></div></div>}</section>
      <div className="privacy-note"><ShieldCheck size={17} /><p>Stored on this device. No TDeck server, analytics, or stored passwords. Your X session stays in your browser.</p></div>
    </div><div className="modal-footer"><span className="footer-note"><CheckCheck size={14} />Preferences save automatically</span><button className="button primary" onClick={onClose}>Done <Check size={15} /></button></div>
  </Modal>;
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const shortcuts = [['N', 'Add a column'], ['R', 'Refresh all sources'], ['P', 'Pause or resume updates'], ['B', 'Open saved posts'], ['G', 'Go to your columns'], ['L', 'Open saved layouts'], ['?', 'Open this guide'], ['Esc', 'Close a dialog']];
  return <Modal title="A good place to get oriented" subtitle="Your X sources, with a little more room to think." onClose={onClose} className="help-dialog">
    <div className="modal-body">
      <section className="settings-section"><h3>Make yourself at home</h3><div className="help-steps">
        <div><span>01</span><p><strong>Build your view.</strong> Add a search, an account, or a list from your X account. Each column scrolls independently, with older posts loading as you go.</p></div>
        <div><span>02</span><p><strong>Connect your session.</strong> Sign in to X in this browser, then select Connect X. TDeck reads ordinary X pages in its own source window. Keep TDeck’s source window open and unminimized so X can render new posts.</p></div>
        <div><span>03</span><p><strong>Make it yours.</strong> Drag a column’s handle to reorder it, or use Move left / right in its menu. Your workspace saves automatically. Use Layouts to keep named snapshots you can restore later.</p></div>
      </div></section>
      <section className="settings-section"><h3>A few handy shortcuts</h3><div className="keyboard-list">{shortcuts.map(([key, label]) => <div key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div></section>
      <section className="settings-section"><h3>Worth knowing</h3><p className="help-copy">Bookmarks and layouts are saved locally in TDeck. Replies, likes, reposts, and videos open on X. Search results depend on what your account can see; polling is not an exhaustive real-time stream. If X asks you to sign in or complete a check, open the affected source and resolve it there.</p><p className="help-copy">Keep the source window open and unminimized while you use the dashboard. Updates wait while you are using that window. Use Pause when you’re taking a break.</p><a className="text-button" href="https://x.com/search" target="_blank" rel="noreferrer">Open X search <ExternalLink size={13} /></a></section>
    </div>
    <div className="modal-footer"><span className="footer-note">TDeck · A quieter way to keep up.</span><button className="button primary" onClick={onClose}>Got it <ArrowRight size={15} /></button></div>
  </Modal>;
}
