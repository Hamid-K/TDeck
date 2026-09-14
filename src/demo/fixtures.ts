import { DEFAULT_SETTINGS, type Author, type ColumnConfig, type DeckState, type Post } from '../shared/types';

// These accounts, post identifiers, and list identifiers are fictional. Invalid
// X handles/IDs deliberately prevent a fixture from identifying an actual user.
export function createDemoState(pageOrigin: string, now = Date.now()): DeckState {
  // Root-relative paths avoid Vite's directory-URL transform dropping a slash
  // and accidentally resolving these fixtures under /src/assets/.
  const asset = (name: string) => new URL(`/src/demo/assets/${name}`, pageOrigin).href;
  const authors: Record<string, Author> = {
    mira: { name: 'Mira Vale', handle: 'mira.demo', verified: false, avatar: asset('avatar-mira.svg') },
    rowan: { name: 'Rowan Ellis', handle: 'rowan.demo', verified: false, avatar: asset('avatar-rowan.svg') },
    ari: { name: 'Ari Moss', handle: 'ari.demo', verified: false, avatar: asset('avatar-ari.svg') },
    sol: { name: 'Sol Finch', handle: 'sol.demo', verified: false, avatar: asset('avatar-sol.svg') },
  };
  const makePost = (id: string, author: Author, text: string, minutes: number, extra: Partial<Post> = {}): Post => ({
    id: `fictional-${id}`, url: `https://demo.invalid/posts/${id}`, author, text,
    createdAt: new Date(now - minutes * 60_000).toISOString(), media: [],
    counts: { replies: '8', reposts: '24', likes: '186' }, isReply: false, ...extra,
  });
  const design = [
    makePost('field-notes', authors.rowan, 'A small collection of things worth noticing.\n\nGood design often starts with paying a little more attention to the ordinary.', 3, { media: [{ type: 'image', url: asset('field-notes.svg'), alt: 'Fictional editorial artwork: Field Notes, a study in thoughtful details' }], counts: { replies: '12', reposts: '38', likes: '264' } }),
    makePost('quiet-details', authors.ari, 'The most satisfying interactions are the ones that make you feel understood.\n\nA remembered scroll position. A useful default. Just enough motion.', 11, { quote: { author: 'Mira Vale', text: 'Care is a feature. The small details are where people feel it.', url: 'https://demo.invalid/posts/care' }, counts: { replies: '6', reposts: '17', likes: '143' } }),
    makePost('craft', authors.rowan, 'Today’s design engineering note: prototype the feeling before you polish the pixels.', 24, { counts: { replies: '4', reposts: '9', likes: '82' } }),
    makePost('margins', authors.ari, 'A little more space around the important thing. Sometimes that is the whole improvement.', 38),
  ];
  const people = [
    makePost('considered', authors.mira, 'A new direction for a tiny personal project.\n\nLess to look at. More room to think. Sharing a few explorations from the studio this morning.', 5, { media: [{ type: 'image', url: asset('considered.svg'), alt: 'Fictional studio artwork: Less, but considered, in soft green and cream' }], counts: { replies: '18', reposts: '42', likes: '318' } }),
    makePost('one-place', authors.mira, 'I keep coming back to tools that do one thing beautifully.\n\nNot because they have fewer possibilities, but because they help me notice the right ones.', 18, { counts: { replies: '9', reposts: '21', likes: '207' } }),
    makePost('small-ritual', authors.mira, 'A small end-of-day ritual: save one idea, close the tabs, leave a note for tomorrow.\n\nFuture me is usually grateful.', 41, { counts: { replies: '7', reposts: '14', likes: '129' } }),
    makePost('next', authors.mira, 'Making a little progress is still making something.', 63),
  ];
  const curiosity = [
    makePost('orbital', authors.sol, 'An orbital study from the sketchbook.\n\nThere is something lovely about a complicated system finding its own quiet rhythm.', 2, { media: [{ type: 'image', url: asset('orbital.svg'), alt: 'Fictional orbital illustration with a warm planet, fine elliptical paths, and a dark sky' }], counts: { replies: '5', reposts: '31', likes: '226' } }),
    makePost('good-questions', authors.rowan, 'A question for the notebook: what would this look like if it were easy to understand?\n\nUseful for interfaces. Also surprisingly useful for a Monday.', 14, { counts: { replies: '11', reposts: '16', likes: '154' } }),
    makePost('outside', authors.ari, 'Went outside to solve a problem. Came back with a different question.\n\nCalling that a productive walk.', 29, { repostedBy: 'Sol Finch', counts: { replies: '3', reposts: '8', likes: '96' } }),
    makePost('curiosity', authors.sol, 'Leave a little room in the day for something you did not plan to find.', 52),
  ];
  const base: Omit<ColumnConfig, 'id' | 'kind' | 'title' | 'query' | 'color'> = { width: 360, refreshSeconds: 120, paused: false, mediaOnly: false, hideReplies: false, mutedWords: [] };
  const columns: ColumnConfig[] = [
    { ...base, id: 'demo-design', kind: 'search', title: 'Design & craft', query: '"design engineering" OR "good design"', color: '#8adfc1' },
    { ...base, id: 'demo-person', kind: 'account', title: 'Mira’s studio', query: 'mira.demo', color: '#a99be5' },
    { ...base, id: 'demo-curiosity', kind: 'list', title: 'Curiosity club', query: 'fictional-curiosity-list', color: '#e5be7f' },
  ];
  const posts = [design, people, curiosity];
  return {
    version: 1, connected: false, columns, settings: { ...DEFAULT_SETTINGS, fontSize: 13 },
    feeds: Object.fromEntries(columns.map((column, index) => [column.id, { posts: posts[index], pending: [], status: 'ready', hasMore: false, lastUpdated: now - 25_000 }])),
    bookmarks: [people[0], design[1]], layouts: [], lists: [], listsStatus: 'idle',
  };
}
