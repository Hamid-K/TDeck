import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ExternalLink, List, Loader2, RefreshCw, Search } from 'lucide-react';
import type { DeckState, Request, XList } from '../shared/types';
import { safeUrl } from './config';

export function ListPicker({ state, selected, send, onSelect, preview }: {
  state: DeckState; selected: string; send: (request: Request) => Promise<boolean>;
  onSelect: (list: XList) => void | Promise<void>; preview: boolean;
}) {
  const [search, setSearch] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState('');
  const autoRequested = useRef(false);
  const lists = preview ? [] : state.lists || [];
  const status = state.listsStatus || 'idle';
  const loading = !preview && (requesting || status === 'loading');
  const visible = lists.filter(list => `${list.name} ${list.description || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const failed = !preview && (status === 'error' || status === 'login-required' || !!requestError);
  async function discover() {
    if (preview || requesting || status === 'loading' || resolving) return;
    setRequesting(true); setRequestError('');
    try {
      if (!await send({ type: 'LOAD_LISTS' })) setRequestError('Could not start list discovery. Try again, or paste a list URL below.');
    } catch { setRequestError('Could not start list discovery. Try again, or paste a list URL below.'); }
    finally { setRequesting(false); }
  }
  async function choose(list: XList) {
    if (resolving || loading) return;
    setResolving(list.selectionKey || list.id); setSelectionError('');
    try { await onSelect(list); }
    catch (error) { setSelectionError(error instanceof Error ? error.message : 'This list could not be opened. Refresh your lists and try again.'); }
    finally { setResolving(null); }
  }
  useEffect(() => {
    if (!autoRequested.current && state.connected && !preview && status === 'idle' && !lists.length) {
      autoRequested.current = true; void discover();
    }
  }, [state.connected, preview, status, lists.length]);
  return <section className="list-picker" aria-label="Lists in your X account" tabIndex={-1} data-autofocus>
    <div className="list-picker-heading"><div><h3>Your X lists</h3><p>Choose an existing list from your account.</p></div>{!preview && (lists.length > 0 || status !== 'idle') && <button type="button" className="list-refresh" disabled={loading || !!resolving} onClick={() => void discover()} title="Refresh lists from your signed-in X account">{loading ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}<span>{loading ? 'Reading X…' : 'Refresh'}</span></button>}</div>
    {preview ? <div className="list-picker-intro"><span className="list-picker-icon"><List size={21} /></span><p>Install TDeck in Chrome or Brave to choose lists from your signed-in X account. You can still configure a list by URL below.</p></div> : <>
      {status === 'idle' && !loading && lists.length === 0 && !failed && <div className="list-picker-intro"><span className="list-picker-icon"><List size={21} /></span><p>Bring the lists you already follow into TDeck. Discovery uses the X session in this browser.</p><button type="button" className="button secondary small" onClick={() => void discover()}>Find my X lists <ArrowRight size={13} /></button><span className="field-hint">Reads the lists visible on your X Lists page.</span></div>}
      {loading && <div className="list-loading" role="status"><Loader2 className="spin" size={15} /><span>{lists.length ? 'Refreshing your lists. Previous results are shown below.' : 'Reading the lists visible in your X account…'}</span></div>}
      {failed && <div className="list-error" role="status"><AlertCircle size={15} /><div><strong>{status === 'login-required' ? 'Sign in to see your lists' : 'Your lists need another look'}</strong><p>{state.listsError || requestError || 'Open X to check your session, then refresh.'}</p><div><button type="button" className="text-button" disabled={loading} onClick={() => void discover()}>Try again <RefreshCw size={11} /></button><a className="text-button" href="https://x.com/home" target="_blank" rel="noreferrer">Open X <ExternalLink size={11} /></a></div></div></div>}
      {lists.length > 5 && <label className="list-search"><Search size={13} /><input aria-label="Find an X list" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a list…" /></label>}
      {visible.length > 0 && <div className="list-options" role="group" aria-label="Available X lists">{visible.map(list => <button key={list.selectionKey || list.id} type="button" className={`list-option ${selected === list.id ? 'selected' : ''}`} aria-pressed={selected === list.id} disabled={loading || !!resolving} onClick={() => void choose(list)}><span className="list-option-image"><List size={17} />{safeUrl(list.image) && <img src={list.image} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span><span className="list-option-copy"><strong>{list.name}</strong>{list.description && <span className="list-description">{list.description}</span>}{list.members && <span className="list-members">{list.members}</span>}</span><span className="list-option-check">{resolving === (list.selectionKey || list.id) ? <Loader2 className="spin" size={14} /> : selected === list.id ? <Check size={14} /> : <ArrowRight size={13} />}</span></button>)}</div>}
      {resolving && <div className="list-selection-status" role="status">Opening this list on X to get its source…</div>}
      {selectionError && <p className="list-selection-error" role="alert">{selectionError}</p>}
      {!loading && status === 'ready' && lists.length === 0 && <p className="list-picker-empty">No lists were visible on X. Refresh to try again, or paste a list URL below.</p>}
      {lists.length > 0 && visible.length === 0 && <p className="list-picker-empty">No lists match “{search}”. Try a different name.</p>}
    </>}
  </section>;
}
