// Emails from the server: for now only "confirm your email address" after signing up.
// Sent through Resend (resend.com) when RESEND_API_KEY is in server/.env (see server/.env.example).
// Without a domain of our own set up there, Resend only delivers to the email address of the Resend account.
// Without the key the link is printed in the server's terminal, so sign-up can still be tried out on this Mac.
'use strict';

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'My Gardrobe <onboarding@resend.dev>';
console.log(KEY ? 'Email: sending through Resend as ' + FROM : 'Email: not set up (RESEND_API_KEY in server/.env), confirm links are printed here instead');

async function send(mail) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, ...mail })
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()).slice(0, 300));
}

const TEXT = {
  en: { subject: 'Confirm your email for My Gardrobe', hi: 'Hi {name},', body: 'Tap the button to confirm that this is your email address. Then log in to My Gardrobe with this email and your password.', button: 'Confirm my email', ignore: 'If you didn\'t sign up for My Gardrobe, you can ignore this email.', expires: 'The link works for 24 hours.' },
  hu: { subject: 'Erősítsd meg az e-mail-címed – My Gardrobe', hi: 'Szia {name}!', body: 'Nyomj a gombra, és ezzel megerősíted, hogy ez a te e-mail-címed. Utána jelentkezz be a My Gardrobe-ba ezzel az e-mail-címmel és a jelszavaddal.', button: 'Megerősítem az e-mail-címem', ignore: 'Ha nem te regisztráltál a My Gardrobe-ba, nyugodtan hagyd figyelmen kívül ezt a levelet.', expires: 'A link 24 óráig érvényes.' }
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendVerify(to, name, link, lang) {
  const t = TEXT[lang] || TEXT.en, hi = t.hi.replace('{name}', name);
  if (!KEY) { console.log(`\nConfirm-email link for ${to} (email not set up, so nothing was sent):\n${link}\n`); return; }
  await send({
    to, subject: t.subject,
    text: `${hi}\n\n${t.body}\n\n${link}\n\n${t.expires}\n${t.ignore}`,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#F6F2EA;color:#2B2B2B">
  <h1 style="font-size:24px;margin:0 0 16px">My Gardrobe</h1>
  <p style="font-size:16px;line-height:1.5">${esc(hi)}</p>
  <p style="font-size:16px;line-height:1.5">${esc(t.body)}</p>
  <p style="margin:28px 0"><a href="${esc(link)}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#2B2B2B;color:#F6F2EA;font-weight:700;text-decoration:none">${esc(t.button)}</a></p>
  <p style="font-size:13px;color:#6A635A;line-height:1.5">${esc(t.expires)}<br>${esc(t.ignore)}</p>
</div>`
  });
}

module.exports = { sendVerify };
