// "Link or product number": with only a product number, Claude searches the web for the shop's page of that piece,
// so lookup.js can then read it like a pasted link.
// Needs Claude API credentials on the server (ANTHROPIC_API_KEY), like classify.js.
'use strict';
const { Anthropic } = require('@anthropic-ai/sdk');

const prompt = (code) => `Someone typed this product number (article number, style code or SKU) of a piece of clothing, shoes or an accessory into their wardrobe app: "${code}"
Search the web for the shop page where this exact piece is sold. Prefer the brand's own online shop, otherwise a large fashion retailer.
Answer with only a JSON object and nothing else:
{"url": "the product page's full https address", "name": "the product's name", "brand": "the brand", "price": "the price with its currency, e.g. € 49.95"}
If you can't find this exact piece, answer {"url": ""}.`;

let client;
async function findByCode(code) {
  code = String(code || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!code) return null;
  client = client || new Anthropic();
  const messages = [{ role: 'user', content: prompt(code) }];
  let res;
  // a long search can pause; sending the turn back lets it carry on
  for (let i = 0; i < 3; i++) {
    res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      output_config: { effort: 'low' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      // if the safety check declines the request, Anthropic re-runs it on its recommended fallback model
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages
    });
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let hit;
  try { hit = JSON.parse((/\{[\s\S]*\}/.exec(text) || ['{}'])[0]); } catch (e) { return null; }
  const url = String(hit.url || '').trim();
  if (!/^https:\/\/\S+$/i.test(url)) return null;
  const str = (v, n) => String(v || '').trim().slice(0, n);
  return { url, name: str(hit.name, 80), brand: str(hit.brand, 40), price: str(hit.price, 20) };
}

module.exports = { findByCode };
