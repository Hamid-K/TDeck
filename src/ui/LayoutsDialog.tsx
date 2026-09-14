import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowRight, Check, CheckCheck, LayoutTemplate, Loader2, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { MAX_LAYOUTS } from '../shared/core';
import type { ColumnConfig, DeckState, Layout, Request } from '../shared/types';
import { columnTitle } from './config';
import { IconButton, Modal } from './components';

function LayoutPreview({ columns }: { columns: ColumnConfig[] }) {
  return <div className={`layout-preview ${columns.length ? '' : 'empty'}`} aria-hidden="true">{columns.length ? columns.map(column => <span key={column.id} className="layout-preview-column" style={{ '--preview-accent': column.color, flexGrow: column.width } as CSSProperties}><i /><i /><i /></span>) : <LayoutTemplate size={22} strokeWidth={1.3} />}</div>;
}

function savedDate(timestamp: number) {
  return timestamp > 0 ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'this device';
}

export function LayoutsDialog({ state, send, notify, onClose, onRestored, requestError }: {
  state: DeckState; send: (request: Request) => Promise<boolean>; notify: (message: string) => void;
  onClose: () => void; onRestored: () => void; requestError?: string;
}) {
  const layouts = state.layouts || [];
  const [name, setName] = useState('');
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'restore' | 'update' | 'delete'; id: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const atLimit = layouts.length >= MAX_LAYOUTS;
  const currentSignature = JSON.stringify([state.columns, state.settings]);
  useEffect(() => { if (rename) { renameInput.current?.focus(); renameInput.current?.select(); } }, [rename?.id]);
  useEffect(() => { confirmation.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [confirm?.id, confirm?.kind]);

  function validateName(value: string, id?: string) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80) throw new Error('Choose a layout name between 1 and 80 characters.');
    if (layouts.some(layout => layout.id !== id && layout.name.toLowerCase() === trimmed.toLowerCase())) throw new Error('That name is already in your saved layouts. Choose another name, or update the existing layout.');
    return trimmed;
  }
  async function run(message: Request, key: string, complete: () => void) {
    if (working) return;
    setWorking(key); setError(''); setFailed(false);
    try { if (await send(message)) complete(); else setFailed(true); }
    catch (err) { setError(err instanceof Error ? err.message : 'This layout could not be changed. Please try again.'); }
    finally { setWorking(null); }
  }
  async function saveNew(event: FormEvent) {
    event.preventDefault();
    if (atLimit || working) return;
    try {
      const value = validateName(name);
      await run({ type: 'SAVE_LAYOUT', name: value }, 'create', () => { setName(''); notify(`Saved layout “${value}”`); });
    } catch (err) { setError(err instanceof Error ? err.message : 'Check the layout name.'); }
  }
  async function renameLayout(event: FormEvent) {
    event.preventDefault();
    if (!rename || working) return;
    try {
      const value = validateName(rename.name, rename.id);
      await run({ type: 'RENAME_LAYOUT', layoutId: rename.id, name: value }, rename.id, () => { setRename(null); notify('Layout renamed'); });
    } catch (err) { setError(err instanceof Error ? err.message : 'Check the layout name.'); }
  }
  function ask(kind: 'restore' | 'update' | 'delete', layout: Layout) {
    setConfirm({ kind, id: layout.id }); setRename(null); setError(''); setFailed(false);
  }
  async function apply(layout: Layout) {
    if (!confirm || working) return;
    if (confirm.kind === 'restore') await run({ type: 'LOAD_LAYOUT', layoutId: layout.id }, layout.id, () => { notify(`Restored “${layout.name}”`); onRestored(); });
    else if (confirm.kind === 'update') await run({ type: 'SAVE_LAYOUT', id: layout.id, name: layout.name }, layout.id, () => { setConfirm(null); notify(`Updated “${layout.name}”`); });
    else await run({ type: 'DELETE_LAYOUT', layoutId: layout.id }, layout.id, () => { setConfirm(null); notify('Saved layout deleted'); });
  }
  return <Modal title="A view for every kind of day" subtitle="Save your favorite arrangements and come back to them." className="layouts-dialog" onClose={onClose}>
    <div className="modal-body">
      <div className="layout-autosave"><CheckCheck size={15} /><p>Your current workspace saves automatically. Named layouts keep a separate snapshot you can restore later.</p></div>
      <section className="current-layout"><div className="current-layout-heading"><div><span className="eyebrow">YOUR CURRENT VIEW</span><h3>{state.columns.length} {state.columns.length === 1 ? 'column' : 'columns'}, arranged your way.</h3><p>Includes sources, order, widths, filters, and display preferences.</p></div><LayoutPreview columns={state.columns} /></div><form onSubmit={saveNew} className="layout-save-form"><label htmlFor="layout-name">Save this workspace as</label><div><input id="layout-name" data-autofocus value={name} onChange={event => { setName(event.target.value); setError(''); setFailed(false); }} maxLength={80} placeholder="e.g. Morning read" autoComplete="off" disabled={!!working || atLimit} required /><button className="button primary" type="submit" disabled={!!working || atLimit}>{working === 'create' ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}Save layout</button></div>{atLimit && <p className="field-hint">You have {MAX_LAYOUTS} saved layouts. Update one below or delete a snapshot to make room.</p>}</form></section>
      {(error || failed) && <p className="form-error layout-error" role="alert">{error || requestError || 'The layout could not be changed. Please try again.'}</p>}
      <section className="layout-library"><div className="layout-library-heading"><h3>Saved layouts</h3><span>{layouts.length} / {MAX_LAYOUTS} on this device</span></div>
        {layouts.length === 0 ? <div className="layouts-empty"><span><LayoutTemplate size={28} strokeWidth={1.35} /></span><h4>Keep a few perspectives.</h4><p>A focused workday. A weekend read. Save your first layout above, then switch whenever you like.</p></div> : <div className="layout-cards">{layouts.map(layout => {
          const matches = JSON.stringify([layout.columns, layout.settings]) === currentSignature;
          const confirmationKind = confirm?.id === layout.id ? confirm.kind : null;
          return <article className={`layout-card ${confirmationKind ? 'confirming' : ''}`} key={layout.id} aria-label={`Saved layout ${layout.name}`}>
            <div className="layout-card-main"><LayoutPreview columns={layout.columns} /><div className="layout-card-copy"><h4 title={layout.name}>{layout.name}</h4><p>{layout.columns.length} {layout.columns.length === 1 ? 'column' : 'columns'}<span>·</span>{layout.settings.theme[0].toUpperCase() + layout.settings.theme.slice(1)}<span>·</span>{layout.settings.density}</p><div className="layout-match">{matches ? <><Check size={10} />Matches your current view</> : <span>Saved {savedDate(layout.updatedAt)}</span>}</div></div><button className="button secondary small restore-layout" onClick={() => ask('restore', layout)} disabled={!!working}>Restore <ArrowRight size={13} /></button></div>
            {layout.columns.length > 0 && <div className="layout-source-chips" aria-label="Sources in this saved layout">{layout.columns.slice(0, 4).map(column => <span key={column.id} title={columnTitle(column)}><i style={{ background: column.color }} />{columnTitle(column)}</span>)}{layout.columns.length > 4 && <span className="layout-overflow">+{layout.columns.length - 4}</span>}</div>}
            <div className="layout-card-actions"><button type="button" className="text-button" onClick={() => ask('update', layout)} disabled={!!working} title={`Replace “${layout.name}” with your current workspace`}><RefreshCw size={12} />Update with current view</button><span /><IconButton label={`Rename layout “${layout.name}”`} disabled={!!working} onClick={() => { setRename({ id: layout.id, name: layout.name }); setConfirm(null); setError(''); setFailed(false); }}><Pencil size={13} /></IconButton><IconButton label={`Delete saved layout “${layout.name}”`} disabled={!!working} onClick={() => ask('delete', layout)}><Trash2 size={13} /></IconButton></div>
            {rename?.id === layout.id && <form className="layout-rename" onSubmit={renameLayout}><label htmlFor="rename-layout">Layout name</label><input ref={renameInput} id="rename-layout" value={rename.name} onChange={event => setRename({ ...rename, name: event.target.value })} maxLength={80} disabled={!!working} required /><div><button type="button" className="button secondary small" disabled={!!working} onClick={() => setRename(null)}>Cancel</button><button type="submit" className="button primary small" disabled={!!working}>{working === layout.id && <Loader2 className="spin" size={12} />}Save name</button></div></form>}
            {confirmationKind && <div className={`layout-confirm ${confirmationKind === 'delete' ? 'is-delete' : ''}`} ref={confirmation}><strong>{confirmationKind === 'restore' ? 'Restore' : confirmationKind === 'update' ? 'Update' : 'Delete'} “{layout.name}”?</strong><p>{confirmationKind === 'restore' ? 'This replaces your current columns and preferences. Your bookmarks stay. Save the current view first if you want to keep it.' : confirmationKind === 'update' ? `Replace this saved snapshot with your current ${state.columns.length} ${state.columns.length === 1 ? 'column' : 'columns'} and preferences. Its previous arrangement will be overwritten.` : 'This removes the saved snapshot from this device. Your current workspace and bookmarks stay.'}</p><div><button type="button" className="button secondary small" disabled={!!working} onClick={() => setConfirm(null)}>Cancel</button><button type="button" className={`button ${confirmationKind === 'delete' ? 'danger' : 'primary'} small`} disabled={!!working} onClick={() => void apply(layout)}>{working === layout.id && <Loader2 className="spin" size={12} />}{confirmationKind === 'restore' ? 'Restore layout' : confirmationKind === 'update' ? 'Update layout' : 'Delete layout'}</button></div></div>}
          </article>;
        })}</div>}
      </section>
    </div>
    <div className="modal-footer"><span className="footer-note"><Save size={13} />Layouts stay on this device. Posts are not included.</span><button className="button secondary" onClick={onClose}>Done <Check size={14} /></button></div>
  </Modal>;
}
