import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, ExternalLink } from 'lucide-react';
import type { Post } from '../shared/types';
import { IconButton, Modal } from './components';

export function MediaLightbox({ images, index, author, postUrl, onChange, onClose }: {
  images: Post['media']; index: number; author: Post['author']; postUrl: string;
  onChange: (index: number) => void; onClose: () => void;
}) {
  const current = images[index];
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onChange(index - 1); }
      if (event.key === 'ArrowRight' && index < images.length - 1) { event.preventDefault(); onChange(index + 1); }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [index, images.length, onChange]);
  if (!current) return null;
  return createPortal(<Modal title={`Photo by ${author.name || author.handle}`} subtitle={`@${author.handle.replace(/^@/, '')} · ${index + 1} of ${images.length}`} className="media-lightbox" onClose={onClose}>
    <div className="lightbox-stage"><img key={current.url} src={current.url} alt={current.alt || `Photo ${index + 1} attached to the post`} />{images.length > 1 && <><IconButton className="lightbox-previous" label="Previous photo · Left arrow" disabled={index === 0} onClick={() => onChange(index - 1)}><ArrowLeft size={21} /></IconButton><IconButton className="lightbox-next" label="Next photo · Right arrow" disabled={index === images.length - 1} onClick={() => onChange(index + 1)}><ArrowRight size={21} /></IconButton></>}</div>
    <div className="lightbox-footer"><p>{current.alt || 'Image attached to post'}</p><a className="text-button" href={postUrl} target="_blank" rel="noreferrer">View post on X <ExternalLink size={13} /></a></div>
  </Modal>, document.body);
}
