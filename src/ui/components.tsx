import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

export function Modal({ title, subtitle, children, onClose, className = '' }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; className?: string }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = dialog.current;
    const focusable = () => Array.from(target?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []).filter(item => item.offsetParent !== null);
    const first = target?.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0];
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const firstItem = elements[0];
      const lastItem = elements.at(-1);
      if (event.shiftKey && (document.activeElement === firstItem || !target?.contains(document.activeElement))) { event.preventDefault(); lastItem?.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
      <div className="modal-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton></div>
      {children}
    </div>
  </div>;
}

export function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return <label className={`toggle-row ${disabled ? 'disabled' : ''}`} htmlFor={id}>
    <span><span className="setting-label">{label}</span>{description && <span className="setting-description">{description}</span>}</span>
    <input id={id} className="toggle-input" role="switch" type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} />
  </label>;
}

export function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`brand-mark ${large ? 'large' : ''}`} aria-hidden="true"><i /><i /><i /></span>;
}
