import { useState } from 'react';
import { BadgeCheck, Bookmark, Check, Copy, ExternalLink, Heart, MessageCircle, Play, Repeat2 } from 'lucide-react';
import type { Post, Settings } from '../shared/types';
import { safeUrl } from './config';
import { IconButton } from './components';
import { MediaLightbox } from './MediaLightbox';

export function relativeTime(date: string): string {
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function PostText({ text }: { text: string }) {
  const chunks = text.split(/(https?:\/\/[^\s]+|(?<![\w])@[a-zA-Z0-9_]{1,15}\b|(?<![\w])#[\p{L}\p{N}_]+)/gu);
  return <>{chunks.map((chunk, index) => {
    const href = chunk.startsWith('http') ? safeUrl(chunk) : chunk.startsWith('@') ? `https://x.com/${chunk.slice(1)}` : chunk.startsWith('#') ? `https://x.com/search?q=${encodeURIComponent(chunk)}&f=live` : undefined;
    return href ? <a key={index} href={href} target="_blank" rel="noreferrer">{chunk}</a> : chunk;
  })}</>;
}

export function PostCard({ post, saved, settings, onSave, notify }: { post: Post; saved: boolean; settings: Settings; onSave: (post: Post) => void; notify: (message: string) => void }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const href = safeUrl(post.url) || `https://x.com/i/status/${encodeURIComponent(post.id)}`;
  const profileUrl = `https://x.com/${encodeURIComponent(post.author.handle.replace(/^@/, ''))}`;
  const media = post.media.filter(item => safeUrl(item.url)).slice(0, 4);
  const images = media.filter(item => item.type === 'image');
  async function copyLink() {
    try { await navigator.clipboard.writeText(href); setCopied(true); notify('Post link copied'); setTimeout(() => setCopied(false), 1800); }
    catch { notify('Could not copy the link. Open the post on X to copy it.'); }
  }
  return <article className="post-card" data-post-id={post.id}>
    {post.repostedBy && <div className="reposted"><Repeat2 size={12} /><span>{post.repostedBy} reposted</span></div>}
    <div className="post-byline">
      <a href={profileUrl} target="_blank" rel="noreferrer" className="avatar" tabIndex={-1} aria-hidden="true">
        {safeUrl(post.author.avatar) && !avatarFailed ? <img src={post.author.avatar} alt="" loading="lazy" onError={() => setAvatarFailed(true)} /> : <span>{post.author.name.slice(0, 2).toUpperCase()}</span>}
      </a>
      <div className="author-details"><a className="author-name" href={profileUrl} target="_blank" rel="noreferrer"><span>{post.author.name || post.author.handle}</span>{post.author.verified && <BadgeCheck className="verified" size={15} aria-label="Verified" />}</a><a className="author-handle" href={profileUrl} target="_blank" rel="noreferrer">@{post.author.handle.replace(/^@/, '')}</a></div>
      <a className="post-time" href={href} target="_blank" rel="noreferrer" title={new Date(post.createdAt).toLocaleString()}>{relativeTime(post.createdAt)}</a>
      <IconButton className={`save-post ${saved ? 'saved' : ''}`} label={saved ? 'Remove from saved posts in TDeck' : 'Save post in TDeck'} aria-pressed={saved} onClick={() => onSave(post)}><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} /></IconButton>
    </div>
    {post.text && <div className="post-text"><PostText text={post.text} /></div>}
    {post.quote && <a className="quoted-post" href={safeUrl(post.quote.url) || href} target="_blank" rel="noreferrer"><span className="quote-author">{post.quote.author}</span><span>{post.quote.text}</span></a>}
    {settings.showMedia && media.length > 0 && <div className={`post-media media-${media.length}`}>{media.map((item, index) => item.type === 'video' ? <a href={href} className="media-item" key={`${item.url}-${index}`} target="_blank" rel="noreferrer" title="Watch video on X"><img src={item.url} alt={item.alt || 'Video preview'} loading="lazy" /><span className="video-play"><Play size={21} fill="currentColor" /></span></a> : <button className="media-item" key={`${item.url}-${index}`} title="Expand image" onClick={() => setLightboxIndex(images.indexOf(item))}><img src={item.url} alt={item.alt || 'Image attached to post'} loading="lazy" /></button>)}</div>}
    <div className="post-actions">
      <a className="post-action reply-action" href={`https://x.com/intent/post?in_reply_to=${encodeURIComponent(post.id)}`} target="_blank" rel="noreferrer" title="Reply on X" aria-label={`Reply on X${post.counts.replies ? `, ${post.counts.replies} replies` : ''}`}><MessageCircle size={15} /><span>{post.counts.replies || ''}</span></a>
      <a className="post-action repost-action" href={href} target="_blank" rel="noreferrer" title="Open post on X to repost" aria-label={`Open post on X to repost${post.counts.reposts ? `, ${post.counts.reposts} reposts` : ''}`}><Repeat2 size={16} /><span>{post.counts.reposts || ''}</span></a>
      <a className="post-action like-action" href={href} target="_blank" rel="noreferrer" title="Open post on X to like" aria-label={`Open post on X to like${post.counts.likes ? `, ${post.counts.likes} likes` : ''}`}><Heart size={15} /><span>{post.counts.likes || ''}</span></a>
      <span className="post-action-spacer" />
      <IconButton label="Copy post link" onClick={copyLink}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>
      <a className="icon-button" href={href} target="_blank" rel="noreferrer" title="Open post on X" aria-label="Open post on X"><ExternalLink size={14} /></a>
    </div>
    {lightboxIndex !== null && <MediaLightbox images={images} index={lightboxIndex} author={post.author} postUrl={href} onChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />}
  </article>;
}
