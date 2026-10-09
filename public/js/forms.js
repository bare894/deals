// Form fragments shared by posting, adding a store, and editing.
// A deal has PRODUCT fields (title, image, category, details) and one or more STORE LISTINGS
// (store, price, MRP, note) — the form sections mirror that split.
import { $, html, parseMoney, state } from './core.js';

export function productFields(v = {}) {
  return html`
    <div class="field"><label for="f-title">Product title</label><input id="f-title" name="title" maxlength="200" required value="${v.title || ''}">
      <span class="hint">Name the product, not the store offer — e.g. “Sony WH-1000XM6 Wireless Headphones”. Every store's listing shares it.</span></div>
    <div class="field"><label for="f-image">Image URL</label><input id="f-image" name="imageUrl" type="url" value="${v.imageUrl || ''}" placeholder="https://…">
      <span class="hint">Auto-filled from the page when possible — paste a different image link to replace it.</span></div>
    <div class="field"><label for="f-cat">Category</label>
      <select id="f-cat" name="categoryId" required>
        <option value="">Choose a category…</option>
        ${state.categories.map((c) => html`<option value="${c.id}" ${Number(v.categoryId) === c.id ? 'selected' : ''}>${c.name}</option>`)}
      </select></div>
    <div class="field"><label for="f-details">About this deal</label>
      <textarea id="f-details" name="details" maxlength="5000" placeholder="What makes it a good deal, key specs, how it compares to past prices…">${v.details || ''}</textarea></div>
    <input type="hidden" name="gtin" value="${v.gtin || ''}"><input type="hidden" name="mpn" value="${v.mpn || ''}">`;
}

export function offerFields(v = {}) {
  return html`
    <div class="field-row">
      <div class="field"><label for="f-store">Store</label><input id="f-store" name="store" maxlength="80" required value="${v.store || ''}"></div>
      <div class="field"><label for="f-price">Price at this store (₹)</label><input id="f-price" name="price" inputmode="decimal" required value="${v.price ?? ''}" placeholder="0 for free"></div>
      <div class="field"><label for="f-full">MRP (₹)</label><input id="f-full" name="fullPrice" inputmode="decimal" value="${v.fullPrice ?? ''}" placeholder="Optional"></div>
    </div>
    <p class="discount-preview" id="discount-preview"></p>
    <div class="field"><label for="f-note">Store-specific offer (optional)</label>
      <input id="f-note" name="note" maxlength="300" value="${v.note || ''}" placeholder="e.g. Extra ₹1,000 off with HDFC cards · coupon SAVE200 · COD available"></div>`;
}

export function urlChip(url, { changeable = true } = {}) {
  return html`<div class="url-chip"><span>🔗</span><code>${url}</code>${changeable ? html`<button type="button" class="linkish" id="change-url">Change</button>` : ''}</div>`;
}

export function imagePreview(v = {}) {
  return html`<div class="img-preview" id="img-preview">${v.imageUrl ? html`<img src="${v.imageUrl}" data-label="${v.store || ''}" alt="Preview">` : 'No image'}</div>`;
}

/** Live discount % and image preview. */
export function bindFormHelpers(form) {
  const disc = $('#discount-preview', form);
  if (disc && form.elements.namedItem('price')) {
    const price = form.elements.namedItem('price');
    const full = form.elements.namedItem('fullPrice');
    const update = () => {
      const p = parseMoney(price.value);
      const f = parseMoney(full.value);
      disc.textContent = price.value && full.value && f > p && p >= 0 ? `${Math.round((1 - p / f) * 100)}% off MRP` : '';
    };
    price.addEventListener('input', update);
    full.addEventListener('input', update);
    update();
  }
  const img = form.elements.namedItem('imageUrl');
  const preview = $('#img-preview', form);
  if (img && preview) {
    img.addEventListener('change', () => {
      const val = img.value.trim();
      preview.innerHTML = val ? String(html`<img src="${val}" alt="Preview">`) : 'No image';
    });
  }
}

/** Standard async submit wiring: disables the button, renders errors into #form-error. */
export function onFormSubmit(form, handler, renderError = (err) => html`<div class="form-error">${err.message}</div>`) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit], button:not([type])', form);
    const errBox = $('#form-error', form);
    if (errBox) errBox.innerHTML = '';
    if (btn) btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (err) {
      if (errBox) {
        errBox.innerHTML = String(renderError(err));
        errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

export function duplicateLinkNotice(dup) {
  return html`<div class="form-error">This exact link has already been posted.
    ${dup?.id ? html`<a href="/deals/${dup.id}">View the deal: ${dup.title}</a>` : ''}</div>`;
}
