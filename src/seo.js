// Search engines and bots: per-page titles, descriptions and canonical links, structured data
// (JSON-LD), a server-rendered copy of each page's main content (the SPA replaces it on load, but
// crawlers that don't run JavaScript read it), robots.txt and sitemap.xml.
import { escapeHtml, inr } from './http.js';
import { slugify } from './db.js';
import { dealMetaDescription, dealMetaTitle, sizedImage } from '../public/meta.js';

const SITE = 'ShareDeals';
const SITE_TITLE = 'ShareDeals.in | Community-vetted deals in India';
const SITE_DESC = 'Find, vote on, and share the best deals from Flipkart, Amazon, Myntra, AJIO, Nykaa, Meesho and more, vetted by the community.';
const LIST_LIMIT = 60;

// Pages that are only useful to a signed-in person, never in search results.
const PRIVATE = /^\/(admin|account|submit|saved|alerts|login|register|forgot-password|reset-password)(\/|$)|^\/deals\/\d+\/edit$/;
// Every path the SPA knows; anything else is a real 404.
const KNOWN = /^\/(deals|submit|saved|alerts|login|register|forgot-password|reset-password|account|account\/delete|privacy|terms|delete-account|feedback|admin(\/\w+)?|deals\/\d+(\/[a-z0-9-]+)?|c\/[a-z0-9-]+|store\/[a-z0-9-]+)?$/;

export function dealSlug(title) {
  const s = slugify(title);
  return (s.length > 80 ? s.slice(0, 80).replace(/-[^-]*$/, '') : s) || 'deal';
}
export const dealPath = (d) => `/deals/${d.id}/${dealSlug(d.title)}`;

const esc = escapeHtml;
const priceText = (d) => (d.price === 0 ? 'FREE' : d.price != null ? inr(d.price) : '');
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function dealDescription(d) {
  const price = priceText(d);
  return [
    price && `${price}${d.fullPrice ? ` (MRP ${inr(d.fullPrice)}${d.discountPct ? `, ${d.discountPct}% off` : ''})` : ''} on ${d.store}`,
    d.offerCount > 1 ? `· compare ${d.offerCount} stores` : '',
    `· ${d.score >= 0 ? '+' : ''}${d.score} votes`,
  ]
    .filter(Boolean)
    .join(' ');
}

const absImage = (base, d) => {
  const p = d.imageUrl || `/img/placeholder.svg?t=${encodeURIComponent(d.title.slice(0, 20))}`;
  return p.startsWith('/') ? `${base}${p}` : p;
};

function dealListHtml(deals) {
  if (!deals.length) return '<p>No deals here yet.</p>';
  return `<ul class="ssr-list">${deals
    .map(
      (d) => `<li><a href="${esc(dealPath(d))}">${esc(d.title)}</a>: ${esc(priceText(d))}${d.fullPrice > d.price ? ` <s>${esc(inr(d.fullPrice))}</s>` : ''}${d.discountPct ? ` (${d.discountPct}% off)` : ''} on ${esc(d.store || '')}</li>`,
    )
    .join('')}</ul>`;
}

function breadcrumbs(base, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${base}${path}` })),
  };
}

const itemList = (base, deals) => ({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  itemListElement: deals.slice(0, 30).map((d, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}${dealPath(d)}`, name: d.title })),
});

export function createSeo({ db, repo }) {
  async function categories() {
    return db.all("SELECT id, name, slug FROM categories WHERE active = 1 ORDER BY name = 'Other', name");
  }

  /** Stores with live deals, keyed by URL slug: [{ slug, name, count }]. */
  async function stores() {
    const rows = await db.all(
      `SELECT o.store, COUNT(DISTINCT o.deal_id) AS n FROM offers o JOIN deals d ON d.id = o.deal_id
        WHERE o.status = 'active' AND d.status = 'active' GROUP BY o.store ORDER BY n DESC`,
    );
    const bySlug = new Map();
    for (const r of rows) {
      const slug = slugify(r.store);
      if (slug && !bySlug.has(slug)) bySlug.set(slug, { slug, name: r.store, count: r.n });
    }
    return [...bySlug.values()];
  }

  const storeBySlug = async (slug) => (await stores()).find((s) => s.slug === slug) || null;

  function linksNav(cats, storeList) {
    return `<nav aria-label="Browse"><h2>Categories</h2><ul>${cats.map((c) => `<li><a href="/c/${esc(c.slug)}">${esc(c.name)} deals</a></li>`).join('')}</ul>
      <h2>Stores</h2><ul>${storeList.slice(0, 20).map((s) => `<li><a href="/store/${esc(s.slug)}">${esc(s.name)} deals</a></li>`).join('')}</ul></nav>`;
  }

  /**
   * What to serve for a non-API, non-static GET. Returns { status, redirect } or
   * { status, title, description, canonical, noindex, ogType, image, extraMeta, jsonld, body }.
   */
  async function page(base, pathname, query) {
    // Old query-string category links → clean category URLs.
    if (pathname === '/deals' && query.get('category') && !query.get('q')) {
      const rest = new URLSearchParams(query);
      rest.delete('category');
      return { status: 301, redirect: `/c/${encodeURIComponent(query.get('category'))}${rest.toString() ? `?${rest}` : ''}` };
    }

    const dealMatch = pathname.match(/^\/deals\/(\d{1,9})(?:\/([a-z0-9-]+))?$/);
    if (dealMatch && dealMatch[2] !== 'edit') {
      const id = Number(dealMatch[1]);
      const row = await repo.getDealRow(id);
      if (row?.merged_into) {
        const target = await repo.getDealRow(row.merged_into);
        return { status: 301, redirect: target ? dealPath(target) : `/deals/${row.merged_into}` };
      }
      if (!row) return { status: 404, title: 'Deal not found', noindex: true, body: '<h1>Deal not found</h1><p><a href="/deals">See all deals</a></p>' };
      if (row.status !== 'active') {
        return { status: 410, title: 'Deal no longer available', noindex: true, body: '<h1>This deal is no longer available</h1><p><a href="/deals">See all deals</a></p>' };
      }
      const want = dealPath(row);
      if (pathname !== want) return { status: 301, redirect: want };
      return dealPage(base, id);
    }

    if (PRIVATE.test(pathname)) return { status: 200, title: SITE_TITLE, noindex: true, body: '' };
    if (!KNOWN.test(pathname)) return { status: 404, title: 'Page not found', noindex: true, body: '<h1>Page not found</h1><p><a href="/">Back to home</a></p>' };

    const cats = await categories();
    const storeList = await stores();

    const catMatch = pathname.match(/^\/c\/([a-z0-9-]+)$/);
    if (catMatch) {
      const cat = cats.find((c) => c.slug === catMatch[1]);
      if (!cat) return { status: 404, title: 'Category not found', noindex: true, body: '<h1>Category not found</h1><p><a href="/deals">See all deals</a></p>' };
      const hot = query.get('sort') === 'hot';
      const { items } = await repo.listDeals({ sort: hot ? 'hot' : 'new', categorySlug: cat.slug, limit: LIST_LIMIT });
      const path = `/c/${cat.slug}`;
      const h1 = `${cat.name} deals today`;
      return {
        status: 200,
        title: `${h1}: best ${cat.name} offers & discounts in India | ${SITE}`,
        description: `Today's best ${cat.name} deals, offers and price drops from Amazon, Flipkart, Myntra and more, posted and voted on by the ShareDeals community.`,
        canonical: `${base}${path}${hot ? '?sort=hot' : ''}`,
        noindex: Boolean(query.get('q')),
        jsonld: [breadcrumbs(base, [['Home', '/'], [cat.name, path]]), itemList(base, items)],
        body: `<h1>${esc(h1)}</h1><p>Latest ${esc(cat.name)} deals and discounts in India, vetted by the community.</p>${dealListHtml(items)}${linksNav(cats, storeList)}`,
      };
    }

    const storeMatch = pathname.match(/^\/store\/([a-z0-9-]+)$/);
    if (storeMatch) {
      const store = storeList.find((s) => s.slug === storeMatch[1]);
      if (!store) return { status: 404, title: 'Store not found', noindex: true, body: '<h1>Store not found</h1><p><a href="/deals">See all deals</a></p>' };
      const { items } = await repo.listDeals({ storeName: store.name, limit: LIST_LIMIT });
      const path = `/store/${store.slug}`;
      const h1 = `${store.name} deals today`;
      return {
        status: 200,
        title: `${h1}: ${store.name} offers, discounts & sale prices | ${SITE}`,
        description: `The latest ${store.name} deals, offers and price drops in India, posted and voted on by the ShareDeals community. Updated as new deals come in.`,
        canonical: `${base}${path}`,
        jsonld: [breadcrumbs(base, [['Home', '/'], [`${store.name} deals`, path]]), itemList(base, items)],
        body: `<h1>${esc(h1)}</h1><p>Every live ${esc(store.name)} deal on ShareDeals, newest first.</p>${dealListHtml(items)}${linksNav(cats, storeList)}`,
      };
    }

    if (pathname === '/deals') {
      const q = (query.get('q') || '').trim();
      const hot = query.get('sort') === 'hot';
      const { items } = await repo.listDeals({ sort: hot ? 'hot' : 'new', q: q.slice(0, 100) || null, limit: LIST_LIMIT });
      const h1 = q ? `Deals matching “${q}”` : hot ? 'Hot deals in India right now' : 'All deals: latest offers in India';
      return {
        status: 200,
        title: `${h1} | ${SITE}`,
        description: hot ? 'The most upvoted deals in India right now, from Amazon, Flipkart, Myntra, AJIO, Nykaa and more.' : SITE_DESC,
        canonical: `${base}/deals${hot ? '?sort=hot' : ''}`,
        noindex: Boolean(q),
        jsonld: [itemList(base, items)],
        body: `<h1>${esc(h1)}</h1>${dealListHtml(items)}${linksNav(cats, storeList)}`,
      };
    }

    if (pathname === '/') {
      const items = await repo.latest(LIST_LIMIT);
      return {
        status: 200,
        title: SITE_TITLE,
        description: SITE_DESC,
        canonical: `${base}/`,
        image: `${base}/img/og-image.png`,
        jsonld: [
          {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'ShareDeals.in',
            url: `${base}/`,
            potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${base}/deals?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
          },
          { '@context': 'https://schema.org', '@type': 'Organization', name: 'ShareDeals.in', url: `${base}/`, logo: `${base}/icon-512.png` },
          itemList(base, items),
        ],
        body: `<h1>Best deals in India today, vetted by the community</h1>${dealListHtml(items)}${linksNav(cats, storeList)}`,
      };
    }

    // Static content pages (privacy, terms, feedback…): indexable, rendered by the SPA.
    return { status: 200, title: SITE_TITLE, description: SITE_DESC, canonical: `${base}${pathname}`, body: '' };
  }

  async function dealPage(base, id) {
    const d = await repo.getDeal(id);
    const url = `${base}${dealPath(d)}`;
    const image = absImage(base, d);
    const offers = (d.offers || []).filter((o) => o.status === 'active');
    const related = await repo.similar(d.id, 10);
    const crumbs = [['Home', '/'], d.category ? [d.category.name, `/c/${d.category.slug}`] : ['All deals', '/deals'], [d.title, dealPath(d)]];
    const product = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: d.title,
      image: [image],
      description: (d.details || dealDescription(d)).slice(0, 5000),
      ...(d.category ? { category: d.category.name } : {}),
      ...(d.gtin ? { gtin: d.gtin } : {}),
      ...(d.mpn ? { mpn: d.mpn } : {}),
      offers: offers
        .filter((o) => o.price != null)
        .map((o) => ({
          '@type': 'Offer',
          url,
          price: o.price.toFixed(2),
          priceCurrency: 'INR',
          availability: 'https://schema.org/InStock',
          itemCondition: 'https://schema.org/NewCondition',
          seller: { '@type': 'Organization', name: o.store },
        })),
    };
    const offerRows = offers
      .map((o) => `<li>${esc(o.store)}: ${esc(priceText(o))}${o.fullPrice > o.price ? ` (MRP ${esc(inr(o.fullPrice))})` : ''}, <a href="${esc(o.url)}" rel="nofollow noopener">view on ${esc(o.store)}</a></li>`)
      .join('');
    return {
      status: 200,
      title: dealMetaTitle(d),
      description: dealMetaDescription(d),
      ogTitle: d.title,
      canonical: url,
      ogType: 'product',
      image,
      extraMeta: [
        ['product:price:amount', d.price?.toFixed(2)],
        ['product:price:currency', 'INR'],
      ],
      jsonld: [...(product.offers.length ? [product] : []), breadcrumbs(base, crumbs)],
      preloadImage: d.imageUrl ? { href: sizedImage(d.imageUrl, 600), srcset: sizedImage(d.imageUrl, 600) !== d.imageUrl ? `${sizedImage(d.imageUrl, 600)} 1x, ${sizedImage(d.imageUrl, 1200)} 2x` : null } : null,
      body: `<article><nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${crumbs.map(([n, p], i) => (i === crumbs.length - 1 ? `<li aria-current="page">${esc(n)}</li>` : `<li><a href="${esc(p)}">${esc(n)}</a></li>`)).join('')}</ol></nav>
        <h1>${esc(d.title)}</h1>
        <p>${esc(dealDescription(d))}</p>
        ${d.details ? `<p>${esc(d.details)}</p>` : ''}
        ${offerRows ? `<h2>Where to buy</h2><ul>${offerRows}</ul>` : ''}
        <p>Posted by @${esc(d.poster.handle || 'deleted user')} · ${d.commentCount} comments</p></article>
        ${related.length ? `<h2>Similar deals</h2>${dealListHtml(related)}` : ''}`,
    };
  }

  /** Fill index.html's head and <main> from page(). */
  function render(indexHtml, base, p) {
    const title = p.title || SITE_TITLE;
    const desc = p.description || SITE_DESC;
    const og = [
      ['og:type', p.ogType || 'website'], ['og:site_name', SITE], ['og:title', p.ogTitle || title], ['og:description', desc],
      ...(p.canonical ? [['og:url', p.canonical]] : []), ['og:image', p.image || `${base}/img/og-image.png`], ['og:locale', 'en_IN'],
      ...(p.extraMeta || []),
    ];
    const head = [
      ...og.filter(([, c]) => c != null).map(([k, c]) => `<meta property="${k}" content="${esc(c)}">`),
      '<meta name="twitter:card" content="summary_large_image">',
      p.noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow, max-image-preview:large">',
      ...(p.canonical ? [`<link rel="canonical" href="${esc(p.canonical)}">`, `<meta property="al:web:url" content="${esc(p.canonical)}">`] : []),
      ...(p.jsonld || []).map(ld),
      // The app shows this image as the page's largest element; start fetching it with the HTML.
      ...(p.preloadImage
        ? [`<link rel="preload" as="image" href="${esc(p.preloadImage.href)}"${p.preloadImage.srcset ? ` imagesrcset="${esc(p.preloadImage.srcset)}"` : ''} fetchpriority="high">`]
        : []),
    ].join('\n    ');
    return indexHtml
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`)
      .replace('<!--OG-->', head)
      .replace('<main id="app" class="container" tabindex="-1"></main>', `<main id="app" class="container" tabindex="-1">${p.body ? `<div class="ssr">${p.body}</div>` : ''}</main>`);
  }

  function robots(base) {
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /admin',
      'Disallow: /account',
      'Disallow: /submit',
      'Disallow: /saved',
      'Disallow: /alerts',
      'Disallow: /login',
      'Disallow: /register',
      'Disallow: /forgot-password',
      'Disallow: /reset-password',
      'Disallow: /auth/',
      'Disallow: /deals/*/edit',
      'Disallow: /deals?q=',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n');
  }

  async function sitemap(base) {
    const iso = (ms) => new Date(Number(ms)).toISOString();
    const deals = await db.all(
      "SELECT id, title, COALESCE(updated_at, created_at) AS t FROM deals WHERE status = 'active' AND merged_into IS NULL ORDER BY created_at DESC LIMIT 45000",
    );
    const newest = deals[0] ? iso(deals[0].t) : new Date().toISOString();
    const urls = [
      [`${base}/`, newest, 'hourly', '1.0'],
      [`${base}/deals`, newest, 'hourly', '0.9'],
      [`${base}/deals?sort=hot`, newest, 'hourly', '0.8'],
      ...(await categories()).map((c) => [`${base}/c/${c.slug}`, newest, 'daily', '0.8']),
      ...(await stores()).map((s) => [`${base}/store/${s.slug}`, newest, 'daily', '0.8']),
      ...deals.map((d) => [`${base}${dealPath(d)}`, iso(d.t), 'weekly', '0.6']),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map(([loc, lastmod, freq, pri]) => `<url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`)
      .join('\n')}\n</urlset>\n`;
  }

  return { page, render, robots, sitemap, stores, storeBySlug };
}
