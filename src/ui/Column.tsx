import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ExternalLink, GripVertical, List, Loader2, MoreHorizontal, Pause, Play, RefreshCw, Search, Settings2, UserRound, X } from 'lucide-react';
import type { ColumnConfig, DeckState, Feed, Post, Request } from '../shared/types';
import { EMPTY_FEED } from '../shared/types';
import { MAX_POSTS } from '../shared/core';
import { columnTitle, sourceUrl } from './config';
import { IconButton } from './components';
import { PostCard, relativeTime } from './PostCard';
import { isPreview } from './api';

export const sourceIcons = { search: Search, account: UserRound, list: List };
const statusLabels: Record<Feed['status'], string> = { idle: 'Not started', loading: 'Updating', ready: 'Connected', paused: 'Paused', 'login-required': 'Sign in needed', 'rate-limited': 'Cooling down', error: 'Needs attention' };

export function Column({ column, state, index, total, send, onEdit, onMove, onSave, notify, onDrop, onDragStart, onDragEnd, dragging }: {
  column: ColumnConfig; state: DeckState; index: number; total: number;
  send: (request: Request) => Promise<boolean>; onEdit: () => void; onMove: (direction: -1 | 1) => void;
  onSave: (post: Post) => void; notify: (message: string) => void; onDrop: () => void; onDragStart: () => void; onDragEnd: () => void; dragging: boolean;
}) {
  const feed = state.feeds[column.id] || EMPTY_FEED;
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id?: string; offset: number; top: number }>({ offset: 0, top: 0 });
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [atTop, setAtTop] = useState(true);
  const paused = column.paused || state.settings.paused;
  const cacheFull = feed.posts.length >= MAX_POSTS;
  const hasError = ['error', 'login-required', 'rate-limited'].includes(feed.status);
  const Icon = sourceIcons[column.kind];
  const visiblePosts = useMemo(() => feed.posts.filter(post => (!column.mediaOnly || post.media.length > 0) && (!column.hideReplies || !post.isReply) && !column.mutedWords.some(word => word.trim() && `${post.text} ${post.author.name} ${post.author.handle}`.toLowerCase().includes(word.toLowerCase()))), [feed.posts, column.mediaOnly, column.hideReplies, column.mutedWords]);
  const savedIds = useMemo(() => new Set(state.bookmarks.map(post => post.id)), [state.bookmarks]);
  function rememberAnchor() {
    const element = scroller.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const visible = Array.from(element.querySelectorAll<HTMLElement>('[data-post-id]')).find(post => post.getBoundingClientRect().bottom > top + 1);
    anchor.current = { id: visible?.dataset.postId, offset: visible ? visible.getBoundingClientRect().top - top : 0, top: element.scrollTop };
    setAtTop(element.scrollTop < 120);
  }
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (anchor.current.top > 24 && anchor.current.id) {
      const post = Array.from(element.querySelectorAll<HTMLElement>('[data-post-id]')).find(item => item.dataset.postId === anchor.current.id);
      if (post) element.scrollTop += post.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset;
    } else if (anchor.current.top <= 24) element.scrollTop = 0;
    rememberAnchor();
  }, [visiblePosts]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(false); menuButton.current?.focus(); } };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => {
    if (!sentinel.current || !scroller.current || !state.connected || !visiblePosts.length || cacheFull || !feed.hasMore || feed.loadingOlder || feed.status === 'loading' || hasError || paused) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void send({ type: 'LOAD_OLDER', columnId: column.id }); }, { root: scroller.current, rootMargin: '0px 0px 160px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [column.id, cacheFull, feed.hasMore, feed.loadingOlder, feed.status, hasError, paused, state.connected, visiblePosts.length, send]);
  function top() { scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }); }
  const filterCount = Number(column.mediaOnly) + Number(column.hideReplies) + column.mutedWords.length;
  return <section className={`feed-column ${dragging ? 'is-dragging' : ''}`} style={{ '--column-color': column.color, '--column-width': `${column.width}px` } as CSSProperties} aria-label={`${columnTitle(column)} column`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); onDrop(); }}>
    <div className="column-heading">
      <span className="source-symbol"><Icon size={17} /></span>
      <div className="column-title-block"><h2 title={columnTitle(column)}>{columnTitle(column)}</h2><span className="column-query" title={column.query}>{column.kind === 'search' ? column.query : column.kind === 'account' ? `Posts by @${column.query}` : `List · ${column.query}`}</span></div>
      <button className="drag-handle" draggable title="Drag to reorder; move buttons are also in column options" aria-label="Drag to reorder column" onDragStart={event => { event.dataTransfer.setData('text/plain', column.id); event.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd}><GripVertical size={15} /></button>
      <div className="column-menu-wrap" ref={menuRef}>
        <button ref={menuButton} className={`icon-button ${menu ? 'selected' : ''}`} title="Column options" aria-label={`Options for ${columnTitle(column)}`} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}><MoreHorizontal size={19} /></button>
        {menu && <div className="column-menu" role="menu"><button role="menuitem" onClick={() => { setMenu(false); onEdit(); }}><Settings2 size={15} />Edit column</button><button role="menuitem" onClick={() => { setMenu(false); void send({ type: 'SAVE_COLUMNS', columns: state.columns.map(item => item.id === column.id ? { ...item, paused: !item.paused } : item) }); }} >{column.paused ? <Play size={15} /> : <Pause size={15} />}{column.paused ? 'Resume column' : 'Pause column'}</button><button role="menuitem" onClick={() => { setMenu(false); void send({ type: 'REFRESH', columnId: column.id }); }} disabled={!state.connected}><RefreshCw size={15} />Refresh now</button><button role="menuitem" onClick={() => { setMenu(false); void send({ type: 'OPEN_SOURCE', columnId: column.id }); }} disabled={!state.connected}><ExternalLink size={15} />Open source tab</button><div className="menu-divider" /><button role="menuitem" disabled={index === 0} onClick={() => { onMove(-1); setMenu(false); }}><ArrowLeft size={15} />Move left</button><button role="menuitem" disabled={index === total - 1} onClick={() => { onMove(1); setMenu(false); }}><ArrowRight size={15} />Move right</button></div>}
      </div>
    </div>
    <div className="column-meta"><span className={`feed-status ${paused ? 'paused' : feed.status}`} title={feed.lastUpdated ? `Last checked ${new Date(feed.lastUpdated).toLocaleString()}` : undefined}>{!paused && feed.status === 'loading' ? <Loader2 className="spin" size={10} /> : <i />}{isPreview ? 'Preview' : paused ? 'Paused' : statusLabels[feed.status]}</span><span>{filterCount > 0 && <button className="filter-indicator" onClick={onEdit} title="Edit local filters"><Settings2 size={11} />{filterCount}</button>}{visiblePosts.length > 0 ? `${visiblePosts.length} posts` : `Every ${Math.round(column.refreshSeconds / 60)} min`}</span></div>
    {feed.pending.length > 0 && <button className="new-posts" onClick={() => { anchor.current = { top: 0, offset: 0 }; void send({ type: 'MARK_READ', columnId: column.id }); top(); }}><ArrowUp size={14} />Show {feed.pending.length} new {feed.pending.length === 1 ? 'post' : 'posts'}</button>}
    {hasError && <div className="feed-notice" role="status"><AlertCircle size={15} /><div><strong>{feed.status === 'login-required' ? 'Your X session needs attention' : feed.status === 'rate-limited' ? 'X needs a little time' : 'Could not update this source'}</strong><p>{feed.error || 'Open the source tab to check its status, then try refreshing.'}</p><button onClick={() => void send({ type: 'OPEN_SOURCE', columnId: column.id })}>Check on X <ExternalLink size={11} /></button></div></div>}
    <div className="column-scroll" ref={scroller} onScroll={rememberAnchor} tabIndex={0} aria-label={`Scroll ${columnTitle(column)}`}>
      {visiblePosts.map(post => <PostCard key={post.id} post={post} saved={savedIds.has(post.id)} settings={state.settings} onSave={onSave} notify={notify} />)}
      {visiblePosts.length === 0 && (feed.status === 'loading' && !paused ? <div className="skeleton-feed" aria-label="Loading posts">{[0, 1, 2].map(number => <div className="skeleton-card" key={number}><div className="skeleton-byline"><i /><span><b /><b /></span></div><em /><em /><em className="short" />{number === 1 && <div className="skeleton-media" />}</div>)}<span className="loading-label">Reading your X source…</span></div> : <div className="empty-column"><span className="empty-column-icon"><Icon size={26} strokeWidth={1.4} /></span><h3>{isPreview ? 'Your feed goes here' : !state.connected ? 'Ready when you are' : paused ? 'Taking a breather' : hasError ? 'Let’s reconnect' : feed.posts.length ? 'No posts match your filters' : 'Nothing here just yet'}</h3><p>{isPreview ? 'Install TDeck in Chrome or Brave to fill this column with real posts from X.' : !state.connected ? 'Connect your X session to start following this source.' : paused ? 'Resume updates whenever you’re ready. Your column settings are saved.' : hasError ? 'The source message above has the details.' : feed.posts.length ? 'Try adjusting your media, reply, or muted-word filters.' : 'This source has no visible posts yet. New matches will appear here automatically.'}</p>{!state.connected && !isPreview && <button className="button secondary small" onClick={() => void send({ type: 'CONNECT' })}>Connect X <ArrowRight size={13} /></button>}{isPreview && <a href={sourceUrl(column)} target="_blank" rel="noreferrer" className="text-button">View this source on X <ExternalLink size={13} /></a>}{feed.posts.length > 0 && <button className="text-button" onClick={onEdit}>Adjust filters <Settings2 size={13} /></button>}</div>)}
      {(visiblePosts.length > 0 || cacheFull) && <div className={`feed-end ${cacheFull ? 'cache-full' : ''}`} ref={sentinel}>{cacheFull ? <><span>Recent-post cache is full</span><a className="text-button" href={sourceUrl(column)} target="_blank" rel="noreferrer">Continue on X <ExternalLink size={12} /></a></> : feed.loadingOlder ? <><Loader2 className="spin" size={15} /><span>Loading earlier posts</span></> : feed.hasMore ? <button className="text-button" disabled={!state.connected || feed.status === 'loading'} onClick={() => void send({ type: 'LOAD_OLDER', columnId: column.id })}><ArrowDown size={14} />Load earlier posts</button> : <><Check size={14} /><span>No earlier posts available in this source</span></>}</div>}
    </div>
    {!atTop && <button className="back-to-top" onClick={top} title="Back to newest posts"><ArrowUp size={14} />Back to top</button>}
    <div className="column-footer"><span>{feed.lastUpdated ? `Checked ${relativeTime(new Date(feed.lastUpdated).toISOString()) === 'now' ? 'just now' : `${relativeTime(new Date(feed.lastUpdated).toISOString())} ago`}` : 'Latest posts first'}</span><a href={sourceUrl(column)} target="_blank" rel="noreferrer" title="Open this source on X">View on X <ExternalLink size={10} /></a></div>
  </section>;
}
