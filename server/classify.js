// Recognising a piece from its photo: Claude looks at the picture and picks the app's category, type,
// colour and (when a label or logo shows) the brand, so a new piece only needs saving.
// Needs Claude API credentials on the server (ANTHROPIC_API_KEY); without them the app simply skips this step.
'use strict';
const { Anthropic } = require('@anthropic-ai/sdk');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');

// Must match CATS and COLORS in app.html
const CATS = {
  coats: ['Jackets', 'Trench coats', 'Elegant coats', 'Fur coats', 'Leather coats', 'Winter coats', 'Ponchos', 'Rain coats'],
  sweaters: [], tshirts: [],
  dresses: ['Everyday dresses', 'Evening dresses', 'Maxi dresses', 'Mini dresses'],
  trousers: ['Elegant trousers', 'Everyday trousers', 'Comfy trousers'],
  jeans: ['Skinny jeans', 'Straight jeans', 'Wide-leg jeans', 'Mom jeans'],
  shoes: ['Sneakers', 'Boots', 'Sandals', 'Heels', 'Slippers', 'Loafers'],
  jewellery: ['Necklaces', 'Bracelets', 'Rings', 'Earrings'],
  bags: ['Backpacks', 'Crossbody bags', 'Tote bags', 'Clutches', 'Purses'],
  accessories: ['Hats', 'Baseball caps', 'Scarves', 'Sunglasses', 'Key charms']
};
const COLOURS = ['white', 'black', 'beige', 'brown', 'grey', 'blue', 'green', 'red', 'pink', 'yellow', 'gold', 'silver'];
// Plain strings, checked below: an unexpected answer then means "not sure" rather than a failed request
const Piece = z.object({
  cat: z.string().describe('One of: ' + Object.keys(CATS).join(', ')),
  sub: z.string().describe('A type of that category, or "none"'),
  color: z.string().describe('One of: ' + COLOURS.join(', ')),
  brand: z.string()
});
const PROMPT = `This photo shows one piece of clothing or an accessory that someone wants to add to their wardrobe app.
Pick its category and type from these (type "none" for a category without types):
${Object.entries(CATS).map(([c, s]) => `- ${c}: ${s.length ? s.join(', ') : 'none'}`).join('\n')}
T-shirts, shirts, blouses and tops are "tshirts"; knitwear, hoodies and sweatshirts are "sweaters"; blazers and jackets are "coats".
Pick the main colour of the piece itself, not the background or the person wearing it.
Brand: only if a label, logo or name is readable in the photo, otherwise an empty string.`;

let client;
async function classify(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('photo'), { status: 400, code: 'photo' });
  client = client || new Anthropic();
  const res = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: betaZodOutputFormat(Piece) },
    // if the safety check declines the request, Anthropic re-runs it on its recommended fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text: PROMPT }
    ] }]
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  const p = res.parsed_output;
  if (!CATS[p.cat]) return null;
  return { cat: p.cat, sub: CATS[p.cat].includes(p.sub) ? p.sub : '', color: COLOURS.includes(p.color) ? p.color : '', brand: p.brand.trim().slice(0, 40) };
}

module.exports = { classify, Anthropic };
