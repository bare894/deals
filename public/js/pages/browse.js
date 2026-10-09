// Discovery pages: homepage sections (§6) and the listings feed (§7).
import { $, api, emptyState, html, onLeave, setPage, state, toast } from '../core.js';
import { dealCard, skeletonCards } from '../ui.js';

export async function homePage({ alive }) {
  setPage('', html`<div class="section"><div class="row-scroller">${skeletonCards(5)}</div></div><div class="section"><div class="row-scroller">${skeletonCards(5)}</div></div>`);
  const data = await api('/api/home');
  if (!alive()) return;
  const section = (title, sub, items, href, opts = {}) => html`<section class="section">
    <div class="section-head"><h2>${title}</h2><span class="muted small">${sub}</span>${href ? html`<a class="see-all" href="${href}">See all →</a>` : ''}</div>
    ${items.length ? html`<div class="row-scroller">${items.map((d) => dealCard(d, opts))}</div>` : html`<p class="muted">Nothing here yet.</p>`}
  </section>`;
  const fySub = data.forYouPersonalized
    ? 'Based on what you vote on, save, and view'
    : state.user
      ? 'Trending for now — vote on or save a few deals to personalize this'
      : 'Trending for now — sign in to personalize';
  setPage(
    '',
    html`
      <nav class="chips" aria-label="Categories">
        <a class="chip active" href="/deals">All</a>
        ${state.categories.map((c) => html`<a class="chip" href="/deals?category=${c.slug}">${c.name}</a>`)}
      </nav>
      ${section('Latest', 'Fresh from the community', data.latest, '/deals')}
      ${section('🔥 Hot Deals', 'Most upvoted right now', data.hot, '/deals?sort=hot', { hot: true })}
      ${section('For You', fySub, data.forYou, null)}
    `,
  );
}

export async function listingsPage({ query, alive }) {
  const sort = query.get('sort') === 'hot' ? 'hot' : 'new';
  const category = query.get('category') || '';
  const q = query.get('q') || '';
  const cat = state.categories.find((c) => c.slug === category);
  const link = (patch) => {
    const p = new URLSearchParams({ ...(sort === 'hot' ? { sort } : {}), ...(category ? { category } : {}), ...(q ? { q } : {}), ...patch });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    const s = p.toString();
    return `/deals${s ? `?${s}` : ''}`;
  };
  const heading = q ? `Results for “${q}”` : cat ? cat.name : sort === 'hot' ? 'Hot Deals' : 'All deals';
  setPage(
    heading,
    html`
      <div class="page-head">
        <div><h1>${heading}</h1>${q ? html`<a class="small muted" href="${link({ q: '' })}">Clear search</a>` : ''}</div>
        <nav class="tabs" style="border:0;margin:0" aria-label="Sort">
          <a href="${link({ sort: '' })}" class="${sort === 'new' ? 'active' : ''}">Newest</a>
          <a href="${link({ sort: 'hot' })}" class="${sort === 'hot' ? 'active' : ''}">🔥 Hot</a>
        </nav>
      </div>
      <nav class="chips" aria-label="Categories">
        <a class="chip ${category ? '' : 'active'}" href="${link({ category: '' })}">All</a>
        ${state.categories.map((c) => html`<a class="chip ${c.slug === category ? 'active' : ''}" href="${link({ category: c.slug })}">${c.name}</a>`)}
      </nav>
      <div class="grid" id="feed">${skeletonCards(8)}</div>
      <div class="sentinel" id="sentinel"></div>
      <div class="load-more" id="load-more" hidden><button class="btn">Load more</button></div>
    `,
  );
  const feed = $('#feed');
  const moreBox = $('#load-more');
  let page = 0;
  let loading = false;
  let hasMore = true;
  async function load() {
    if (loading || !hasMore) return;
    loading = true;
    try {
      const params = new URLSearchParams({ sort, page: String(page + 1), limit: '24' });
      if (category) params.set('category', category);
      if (q) params.set('q', q);
      const data = await api(`/api/deals?${params}`);
      if (!alive()) return;
      if (page === 0) feed.innerHTML = '';
      page = data.page;
      hasMore = data.hasMore;
      feed.insertAdjacentHTML('beforeend', String(html`${data.items.map((d) => dealCard(d, { hot: sort === 'hot' }))}`));
      if (page === 1 && !data.items.length) {
        feed.outerHTML = String(emptyState('No deals found', q ? 'Try a different search.' : 'Be the first to post one!', html`<a class="btn btn-primary" href="/submit">Post a deal</a>`));
      }
      moreBox.hidden = !hasMore;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading = false;
    }
  }
  $('button', moreBox).addEventListener('click', load);
  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(), { rootMargin: '600px' });
  io.observe($('#sentinel'));
  onLeave(() => io.disconnect());
  await load();
}
