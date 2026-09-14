import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertCircle, ArrowDownRight, ArrowRight, Bookmark, Check, ChevronRight, CircleHelp, ExternalLink, LayoutDashboard, LayoutTemplate, List, Loader2, PanelLeft, Pause, PenLine, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import { EMPTY_STATE, type ColumnConfig, type ColumnKind, type DeckState, type Post, type Request } from '../shared/types';
import { isPreview, request, subscribe } from './api';
import { BrandMark, IconButton } from './components';
import { Column } from './Column';
import { ColumnEditor, HelpDialog, SettingsDialog } from './Dialogs';
import { columnTitle, MAX_COLUMNS, newColumn } from './config';
import { PostCard } from './PostCard';
import { LayoutsDialog } from './LayoutsDialog';

type Editor = { column: ColumnConfig; editing: boolean };

function Welcome({ onAdd, onHelp }: { onAdd: (kind?: ColumnKind, query?: string) => void; onHelp: () => void }) {
  return <div className="welcome">
    <section className="welcome-hero">
      <div className="welcome-copy"><div className="eyebrow"><span />A CLEARER VIEW</div><h2>Follow what matters.<br /><span>All in one view.</span></h2><p>Your people, your interests, your little corner of the internet. Give each one a column and let the conversation come to you.</p><div className="welcome-actions"><button className="button primary" onClick={() => onAdd()}><Plus size={17} />Create your first column</button><button className="text-button" onClick={onHelp}>Take a quick tour <ArrowRight size={14} /></button></div><div className="welcome-caption"><span className="tiny-key"><Plus size={10} /></span>Make room for curiosity.</div></div>
      <div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-caption"><span /><span>ALL YOUR SIGNAL, TOGETHER</span></div><div className="art-deck"><div className="art-column art-search"><div className="art-column-header"><Search size={13} /><b>Curiosity</b><i /></div><div className="art-post"><span className="art-avatar" /><div><i /><i /></div><p /><p /><p /></div><div className="art-picture"><span /><span /><span /></div><div className="art-line-row"><i /><i /><i /></div><div className="art-post second"><span className="art-avatar" /><div><i /><i /></div><p /><p /></div></div><div className="art-column art-people"><div className="art-column-header"><UserRound size={13} /><b>Your people</b><i /></div><div className="art-post"><span className="art-avatar" /><div><i /><i /></div><p /><p /><p /><p /></div><div className="art-line-row"><i /><i /><i /></div><div className="art-post second"><span className="art-avatar" /><div><i /><i /></div><p /><p /><p /></div></div><div className="art-column art-lists"><div className="art-column-header"><List size={13} /><b>In the loop</b><i /></div><div className="art-post"><span className="art-avatar" /><div><i /><i /></div><p /><p /><p /></div><div className="art-line-row"><i /><i /><i /></div><div className="art-post second"><span className="art-avatar" /><div><i /><i /></div><p /><p /><p /></div></div></div><span className="art-live"><Radio size={13} />A view that moves with you</span></div>
    </section>
    <section className="starter-section"><div className="section-heading"><h3>Start with a little inspiration</h3><span>Three ways to find your focus <ArrowDownRight size={14} /></span></div><div className="starter-grid"><div className="starter-card mint"><span className="starter-icon"><Search size={20} strokeWidth={1.6} /></span><div><h4>Follow a conversation</h4><p>Turn a keyword, topic, or precise search into your own always-updating feed.</p></div><div className="starter-chips"><button onClick={() => onAdd('search', '"design engineering" lang:en')}>Design engineering <Plus size={12} /></button><button onClick={() => onAdd('search', '"space exploration" lang:en')}>Space exploration <Plus size={12} /></button></div><button className="starter-link" onClick={() => onAdd('search')}>Add a search <ArrowRight size={14} /></button></div><div className="starter-card violet"><span className="starter-icon"><UserRound size={20} strokeWidth={1.6} /></span><div><h4>A front row for your people</h4><p>Keep a favorite creator, an interesting thinker, or a familiar voice in sight.</p></div><div className="starter-chips"><button onClick={() => onAdd('account', 'NASA')}>@NASA <Plus size={12} /></button><button onClick={() => onAdd('account', 'Figma')}>@Figma <Plus size={12} /></button></div><button className="starter-link" onClick={() => onAdd('account')}>Add an account <ArrowRight size={14} /></button></div><div className="starter-card amber"><span className="starter-icon"><List size={20} strokeWidth={1.6} /></span><div><h4>Bring your circle together</h4><p>Give an X list its own space. A whole community, in one thoughtful column.</p></div><div className="list-caption"><span className="mini-avatars"><i>J</i><i>M</i><i>A</i></span><span>Your existing X lists, right here.</span></div><button className="starter-link" onClick={() => onAdd('list')}>Add a list <ArrowRight size={14} /></button></div></div></section>
    <div className="welcome-bottom"><span><ShieldCheck size={14} />Local by design. Your session stays yours.</span><span>Made for a less noisy internet.</span></div>
  </div>;
}

export function App() {
  const [state, setState] = useState<DeckState>(() => structuredClone(EMPTY_STATE));
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'columns' | 'saved'>('columns');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dialog, setDialog] = useState<'settings' | 'help' | 'layouts' | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [savedSearch, setSavedSearch] = useState('');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [, setClock] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const notify = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message); toastTimer.current = setTimeout(() => setToast(''), 3500);
  }, []);
  const send = useCallback(async (message: Request): Promise<boolean> => {
    try { const next = await request(message); setState(next); setError(''); return true; }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); return false; }
  }, []);
  useEffect(() => {
    let active = true;
    request({ type: 'GET_STATE' }).then(value => { if (active) setState(value); }).catch(err => { if (active) setError(err instanceof Error ? err.message : 'Could not load your workspace.'); }).finally(() => { if (active) setLoading(false); });
    const unsubscribe = subscribe(next => { if (active) setState(next); });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', changed);
    const clock = setInterval(() => setClock(tick => tick + 1), 30_000);
    return () => { active = false; unsubscribe(); media.removeEventListener('change', changed); clearInterval(clock); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  const theme = state.settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : state.settings.theme;
  useEffect(() => { document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111415' : '#f3f4f1'); }, [theme]);
  const add = useCallback((kind: ColumnKind = 'search', query = '') => {
    if (state.columns.length >= MAX_COLUMNS) { notify(`Your workspace has reached its ${MAX_COLUMNS}-column limit.`); return; }
    setEditor({ column: newColumn(kind, query, state.columns.length), editing: false }); setDialog(null);
  }, [state.columns.length, notify]);
  async function connect() { setConnecting(true); if (await send({ type: 'CONNECT' })) notify('Connected. Your sources are starting up.'); setConnecting(false); }
  const refresh = useCallback(async () => {
    if (!state.connected) { notify('Connect X to start updating your columns.'); return; }
    setRefreshing(true); if (await send({ type: 'REFRESH' })) notify('Refresh requested. Sources update in turn.'); setRefreshing(false);
  }, [send, state.connected, notify]);
  const pause = useCallback(() => { void send({ type: 'UPDATE_SETTINGS', patch: { paused: !state.settings.paused } }); }, [send, state.settings.paused]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (editor || dialog || document.querySelector('[role="dialog"][aria-modal="true"]') || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); add(); }
      else if (event.key.toLowerCase() === 'r') { event.preventDefault(); void refresh(); }
      else if (event.key.toLowerCase() === 'p') { event.preventDefault(); pause(); }
      else if (event.key.toLowerCase() === 'b') { event.preventDefault(); setView('saved'); }
      else if (event.key.toLowerCase() === 'g') { event.preventDefault(); setView('columns'); }
      else if (event.key.toLowerCase() === 'l') { event.preventDefault(); setDialog('layouts'); }
      else if (event.key === '?') { event.preventDefault(); setDialog('help'); }
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  }, [editor, dialog, add, refresh, pause]);
  function move(id: string, direction: -1 | 1) {
    const index = state.columns.findIndex(column => column.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= state.columns.length) return;
    const columns = [...state.columns]; [columns[index], columns[nextIndex]] = [columns[nextIndex], columns[index]];
    void send({ type: 'SAVE_COLUMNS', columns }).then(ok => { if (ok) notify(`Column moved ${direction === -1 ? 'left' : 'right'}`); });
  }
  function drop(id: string) {
    if (!dragging || dragging === id) { setDragging(null); return; }
    const columns = [...state.columns];
    const from = columns.findIndex(column => column.id === dragging); const to = columns.findIndex(column => column.id === id);
    if (from >= 0 && to >= 0) { const [column] = columns.splice(from, 1); columns.splice(to, 0, column); void send({ type: 'SAVE_COLUMNS', columns }); }
    setDragging(null);
  }
  function savePost(post: Post) {
    const saved = state.bookmarks.some(item => item.id === post.id);
    void send({ type: 'BOOKMARK_TOGGLE', post }).then(ok => { if (ok) notify(saved ? 'Removed from saved posts' : 'Saved in TDeck'); });
  }
  const savedPosts = useMemo(() => state.bookmarks.filter(post => !savedSearch.trim() || `${post.text} ${post.author.name} ${post.author.handle}`.toLowerCase().includes(savedSearch.toLowerCase())), [state.bookmarks, savedSearch]);
  const readyCount = state.columns.filter(column => state.feeds[column.id]?.status === 'ready').length;
  const issueCount = state.columns.filter(column => ['error', 'login-required', 'rate-limited'].includes(state.feeds[column.id]?.status)).length;
  const loadingCount = state.columns.filter(column => state.feeds[column.id]?.status === 'loading').length;
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const health = isPreview ? 'Design preview' : state.settings.paused ? 'Updates paused' : !state.connected ? 'Ready to connect' : issueCount > 0 ? `${issueCount} ${issueCount === 1 ? 'source needs' : 'sources need'} attention` : loadingCount ? 'Updating sources' : readyCount ? `${readyCount} ${readyCount === 1 ? 'source' : 'sources'} connected` : 'Session connected';
  if (loading) return <div className="app-loading"><BrandMark large /><span>Making room for your world…</span><Loader2 className="spin" size={19} /></div>;
  return <div className={`app density-${state.settings.density}`} style={{ '--post-font-size': `${state.settings.fontSize}px` } as CSSProperties}>
    <aside className="rail" aria-label="Main navigation"><a className="brand" href="#" title="TDeck home" aria-label="TDeck home" onClick={event => { event.preventDefault(); setView('columns'); }}><BrandMark /></a><div className="rail-divider" /><nav><button className={`rail-button ${view === 'columns' ? 'active' : ''}`} aria-label="Your columns" title="Your columns · G" aria-current={view === 'columns' ? 'page' : undefined} onClick={() => setView('columns')}><LayoutDashboard size={20} /></button><button className={`rail-button ${view === 'saved' ? 'active' : ''}`} aria-label={`Saved posts (${state.bookmarks.length})`} title="Saved posts · B" aria-current={view === 'saved' ? 'page' : undefined} onClick={() => setView('saved')}><Bookmark size={19} />{state.bookmarks.length > 0 && <span className="rail-count" />}</button><button className="rail-button add-rail" aria-label="Add a column" title="Add a column · N" onClick={() => add()}><Plus size={21} /></button></nav><div className="rail-spacer" /><a className="rail-button compose-button" href="https://x.com/compose/post" target="_blank" rel="noreferrer" aria-label="Write a post on X" title="Write a post on X"><PenLine size={18} /></a><button className={`rail-button ${dialog === 'help' ? 'active' : ''}`} title="Quick guide & keyboard shortcuts · ?" aria-label="Quick guide and keyboard shortcuts" onClick={() => setDialog('help')}><CircleHelp size={19} /></button><button className={`rail-button ${dialog === 'settings' ? 'active' : ''}`} title="Settings" aria-label="Settings" onClick={() => setDialog('settings')}><Settings2 size={19} /></button><div className="rail-divider bottom-divider" /><a className="x-profile" href="https://x.com/home" target="_blank" rel="noreferrer" title="Open X in this browser" aria-label="Open X">𝕏<span className={state.connected && !isPreview ? 'connected' : ''} /></a></aside>
    <main className="main-workspace">
      {isPreview && <div className="preview-banner"><span><span className="preview-label">PREVIEW</span>Explore the workspace. Live feeds require the installed extension.</span><button onClick={() => setDialog('help')}>How it works <ArrowRight size={12} /></button></div>}
      <header className="workspace-header"><div className="workspace-heading"><div className="breadcrumb"><span>TDeck</span><ChevronRight size={11} /><span>Personal workspace</span></div><h1>{view === 'saved' ? 'Good things, kept.' : 'Your corner of X.'}<span className="header-dot"> </span></h1></div><div className="header-actions"><span className="header-date">{date}</span><button className="button secondary layouts-button" onClick={() => setDialog('layouts')} title="Saved layouts · L" aria-label="Saved layouts"><LayoutTemplate size={15} /><span>Layouts</span></button>{!state.connected ? <button className="button secondary connect-button" onClick={connect} disabled={connecting}><span className="x-character">𝕏</span>{connecting ? 'Connecting…' : 'Connect X'}{connecting ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}</button> : <><IconButton label="Refresh all columns · R" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={17} className={refreshing ? 'spin' : ''} /></IconButton><button className={`button secondary pause-button ${state.settings.paused ? 'resume' : ''}`} onClick={pause}>{state.settings.paused ? <Play size={14} /> : <Pause size={14} />}{state.settings.paused ? 'Resume' : 'Pause'}</button></>}<button className="button primary add-column-button" onClick={() => add()} disabled={state.columns.length >= MAX_COLUMNS}><Plus size={16} /><span>Add column</span><kbd>N</kbd></button></div></header>
      <div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="Workspace view"><button role="tab" id="columns-tab" aria-selected={view === 'columns'} aria-controls="columns-panel" className={view === 'columns' ? 'active' : ''} onClick={() => setView('columns')}><PanelLeft size={14} />All columns <span>{state.columns.length}</span></button><button role="tab" id="saved-tab" aria-selected={view === 'saved'} aria-controls="saved-panel" className={view === 'saved' ? 'active' : ''} onClick={() => setView('saved')}><Bookmark size={13} />Saved <span>{state.bookmarks.length}</span></button></div><div className={`workspace-health ${state.settings.paused ? 'paused' : issueCount ? 'warning' : state.connected && !isPreview ? 'connected' : ''}`} title={state.connected ? 'TDeck reads X using your browser session. Keep its source window open and unminimized for updates.' : 'Connect your existing X session to start your sources.'}>{loadingCount && !state.settings.paused ? <Loader2 size={11} className="spin" /> : <i />}<span>{health}</span>{state.connected && !isPreview && !state.settings.paused && <span className="auto-label">AUTO UPDATES</span>}</div></div>
      {error && <div className="global-error" role="alert"><AlertCircle size={17} /><p>{error}</p><IconButton label="Dismiss error" onClick={() => setError('')}><X size={16} /></IconButton></div>}
      {view === 'columns' ? <div className={`columns-panel ${state.columns.length ? 'has-columns' : ''}`} role="tabpanel" id="columns-panel" aria-labelledby="columns-tab">{state.columns.length === 0 ? <Welcome onAdd={add} onHelp={() => setDialog('help')} /> : <><div className="columns-track" ref={track}>{state.columns.map((column, index) => <Column key={column.id} column={column} state={state} index={index} total={state.columns.length} send={send} onEdit={() => setEditor({ column, editing: true })} onMove={direction => move(column.id, direction)} onSave={savePost} notify={notify} onDrop={() => drop(column.id)} onDragStart={() => setDragging(column.id)} onDragEnd={() => setDragging(null)} dragging={dragging === column.id} />)}{state.columns.length < MAX_COLUMNS && <button className="add-column-card" onClick={() => add()}><span><Plus size={23} strokeWidth={1.5} /></span><strong>A little more perspective</strong><p>Add another column</p><kbd>N</kbd></button>}</div><div className="workspace-bottom"><span><span className="keyboard-hint">?</span><button onClick={() => setDialog('help')}>Keyboard shortcuts</button></span><span>{state.columns.length} / {MAX_COLUMNS} columns<span className="footer-dot">·</span>Scroll sideways to explore <ArrowRight size={11} /></span></div></>}</div> : <div className="saved-panel" role="tabpanel" id="saved-panel" aria-labelledby="saved-tab"><div className="saved-heading"><div><span className="eyebrow">YOUR PERSONAL COLLECTION</span><h2>Worth coming back to.</h2><p>Posts you saved in TDeck, kept on this device.</p></div>{state.bookmarks.length > 0 && <div className="saved-search"><Search size={16} /><input aria-label="Search saved posts" placeholder="Find something you saved…" value={savedSearch} onChange={event => setSavedSearch(event.target.value)} />{savedSearch && <IconButton label="Clear saved search" onClick={() => setSavedSearch('')}><X size={14} /></IconButton>}</div>}</div>{savedPosts.length > 0 ? <div className="saved-grid">{savedPosts.map(post => <PostCard key={post.id} post={post} saved settings={state.settings} onSave={savePost} notify={notify} />)}</div> : <div className="saved-empty"><span className="saved-empty-art"><Bookmark size={33} strokeWidth={1.3} /><Sparkles size={16} /></span><h3>{savedSearch ? 'No saved posts match' : 'Leave yourself something good.'}</h3><p>{savedSearch ? 'Try another word, handle, or phrase.' : 'See a post you want to revisit? Tap its bookmark. It will be waiting right here.'}</p>{savedSearch ? <button className="button secondary" onClick={() => setSavedSearch('')}>Clear search</button> : <button className="button secondary" onClick={() => setView('columns')}>Back to your columns <ArrowRight size={14} /></button>}</div>}</div>}
    </main>
    {editor && <ColumnEditor key={editor.column.id} initial={editor.column} editing={editor.editing} state={state} send={send} onClose={() => setEditor(null)} />}
    {dialog === 'settings' && <SettingsDialog state={state} send={send} notify={notify} requestError={error} onClose={() => setDialog(null)} onLayouts={() => setDialog('layouts')} />}
    {dialog === 'layouts' && <LayoutsDialog state={state} send={send} notify={notify} requestError={error} onClose={() => setDialog(null)} onRestored={() => { setView('columns'); setDialog(null); }} />}
    {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
    <div className="toast-region" aria-live="polite" aria-atomic="true">{toast && <div className="toast"><Check size={15} /><span>{toast}</span><IconButton label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></IconButton></div>}</div>
  </div>;
}
