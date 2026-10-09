// Posting (§9) with cross-store product matching:
//   paste link → (same product already posted?) → add your store link to it  |  post a new product deal
import { $, $$, api, goLogin, html, money, navigate, setPage, state, toast } from '../core.js';
import { miniDeal } from '../ui.js';
import { bindFormHelpers, duplicateLinkNotice, imagePreview, offerFields, onFormSubmit, productFields, urlChip } from '../forms.js';

const page = (content) => setPage('Post a deal', html`<div class="page-head"><h1>Post a deal</h1></div><div class="panel">${content}</div>`);

export async function submitPage({ query, alive }) {
  if (!state.user) return goLogin();
  // Everything we know so far about the link being posted.
  const s = { url: '', fields: {}, matches: [], ok: false, reason: null, draft: null };

  function showUrlStep(value = '', error = '') {
    page(html`<form id="url-form">
      ${error}
      <div class="field"><label for="u-url">Paste the product link</label>
        <input id="u-url" name="url" type="url" required placeholder="https://www.flipkart.com/… or a Myntra, Amazon, AJIO, Nykaa, Meesho link" value="${value}" autofocus>
        <span class="hint">We'll check whether this product is already on ShareDeals from another store, and fill in the details for you.</span></div>
      <button class="btn btn-primary" id="url-btn">Continue</button>
    </form>`);
    $('#url-form').addEventListener('submit', (e) => {
      e.preventDefault();
      prefill($('#u-url').value.trim());
    });
  }

  async function prefill(url) {
    const btn = $('#url-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    }
    try {
      const r = await api('/api/deals/prefill', { method: 'POST', body: { url } });
      if (!alive()) return;
      Object.assign(s, { url: r.url, fields: r.fields, matches: r.matches, ok: r.ok, reason: r.reason, draft: null });
      if (s.matches.length) showMatches();
      else showNewDealForm({ confirmNew: false });
    } catch (err) {
      if (!alive()) return;
      if (err.status === 401) return goLogin();
      showUrlStep(url, err.data?.duplicate ? duplicateLinkNotice(err.data.duplicate) : html`<div class="form-error">${err.message}</div>`);
    }
  }

  /** "Is this the same product?" — the heart of one-deal-per-product. */
  function showMatches({ fromSubmit = false } = {}) {
    const store = s.draft?.store || s.fields.store || 'this store';
    const high = s.matches.some((m) => m.confidence === 'high');
    page(html`
      ${urlChip(s.url)}
      <h2 style="margin:4px 0 6px;font-size:20px">${high ? 'This product is already on ShareDeals' : 'Is this one of these products?'}</h2>
      <p class="muted" style="margin-top:0">
        ${fromSubmit ? 'Before posting a new deal: ' : ''}Instead of a separate post, add your ${store} link to the existing deal.
        Shoppers will see every store's price side by side on one deal, and your link stays yours.
      </p>
      <div class="matches">
        ${s.matches.map(
          (m) => html`<div class="match-card ${m.confidence}">
            ${miniDeal(m.deal)}
            <div class="match-meta">
              <span class="badge ${m.confidence === 'high' ? 'match-high' : ''}">${m.confidence === 'high' ? 'Very likely the same product' : 'Possibly the same product'}</span>
              ${
                m.storeListed
                  ? html`<span class="small muted">${m.storeListed.store} is already listed here by @${m.storeListed.by} at ${money(m.storeListed.price)}</span>`
                  : html`<button class="btn btn-primary btn-sm" data-attach="${m.deal.id}">Add my ${store} link to this deal</button>`
              }
            </div>
          </div>`,
        )}
      </div>
      <div class="match-footer">
        <button class="btn" id="not-same">No — it's a different product, post a new deal</button>
      </div>
    `);
    $('#change-url').addEventListener('click', () => showUrlStep(s.url));
    $('#not-same').addEventListener('click', () => showNewDealForm({ confirmNew: true }));
    for (const b of $$('[data-attach]')) {
      b.addEventListener('click', () => showAttachForm(s.matches.find((m) => m.deal.id === Number(b.dataset.attach)).deal));
    }
  }

  function showAttachForm(deal) {
    const v = { ...s.fields, ...(s.draft || {}) };
    page(html`<form id="offer-form" novalidate>
      ${urlChip(s.url)}
      <p class="muted" style="margin:0 0 8px">Adding your store link to</p>
      ${miniDeal(deal)}
      <div id="form-error" style="margin-top:16px"></div>
      <h3 class="form-section">Your store listing</h3>
      ${offerFields(v)}
      <div class="form-actions">
        <button type="button" class="btn" id="back">Back</button>
        <button class="btn btn-primary">Add to deal</button>
      </div>
    </form>`);
    const form = $('#offer-form');
    bindFormHelpers(form);
    $('#change-url').addEventListener('click', () => showUrlStep(s.url));
    $('#back').addEventListener('click', () => showMatches());
    onFormSubmit(form, async (body) => {
      await api(`/api/deals/${deal.id}/offers`, { method: 'POST', body: { ...body, url: s.url, gtin: s.fields.gtin, mpn: s.fields.mpn } });
      toast(`Added your ${body.store} link — thanks!`);
      navigate(`/deals/${deal.id}`, { replace: true });
    });
  }

  function showNewDealForm({ confirmNew }) {
    const v = { ...s.fields, ...(s.draft || {}) };
    const notice = s.ok
      ? html`<div class="notice">✓ We filled in what we could find — please double-check everything before posting.</div>`
      : html`<div class="notice">Couldn't auto-fill details${s.reason ? html` (${s.reason})` : ''} — please complete manually.</div>`;
    page(html`<form id="deal-form" novalidate>
      ${s.draft ? '' : notice}
      ${urlChip(s.url)}
      <div id="form-error"></div>
      <div class="submit-grid">
        <div>${imagePreview(v)}</div>
        <div>
          <h3 class="form-section" style="margin-top:0">Product</h3>
          ${productFields(v)}
          <h3 class="form-section">Your store listing</h3>
          ${offerFields(v)}
          <p class="hint small">Seen this product cheaper elsewhere? After posting, anyone can add other stores to the same deal.</p>
          <div class="form-actions">
            <a class="btn" href="/">Cancel</a>
            <button class="btn btn-primary">Post deal</button>
          </div>
        </div>
      </div>
    </form>`);
    const form = $('#deal-form');
    bindFormHelpers(form);
    $('#change-url').addEventListener('click', () => showUrlStep(s.url));
    onFormSubmit(
      form,
      async (body) => {
        try {
          const { deal } = await api('/api/deals', { method: 'POST', body: { ...body, url: s.url, confirmNew } });
          toast('Your deal is live!');
          navigate(`/deals/${deal.id}`, { replace: true });
        } catch (err) {
          // The server spotted the same product (e.g. auto-fill failed, so we couldn't check earlier).
          if (err.data?.matches?.length) {
            s.matches = err.data.matches;
            s.draft = body;
            showMatches({ fromSubmit: true });
            return;
          }
          throw err;
        }
      },
      (err) => (err.data?.duplicate ? duplicateLinkNotice(err.data.duplicate) : html`<div class="form-error">${err.message}</div>`),
    );
  }

  const initialUrl = query.get('url') || '';
  showUrlStep(initialUrl);
  if (initialUrl) prefill(initialUrl); // e.g. opened from the browser extension
}

/** Product-level edit (creator only). Store listings are edited from the deal page. */
export async function editDealPage({ params, alive }) {
  if (!state.user) return goLogin();
  const { deal: d } = await api(`/api/deals/${params[0]}`);
  if (!alive()) return;
  if (!d.canEdit) throw Object.assign(new Error('Only the person who posted this deal can edit its details.'), { status: 403 });
  const v = { title: d.title, imageUrl: d.imageUrl, categoryId: d.category?.id, details: d.details, gtin: '', mpn: '' };
  setPage(
    'Edit deal',
    html`<div class="page-head"><h1>Edit deal</h1></div><div class="panel"><form id="deal-form" novalidate>
      <div id="form-error"></div>
      <div class="submit-grid">
        <div>${imagePreview(v)}</div>
        <div>
          ${productFields(v)}
          <p class="hint small">Prices and links are per store — edit your store listings from the deal page.</p>
          <div class="form-actions"><a class="btn" href="/deals/${d.id}">Cancel</a><button class="btn btn-primary">Save changes</button></div>
        </div>
      </div>
    </form></div>`,
  );
  const form = $('#deal-form');
  bindFormHelpers(form);
  onFormSubmit(form, async (body) => {
    await api(`/api/deals/${d.id}`, { method: 'PATCH', body });
    toast('Deal updated');
    navigate(`/deals/${d.id}`, { replace: true });
  });
}
