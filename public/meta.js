// Search-result title and description for a deal page. Shared by the server (src/seo.js, full
// page loads) and the app (app.js, in-app navigation) so both always say the same thing.
//
// Title:       "<Product> at <N>% off on <Store> | ShareDeals", 30–65 characters, with the
//              product name cut to as few words as fit.
// Description: the full product title, price and discount details and the store, 120–320 characters.

const TITLE_MIN = 30;
const TITLE_MAX = 65;
const DESC_MIN = 120;
const DESC_MAX = 320;

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const words = (s) => String(s).split(/\s+/).filter(Boolean);

/** Fit `text` into `max` characters at a word boundary. */
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).replace(/\s+\S*$/, '');
  return (cut || text.slice(0, max)).replace(/[\s,;:|(–-]+$/, '');
}

function offer(d) {
  if (d.discountPct) return `at ${d.discountPct}% off`;
  if (d.price === 0) return 'free';
  if (d.price != null) return `at ${rupees(d.price)}`;
  return '';
}

export function dealMetaTitle(d) {
  const suffix = `${offer(d) ? ` ${offer(d)}` : ''}${d.store ? ` on ${d.store}` : ''} | ShareDeals`;
  const budget = Math.max(TITLE_MAX - suffix.length, 12);
  // The product name proper usually ends at the first separator: "Amazon Echo Dot (5th Gen…)",
  // "Philips Trimmer | 60 min run time", "Sony WH-1000XM6, Black". A one-word lead-in such as
  // "Free:" or "Combo |" is skipped.
  const parts = String(d.title).split(/\s[|–-]\s|[|(,[:]/).map((p) => p.trim()).filter(Boolean);
  const start = parts.length > 1 && words(parts[0]).length < 2 ? 1 : 0;
  const all = words(parts.slice(start).join(' ').replace(/[)\]]+/g, ' '));
  const core = words(parts[start] || '');
  let n = Math.min(core.length || all.length, 6);
  while (n > 1 && all.slice(0, n).join(' ').length > budget) n--;
  while (n < all.length && (all.slice(0, n).join(' ') + suffix).length < TITLE_MIN && all.slice(0, n + 1).join(' ').length <= budget) n++;
  return clip(all.slice(0, n).join(' '), budget) + suffix;
}

export function dealMetaDescription(d) {
  const price = d.price === 0 ? 'free' : d.price != null ? `for ${rupees(d.price)}` : '';
  const details = [
    price,
    d.fullPrice > d.price ? `(MRP ${rupees(d.fullPrice)}${d.discountPct ? `, ${d.discountPct}% off` : ''})` : d.discountPct ? `(${d.discountPct}% off)` : '',
    d.store ? `on ${d.store}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tail = `${details ? ` ${details}` : ''}.${d.offerCount > 1 ? ` Compare prices from ${d.offerCount} stores.` : ''}`;
  const extra = ' Posted and vetted by the ShareDeals community. Check the price, vote and grab the deal before it ends.';
  const title = clip(String(d.title).trim(), DESC_MAX - tail.length - 1);
  let desc = `${title}${tail}`;
  if (desc.length < DESC_MIN) desc += extra;
  return clip(desc, DESC_MAX);
}
