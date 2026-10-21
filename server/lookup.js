// "Add automatically": reads a shop's product page and works out what the piece is.
// Shops describe their products for Google (JSON-LD "Product") and for link previews (Open Graph);
// we read those, fetch the main photo, and guess the app's category, type and colour from the words.
'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const IMAGE_MAX = 8 * 1024 * 1024;   // also the limit for a product page
const fail = (code) => Object.assign(new Error(code), { status: 422, code });

// ---- fetching other sites safely: only public addresses (never this machine or the local network)
function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return privateIp(m[1]);
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function readLimited(res, max) {
  const reader = res.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel(); throw fail('big'); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
async function safeFetch(url, accept, max) {
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail('link');
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw fail('reach');
    if (addrs.some((a) => privateIp(a.address))) throw fail('link');
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en,de;q=0.8,hu;q=0.7' } }).catch(() => { throw fail('reach'); });
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (next) { url = new URL(next, u).href; continue; }
    if (!res.ok) throw fail(res.status === 403 || res.status === 429 ? 'blocked' : 'reach');
    return { res, body: await readLimited(res, max), url: u.href };
  }
  throw fail('reach');
}

// ---- reading the page
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m).replace(/\s+/g, ' ').trim();
function metaTags(html) {
  const out = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const val = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (key && val && !(key[1].toLowerCase() in out)) out[key[1].toLowerCase()] = decode(val[1] ?? val[2]);
  }
  return out;
}
function jsonLdProduct(html) {
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = [].concat(o['@type'] || []).map(String);
    if (t.includes('Product') || t.includes('ProductGroup')) found.push(o);
    if (o['@graph']) walk(o['@graph']);
    if (o.hasVariant && !found.length) walk(o.hasVariant);
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch (e) { /* some shops ship broken JSON; the meta tags still help */ }
  }
  return found[0] || null;
}
const first = (v) => (Array.isArray(v) ? first(v[0]) : v && typeof v === 'object' ? v.url || v.contentUrl || v.name || '' : v || '');

// ---- guessing what it is. Words in English, German and Hungarian (most shops here use one of them).
// Order matters: shoes and bags before clothes ("dress shoes", "denim jacket" before "denim").
const KINDS = [
  ['heels', /\b(heels?|high-heels?|pumps|stilettos?|slingbacks?|wedges?|kitten)\b|magassarkú|tűsarkú|körömcipő|éksarkú|absatzschuh|high heels|pumps|keilabsatz/, [
    ['Kitten heels', /kitten/], ['Stilettos', /stiletto|tűsarkú/], ['Wedges', /wedge|éksarkú|keilabsatz/], ['Mules', /\bmule/], ['Block heels', /block|telitalp|blockabsatz/], ['Pumps', /./]]],
  ['shoes', /\b(sneakers?|trainers?|boots?|booties|sandals?|loafers?|slippers?|mules?|espadrilles?|ballerinas?|shoes?)\b|cipő|csizm|bakancs|szandál|papucs|schuh|stiefel|sandale|pantolette/, [
    ['Sneakers', /sneaker|trainer|sportcipő|turnschuh/], ['Boots', /\bboot|booties|csizm|bakancs|stiefel/], ['Sandals', /sandal|szandál|espadrille/],
    ['Slippers', /slipper|papucs|hausschuh|mule|pantolette/], ['Loafers', /loafer|mokaszin|moccasin|ballerina/]]],
  ['bags', /\b(bags?|backpacks?|rucksacks?|totes?|shoppers?|clutch(es)?|purses?|wallets?|handbags?)\b|táska|hátizsák|pénztárca|tasche|geldbörse/, [
    ['Backpacks', /backpack|rucksack|hátizsák/], ['Crossbody bags', /crossbody|cross-body|shoulder|válltáska|umhänge/], ['Clutches', /clutch|estélyi táska/],
    ['Purses', /wallet|purse|pénztárca|geldbörse|card holder/], ['Tote bags', /tote|shopper/]]],
  ['jewellery', /\b(necklaces?|pendants?|bracelets?|bangles?|rings?|earrings?|studs|hoops)\b|nyaklánc|karkötő|gyűrű|fülbevaló|halskette|armband|ohrring/, [
    ['Earrings', /earring|stud|hoop|fülbevaló|ohrring/], ['Necklaces', /necklace|pendant|nyaklánc|kette/], ['Bracelets', /bracelet|bangle|karkötő|armband/], ['Rings', /\bring|gyűrű/]]],
  ['accessories', /\b(caps?|hats?|beanies?|scarf|scarves|sunglasses|key ?rings?|charms?)\b|sapka|kalap|sál|napszemüveg|kulcstartó|mütze|hut\b|schal|sonnenbrille/, [
    ['Baseball caps', /\bcap|baseball|basecap/], ['Sunglasses', /sunglasses|napszemüveg|sonnenbrille/], ['Scarves', /scarf|scarves|sál|schal|tuch/],
    ['Key charms', /key|charm|kulcstartó/], ['Hats', /hat|beanie|sapka|kalap|mütze|hut/]]],
  ['skirts', /\b(skirts?|skort)\b|szoknya|röcke|minirock|midirock|maxirock|jeansrock|faltenrock|plisseerock/, [
    ['Denim skirts', /denim|jeans|farmer/], ['Pleated skirts', /pleat|rakott|falten|plissee/], ['Mini skirts', /mini/], ['Maxi skirts', /maxi/], ['Midi skirts', /./]]],
  ['dresses', /\b(dress|dresses|gown)\b|ruha\b|ruhák|kleid/, [
    ['Maxi dresses', /maxi/], ['Mini dresses', /mini/], ['Evening dresses', /evening|party|gown|cocktail|estélyi|alkalmi|abend|cocktail/], ['Everyday dresses', /./]]],
  ['suits', /\b(suits?|tuxedos?)\b(?!\s*(trousers|pants|jacket|blazer|vest|waistcoat))|öltöny|kosztüm|szmoking|\banzug\b|anzüge|hosenanzug|smoking/, [
    ['Tuxedos', /tuxedo|szmoking|smoking/], ['Three-piece suits', /three[- ]piece|3[- ]piece|háromrészes|dreiteilig/], ['Skirt suits', /skirt|szoknyás|kostüm|rock/],
    ['Trouser suits', /trouser suit|pantsuit|pant suit|nadrágkosztüm|hosenanzug|women|női|damen/], ['Two-piece suits', /./]]],
  ['blazers', /\b(blazers?|sport ?coats?|suit jackets?)\b|zakó|sakko/, [
    ['Double-breasted blazers', /double[- ]breasted|kétsoros|zweireih/], ['Linen blazers', /linen|lenvászon|leinen/], ['Elegant blazers', /wool|tailored|elegant|elegáns|gyapjú|business|suit/], ['Everyday blazers', /./]]],
  ['coats', /\b(coats?|jackets?|parkas?|puffers?|trench|anoraks?|gilets?|ponchos?|bombers?)\b|kabát|dzseki|mellény|mantel|jacke/, [
    ['Trench coats', /trench/], ['Rain coats', /\brain|regen|eső/], ['Ponchos', /poncho/], ['Fur coats', /\bfur\b|faux fur|shearling|teddy|szőrme|bunda|pelz/],
    ['Leather coats', /leather|bőr|leder/], ['Winter coats', /puffer|parka|down|winter|padded|quilted|tél|pehely|daunen|stepp/],
    ['Jackets', /jacket|bomber|dzseki|jacke|gilet|mellény/], ['Elegant coats', /./]]],
  ['jeans', /\b(jeans|denim)\b|farmer/, [
    ['Skinny jeans', /skinny|slim/], ['Wide-leg jeans', /wide|flare|bootcut|baggy|bő szárú/], ['Mom jeans', /\bmom\b/], ['Straight jeans', /./]]],
  ['trousers', /\b(trousers|pants|chinos?|joggers?|leggings|sweatpants|culottes|slacks)\b|nadrág|melegítő|hose\b|hosen/, [
    ['Comfy trousers', /jogger|sweat|legging|jogging|melegítő|lounge/], ['Elegant trousers', /tailored|suit|pleat|smart|elegáns|anzug|bundfalten|bügelfalte/], ['Everyday trousers', /./]]],
  ['sweaters', /\b(sweaters?|jumpers?|pullovers?|cardigans?|knit|knitted|hoodies?|sweatshirts?|turtlenecks?)\b|pulóver|kardigán|kötött|garbó|strick/, []],
  ['shirts', /(?<!\bt-?|\btee |\bpolo |sweat|over)\bshirts?\b|\boxford\b|button[- ]?(down|up)|\bing\b|\bingek\b|hemd(?!chen)/, [
    ['Short-sleeve shirts', /short[- ]sleeve|rövid ujjú|kurzarm/], ['Linen shirts', /linen|lenvászon|leinen/],
    ['Patterned shirts', /print|pattern|stripe|check|plaid|floral|hawaii|minta|csíkos|kockás|virágos|gemustert|kariert|gestreift|geblümt/],
    ['Elegant shirts', /dress shirt|formal|oxford|poplin|business|elegáns|businesshemd|smokinghemd/], ['Everyday shirts', /./]]],
  ['tshirts', /\b(t-?shirts?|tees?|tops?|tanks?|blouses?|polos?|camis?|bodysuits?)\b|póló|blúz|felső|bluse|oberteil|shirt/, []]
];
const COLOURS = [
  ['gold', /\bgold|arany/], ['silver', /silver|ezüst|silber/],
  ['black', /black|fekete|schwarz|noir/], ['white', /white|ivory|cream|off-white|ecru|fehér|ekrü|weiß|weiss|creme/],
  ['beige', /beige|camel|sand|nude|taupe|stone|oatmeal|bézs|homok|drapp/], ['brown', /brown|chocolate|cognac|\btan\b|mocha|barna|braun/],
  ['grey', /grey|gray|charcoal|anthracite|melange|szürke|grau|antrazit/], ['blue', /blue|navy|indigo|denim|kék|blau|türkis|turquoise/],
  ['green', /green|khaki|olive|sage|mint|zöld|grün|oliv/], ['red', /\bred\b|burgundy|wine|bordeaux|piros|vörös|bordó|\brot\b/],
  ['pink', /pink|rose|blush|lilac|purple|lila|rózsaszín|rosa|flieder/], ['yellow', /yellow|mustard|sárga|mustár|gelb|senf/]
];
function guess(texts) {
  const words = texts.filter(Boolean).join(' · ').toLowerCase();
  for (const [cat, re, subs] of KINDS) {
    if (!re.test(words)) continue;
    const sub = (subs.find(([, s]) => s.test(words)) || [''])[0];
    return { cat, sub };
  }
  return { cat: '', sub: '' };
}
const colourOf = (text) => ((COLOURS.find(([, re]) => re.test(String(text || '').toLowerCase())) || [''])[0]);

// When the shop won't show us its page, the link itself often says what the piece is:
// zara.com/…/oversized-wool-coat-p02010101.html, zalando.at/…/levis-501-jeans-blue-le221n0.html
const MARKETPLACES = /(^|\.)(zalando|aboutyou|asos|amazon|ebay|otto|answear|modivo|fashiondays|vinted|shein|temu|bonprix|peek-cloppenburg|breuninger|mytheresa|farfetch)\./;
const SHOPS = { hm: 'H&M', cos: 'COS', 'stories': '& Other Stories', cosstores: 'COS', massimodutti: 'Massimo Dutti', pullandbear: 'Pull&Bear', bershka: 'Bershka', stradivarius: 'Stradivarius', mango: 'Mango', zara: 'Zara', uniqlo: 'Uniqlo', reserved: 'Reserved', nike: 'Nike', adidas: 'adidas', levi: "Levi's" };
function fromLink(link) {
  const u = new URL(link);
  const host = u.hostname.replace(/^www\d*\./, ''), site = host.split('.').slice(-2)[0];
  const parts = decodeURIComponent(u.pathname).split('/').map((p) => p.replace(/\.html?$/i, ''))
    .filter((p) => /[a-z]{3,}.*-.*[a-z]{2,}/i.test(p));   // a slug with words, not "en_gb" or "productpage"
  const slug = (parts.pop() || '').split('-').filter((w) => !/\d/.test(w) || /^\d{3}$/.test(w)).join(' ');   // drop ids, keep "501"
  const words = decodeURIComponent(u.pathname).replace(/[-_/.]+/g, ' ');
  const kind = guess([slug, words]);
  if (!slug && !kind.cat) return null;
  return { name: slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : '', brand: MARKETPLACES.test(host + '.') ? '' : SHOPS[site] || site.charAt(0).toUpperCase() + site.slice(1),
    cat: kind.cat, sub: kind.sub, color: colourOf(slug) || colourOf(words), number: '', price: '', photo: '', partial: true };
}
const cleanBrand = (b) => b.split(/\s[|–—:-]\s/)[0].trim();   // "Gymshark | We Do Gym" -> "Gymshark"
// "€ 49.95" from the shop's numbers; most shops give the amount and the currency code separately
const MONEY = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', HUF: 'Ft', PLN: 'zł', CZK: 'Kč', SEK: 'kr', DKK: 'kr', NOK: 'kr', RON: 'lei' };
function priceOf(offer, meta) {
  const amount = decode(first(offer.price ?? offer.lowPrice ?? (offer.priceSpecification || {}).price) || meta['product:price:amount'] || meta['og:price:amount'] || '');
  if (!amount || !/\d/.test(amount)) return '';
  const cur = decode(first(offer.priceCurrency ?? (offer.priceSpecification || {}).priceCurrency) || meta['product:price:currency'] || meta['og:price:currency'] || '').toUpperCase();
  const sym = MONEY[cur] || cur;
  return (sym === 'Ft' || sym === 'zł' || sym === 'Kč' || sym === 'kr' || sym === 'lei' ? amount + ' ' + sym : (sym ? sym + ' ' : '') + amount).trim().slice(0, 20);
}

async function lookup(link) {
  link = String(link || '').trim();
  if (!/^https?:\/\/\S+$/i.test(link)) throw fail('link');
  let page;
  try { page = await safeFetch(link, 'text/html,application/xhtml+xml,image/*', IMAGE_MAX); } catch (e) {
    const guessed = e.code !== 'link' && fromLink(link);
    if (guessed) return guessed;
    throw e;
  }
  // A link straight to a photo (copied from Google Images): just the photo
  const type = (page.res.headers.get('content-type') || '').split(';')[0];
  if (/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return { name: '', brand: '', cat: '', sub: '', color: '', number: '', price: '', photo: `data:${type};base64,${page.body.toString('base64')}` };
  const html = page.body.toString('utf8');
  const meta = metaTags(html), p = jsonLdProduct(html) || {};
  // a ProductGroup keeps its price (and words like "Schuhgröße") on its variants
  const variant = [].concat(p.hasVariant || [])[0] || {};
  const offer = [].concat(p.offers || variant.offers || [])[0] || {};
  const name = decode(first(p.name) || meta['og:title'] || meta['twitter:title'] || (/<title[^>]*>([^<]*)/i.exec(html) || [])[1]);
  const brand = cleanBrand(decode(first(p.brand) || meta['product:brand'] || meta['og:brand'] || meta.brand || meta['og:site_name'] || ''));
  const colourText = decode(first(p.color) || meta['product:color'] || meta.color || '');
  const category = decode([].concat(p.category || meta['product:category'] || '').join(' '));
  if (!name && !p.image && !meta['og:image']) { const guessed = fromLink(page.url); if (guessed) return guessed; throw fail('nothing'); }

  const path = decodeURIComponent(new URL(page.url).pathname).replace(/[-_/]+/g, ' ');
  let kind = guess([name, category, meta['og:description'], path, decode(first(variant.name)), decode(first(variant.size))]);
  // nothing in the words: a shop that sells only one kind says it in its name (sneakerdistrict.de)
  if (!kind.cat) { const host = new URL(page.url).hostname; kind = guess([/sneaker/.test(host) ? 'sneakers' : /shoe|schuh|cipo/.test(host) ? 'shoes' : '']); }
  const out = { name, brand, cat: kind.cat, sub: kind.sub, color: colourOf(colourText) || colourOf(name) || colourOf(path),
    number: decode(first(p.sku) || first(p.mpn) || offer.sku || ''), price: priceOf(offer, meta), photo: '' };

  // The main photo, sent back as a data URL so the app can shrink it like a photo from the phone
  const img = first(p.image) || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'];
  if (img) {
    try {
      const pic = await safeFetch(new URL(decode(img), page.url).href, 'image/avif,image/webp,image/png,image/jpeg,image/*', IMAGE_MAX);
      const type = (pic.res.headers.get('content-type') || '').split(';')[0];
      if (/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) out.photo = `data:${type};base64,${pic.body.toString('base64')}`;
    } catch (e) { /* no photo is fine: the person can add one */ }
  }
  return out;
}

module.exports = { lookup, guess, colourOf, privateIp, fromLink };
