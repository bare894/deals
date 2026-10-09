// Deal detail (§8): one product, every store's price side by side, community votes + comments.
import { $, $$, api, fullDate, goLogin, html, isMod, money, navigate, placeholder, renderRoute, setPage, state, timeAgo, toast } from '../core.js';
import { askReason, openModal, priceBlock, voteWidget } from '../ui.js';
import { bindFormHelpers, duplicateLinkNotice, offerFields, onFormSubmit, urlChip } from '../forms.js';

export async function dealPage({ params, alive }) {
  const id = params[0];
  const [res, { comments }] = await Promise.all([api(`/api/deals/${id}`), api(`/api/deals/${id}/comments`)]);
  if (!alive()) return;
  if (res.mergedInto) return navigate(`/deals/${res.mergedInto}`, { replace: true });
  const d = res.deal;
  const removed = d.status !== 'active';
  const live = d.offers.filter((o) => o.status === 'active');
  const best = live[0];

  setPage(
    d.title,
    html`
      ${removed ? html`<div class="banner removed">This deal was removed by a moderator and is only visible to moderators.</div>` : ''}
      <article class="detail">
        <div class="detail-media"><img src="${d.imageUrl || placeholder(d.title)}" data-label="${d.title.slice(0, 20)}" alt="${d.title}"></div>
        <div>
          <div class="meta-line">
            ${d.category ? html`<a class="badge" href="/deals?category=${d.category.slug}">${d.category.name}</a>` : ''}
            ${live.length > 1 ? html`<span class="badge stores-badge">Available at ${live.length} stores</span>` : ''}
          </div>
          <h1>${d.title}</h1>
          ${
            best
              ? html`<div class="prices" style="gap:12px;align-items:center">
                  ${priceBlock(d, { mrpLabel: true })}
                  ${d.discountPct ? html`<span class="off-badge">${d.discountPct}% off</span>` : ''}
                </div>
                <p class="muted small" style="margin:4px 0 0">${live.length > 1 ? 'Lowest price' : 'Price'} on <strong>${best.store}</strong></p>`
              : ''
          }
          <div class="actions">
            ${voteWidget(d, { large: true })}
            ${best ? html`<a class="btn btn-primary btn-lg" href="${best.url}" target="_blank" rel="noopener noreferrer nofollow sponsored ugc">Get deal on ${best.store} ↗</a>` : ''}
          </div>
          <div class="actions" style="margin-top:0">
            ${removed ? '' : html`<button class="btn ${d.bookmarked ? 'on' : ''}" data-action="bookmark" data-id="${d.id}" aria-pressed="${d.bookmarked}">♡ <span class="lbl">${d.bookmarked ? 'Saved' : 'Save'}</span></button>`}
            <button class="btn" data-action="share" data-id="${d.id}" data-title="${d.title}">↗ Share</button>
            ${state.user && !removed && state.user.id !== d.poster.id ? html`<button class="btn" data-action="report" data-type="deal" data-id="${d.id}">⚑ Report</button>` : ''}
            ${d.canEdit ? html`<a class="btn" href="/deals/${d.id}/edit">✎ Edit</a>` : ''}
          </div>
          <p class="meta-line">Posted by <strong>@${d.poster.handle}</strong> · <span title="${fullDate(d.createdAt)}">${timeAgo(d.createdAt)}</span>
            · ${d.upvotes} up / ${d.downvotes} down</p>
          ${d.details ? html`<h2 class="h-sub">About this deal</h2><p class="details-text">${d.details}</p>` : ''}
        </div>
      </article>

      <section class="where-to-buy" id="where-to-buy">
        <div class="section-head"><h2>Where to buy</h2><span class="muted small">${live.length} store${live.length === 1 ? '' : 's'} · sorted by price</span>
          ${removed ? '' : html`<button class="btn btn-sm see-all-btn" id="add-store">+ Add another store</button>`}</div>
        <div id="add-store-panel" hidden></div>
        <div class="offers">${d.offers.map((o, i) => offerRow(o, { lowest: i === 0 && o.status === 'active' && live.length > 1 }))}</div>
      </section>

      <section class="comments" id="comments">
        <h2>Comments <span class="muted" id="comment-count">(${comments.length})</span></h2>
        ${
          state.user
            ? removed
              ? ''
              : html`<form class="comment-form" id="comment-form">
                  <div class="form-error" hidden></div>
                  <textarea name="body" maxlength="2000" placeholder="Ask a question or share your experience…" required aria-label="Comment"></textarea>
                  <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary">Post comment</button></div>
                </form>`
            : html`<p class="notice info"><a href="/login?next=${encodeURIComponent(location.pathname)}">Sign in</a> to join the conversation.</p>`
        }
        <div id="comment-list">${comments.length ? comments.map(commentItem) : html`<p class="muted" id="no-comments">No comments yet — be the first.</p>`}</div>
      </section>
    `,
  );

  bindOfferActions(d);
  $('#add-store')?.addEventListener('click', () => (state.user ? openAddStore(d) : goLogin()));
  bindCommentForm(id);
}

function offerRow(o, { lowest }) {
  const mine = state.user?.id === o.poster.id;
  const inactive = o.status !== 'active';
  return html`<div class="offer ${lowest ? 'lowest' : ''} ${inactive ? 'inactive' : ''}" data-offer="${o.id}">
    <div class="offer-store">
      <strong>${o.store}</strong>
      ${lowest ? html`<span class="pill-lowest">Lowest</span>` : ''}
      ${inactive ? html`<span class="badge status-removed">removed</span>` : ''}
    </div>
    <div class="offer-price">
      <span class="price">${money(o.price)}</span>
      ${o.fullPrice ? html`<span class="was">${money(o.fullPrice)}</span>` : ''}
      ${o.discountPct ? html`<span class="small discount">${o.discountPct}% off</span>` : ''}
    </div>
    <div class="offer-meta">
      ${o.note ? html`<div class="offer-note">${o.note}</div>` : ''}
      <div class="small muted">Added by @${o.poster.handle} · <span title="${fullDate(o.createdAt)}">${timeAgo(o.createdAt)}</span>${o.updatedAt > o.createdAt + 60_000 ? html` · updated ${timeAgo(o.updatedAt)}` : ''}</div>
    </div>
    <div class="offer-actions">
      ${inactive ? '' : html`<a class="btn ${lowest ? 'btn-primary' : ''} btn-sm" href="${o.url}" target="_blank" rel="noopener noreferrer nofollow sponsored ugc">Get deal ↗</a>`}
      ${mine && !inactive ? html`<button class="linkish" data-offer-act="edit">Edit</button><button class="linkish" data-offer-act="delete">Remove</button>` : ''}
      ${state.user && !mine && !inactive ? html`<button class="linkish" data-action="report" data-type="offer" data-id="${o.id}">Report</button>` : ''}
      ${isMod() && !mine ? (inactive ? html`<button class="linkish" data-offer-act="mod-restore">Restore (mod)</button>` : html`<button class="linkish" data-offer-act="mod-remove">Remove (mod)</button>`) : ''}
    </div>
  </div>`;
}

function bindOfferActions(d) {
  $('#where-to-buy').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-offer-act]');
    if (!btn) return;
    const o = d.offers.find((x) => x.id === Number(btn.closest('[data-offer]').dataset.offer));
    try {
      if (btn.dataset.offerAct === 'edit') {
        const saved = await editOfferModal(o);
        if (saved) toast('Listing updated');
        else return;
      } else if (btn.dataset.offerAct === 'delete') {
        const ok = await askReason({ title: `Remove your ${o.store} listing?`, label: 'Why? (helps other shoppers)', confirm: 'Remove listing', danger: true, required: false, placeholderText: 'e.g. Price went back up' });
        if (ok === null) return;
        await api(`/api/offers/${o.id}`, { method: 'DELETE' });
        toast('Listing removed');
      } else if (btn.dataset.offerAct === 'mod-remove') {
        const reason = await askReason({ title: `Remove the ${o.store} listing?`, confirm: 'Remove listing', danger: true, placeholderText: 'e.g. Price expired, wrong product' });
        if (reason === null) return;
        await api(`/api/admin/offers/${o.id}/remove`, { method: 'POST', body: { reason } });
        toast('Listing removed');
      } else if (btn.dataset.offerAct === 'mod-restore') {
        await api(`/api/admin/offers/${o.id}/restore`, { method: 'POST', body: {} });
        toast('Listing restored');
      }
      renderRoute();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function editOfferModal(o) {
  return openModal(
    html`<form>
      <h2>Edit your ${o.store} listing</h2>
      <div class="form-error" hidden></div>
      ${offerFields(o)}
      <p class="hint small">To change the link itself, remove this listing and add the new link.</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Save</button></div>
    </form>`,
    async (fd) => {
      await api(`/api/offers/${o.id}`, { method: 'PATCH', body: Object.fromEntries(fd) });
      return true;
    },
  );
}

/** "+ Add another store": paste link → check + auto-fill → confirm price → attach to this deal. */
function openAddStore(d) {
  const panel = $('#add-store-panel');
  panel.hidden = false;
  const step1 = (value = '', error = '') => {
    panel.innerHTML = String(html`<form class="panel add-store" id="add-url-form">
      <h3 style="margin-top:0">Add another store for this product</h3>
      ${error}
      <div class="field"><label for="a-url">Product link on the other store</label>
        <input id="a-url" name="url" type="url" required value="${value}" placeholder="https://www.flipkart.com/…"></div>
      <div class="form-actions"><button type="button" class="btn" id="cancel-add">Cancel</button><button class="btn btn-primary" id="a-btn">Continue</button></div>
    </form>`);
    $('#a-url').focus();
    $('#cancel-add').addEventListener('click', () => {
      panel.hidden = true;
      panel.innerHTML = '';
    });
    $('#add-url-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('#a-url').value.trim();
      const btn = $('#a-btn');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await api('/api/deals/prefill', { method: 'POST', body: { url, dealId: d.id } });
        step2(r);
      } catch (err) {
        if (err.status === 401) return goLogin();
        step1(url, err.data?.duplicate ? duplicateLinkNotice(err.data.duplicate) : html`<div class="form-error">${err.message}</div>`);
      }
    });
  };
  const step2 = (r) => {
    panel.innerHTML = String(html`<form class="panel add-store" id="add-offer-form" novalidate>
      <h3 style="margin-top:0">Add another store for this product</h3>
      ${urlChip(r.url)}
      ${r.ok ? '' : html`<div class="notice">Couldn't read the price automatically${r.reason ? html` (${r.reason})` : ''} — please enter it.</div>`}
      ${r.fields.title ? html`<p class="small muted">That page is titled “${r.fields.title}”. Please make sure it's the same product.</p>` : ''}
      <div id="form-error"></div>
      ${offerFields(r.fields)}
      <div class="form-actions"><button type="button" class="btn" id="cancel-add">Cancel</button><button class="btn btn-primary">Add store</button></div>
    </form>`);
    const form = $('#add-offer-form');
    bindFormHelpers(form);
    $('#change-url').addEventListener('click', () => step1(r.url));
    $('#cancel-add').addEventListener('click', () => {
      panel.hidden = true;
      panel.innerHTML = '';
    });
    onFormSubmit(form, async (body) => {
      await api(`/api/deals/${d.id}/offers`, { method: 'POST', body: { ...body, url: r.url, gtin: r.fields.gtin, mpn: r.fields.mpn } });
      toast(`Added ${body.store} — thanks!`);
      renderRoute();
    }, (err) => (err.data?.duplicate ? duplicateLinkNotice(err.data.duplicate) : html`<div class="form-error">${err.message}</div>`));
  };
  step1();
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function commentItem(c) {
  const roleBadge = c.author.role !== 'user' ? html`<span class="badge role-${c.author.role}">${c.author.role === 'admin' ? 'Admin' : 'Mod'}</span>` : '';
  const canReport = state.user && state.user.id !== c.author.id;
  return html`<div class="comment">
    <span class="avatar">${c.author.handle[0]}</span>
    <div style="flex:1;min-width:0">
      <div class="comment-head"><strong>@${c.author.handle}</strong>${roleBadge}<span class="muted small" title="${fullDate(c.createdAt)}">${timeAgo(c.createdAt)}</span>
        ${canReport ? html`<button class="linkish" data-action="report" data-type="comment" data-id="${c.id}">Report</button>` : ''}</div>
      <div class="comment-body">${c.body}</div>
    </div>
  </div>`;
}

function bindCommentForm(id) {
  const form = $('#comment-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    const errBox = $('.form-error', form);
    btn.disabled = true;
    try {
      const { comment } = await api(`/api/deals/${id}/comments`, { method: 'POST', body: { body: form.elements.namedItem('body').value } });
      $('#no-comments')?.remove();
      $('#comment-list').insertAdjacentHTML('beforeend', String(commentItem(comment)));
      $('#comment-count').textContent = `(${$$('.comment', $('#comment-list')).length})`;
      form.reset();
      errBox.hidden = true;
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}
