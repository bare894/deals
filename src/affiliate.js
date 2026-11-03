// Affiliate links (Amazon Associates). With AMAZON_ASSOCIATE_TAG set (e.g. "sharedeals-21"), every
// Amazon.in store link the site shows carries ShareDeals' tag, replacing any tag the poster's link
// had. offers.source_url keeps the link exactly as posted; the tag is added only when links are
// shown, so changing or removing the variable applies to every deal at once.

const AMAZON_HOST = /^(www\.|m\.)?amazon\.in$/i;
// Other affiliate/attribution parameters that would compete with ours.
const AMAZON_DROP = ['tag', 'ascsubtag', 'linkCode', 'linkId', 'creative', 'creativeASIN', 'camp', 'ref_'];

export function amazonTagFromEnv(env = process.env) {
  const tag = String(env.AMAZON_ASSOCIATE_TAG || '').trim();
  return /^[\w-]{1,64}$/.test(tag) ? tag : null;
}

/** The link "Get deal" opens: the posted link, with our Amazon tag when one is configured. */
export function buyUrl(sourceUrl, canonicalUrl, { amazonTag } = {}) {
  if (!amazonTag) return sourceUrl;
  let canon;
  let src;
  try {
    canon = new URL(canonicalUrl);
    src = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }
  // Product pages: a clean /dp/ASIN link (canonicalizeUrl reduces every Amazon product URL to it).
  if (AMAZON_HOST.test(canon.hostname)) {
    const asin = canon.pathname.match(/^\/dp\/([A-Z0-9]{10})$/);
    if (asin) return `https://www.amazon.in/dp/${asin[1]}?tag=${encodeURIComponent(amazonTag)}`;
  }
  // Other Amazon.in pages (deals, offers, search): keep the posted link and swap in our tag.
  // Short links (amzn.in) can't carry a tag, so they stay as posted.
  if (AMAZON_HOST.test(src.hostname)) {
    for (const p of AMAZON_DROP) src.searchParams.delete(p);
    src.searchParams.set('tag', amazonTag);
    return src.href;
  }
  return sourceUrl;
}
