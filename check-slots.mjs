#!/usr/bin/env node
/**
 * Auderghem appointment watcher — "Première inscription - UE - 30 min."
 *
 * Replays the booking flow from a fresh session on every run:
 *   GET  /                                   (start page, gets session cookie)
 *   GET  WaitBox.asp?...&c0=3956             (Étrangers)
 *   GET  WaitBox.asp?...&c0=3968             (Arrivée en Belgique)
 *   GET  WaitBox.asp?...&c0=3957             (Ressortissant UE)
 *   POST Waitbox.asp  dt=..._MULTI_ET1, inp_qte3959=1   (select the service)
 *   POST Waitbox.asp  dt=..._ET2, all days + all hours  (preferences)
 *   -> page listing the earliest slot per day
 *
 * Sends a push notification (ntfy.sh) when a slot earlier than BEFORE appears.
 * Never books anything and never sends personal data.
 *
 * Env vars:
 *   NTFY_TOPIC   required for notifications (e.g. "char-auderghem-k39fz2")
 *   BEFORE       YYYY-MM-DD, alert for slots strictly before this date (default 2026-11-24)
 *   STATE_FILE   where already-notified slots are remembered (default ./.slot-state.json)
 *   NTFY_SERVER  default https://ntfy.sh
 *
 * Usage:  node check-slots.mjs          normal check
 *         node check-slots.mjs --test   send a test notification and print current slots
 *
 * Requires Node 18+ (Node 20+ recommended). No dependencies.
 */
import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://auderghem.covservices.net/';
const CATEGORY_PATH = ['3956', '3968', '3957']; // Étrangers > Arrivée en Belgique > UE
const SERVICE_ID = '3959';                       // Première inscription - UE - 30 min.
const BEFORE = process.env.BEFORE || '2026-11-24';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const STATE_FILE = process.env.STATE_FILE || '.slot-state.json';
const TEST = process.argv.includes('--test');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* ---------------- HTTP with a tiny cookie jar ---------------- */
const jar = new Map();

function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
  for (const c of list) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

async function request(url, { method = 'GET', form } = {}) {
  let u = new URL(url, BASE);
  let body = form ? new URLSearchParams(form).toString() : undefined;
  for (let hop = 0; hop < 10; hop++) {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.8' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(u, { method, body, headers, redirect: 'manual' });
    storeCookies(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      u = new URL(loc, u); method = 'GET'; body = undefined;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${u.pathname}`);
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1] || 'windows-1252';
    const html = new TextDecoder(charset).decode(await res.arrayBuffer());
    return { url: u, html };
  }
  throw new Error('Too many redirects');
}

/* ---------------- HTML helpers (regex, no deps) ---------------- */
const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function findLinkByC0(html, base, c0) {
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(unescape(m[1]), base);
      if (/waitbox\.asp$/i.test(u.pathname) && u.searchParams.get('c0') === c0) return u;
    } catch { /* ignore */ }
  }
  return null;
}

export function formFields(html) {
  const start = html.search(/<form[^>]*RDV_FORM/i);
  const end = start >= 0 ? html.indexOf('</form>', start) : -1;
  const scope = start >= 0 ? html.slice(start, end > start ? end : undefined) : html;
  const fields = [];
  for (const m of scope.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    fields.push([name, unescape(value)]);
  }
  return fields;
}

export function parseSlots(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
  const seen = new Set();
  const slots = [];
  for (const m of text.matchAll(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/g)) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    const key = `${iso} ${m[4]}:${m[5]}`;
    if (!seen.has(key)) { seen.add(key); slots.push({ iso, time: `${m[4]}:${m[5]}`, label: `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` }); }
  }
  return slots.sort((a, b) => (a.iso + a.time).localeCompare(b.iso + b.time));
}

const dtOf = (fields) => fields.find(([n]) => n === 'dt')?.[1];

/* ---------------- The booking flow (read-only) ---------------- */
export async function fetchSlots() {
  let page = await request(BASE);
  for (const c0 of CATEGORY_PATH) {
    const next = findLinkByC0(page.html, page.url, c0);
    if (!next) throw new Error(`Flow changed: no link to category c0=${c0}`);
    page = await request(next);
  }

  // Step 1: choose the service (quantity 1)
  let fields = formFields(page.html);
  if (!fields.some(([n]) => n === `inp_qte${SERVICE_ID}`)) throw new Error(`Flow changed: service ${SERVICE_ID} not on page`);
  fields = fields.map(([n, v]) => [n, n === `inp_qte${SERVICE_ID}` ? '1' : v]);
  page = await request('Waitbox.asp', { method: 'POST', form: fields });

  // Step 2: preferences — tick every day (RJx) and every time range (RHx)
  fields = formFields(page.html);
  if (dtOf(fields) !== 'Waitbox_NV_RDV_ET2') throw new Error(`Flow changed: expected preferences step, got ${dtOf(fields)}`);
  fields = fields.map(([n, v]) => [n, /^R[JH]\d+$/.test(n) ? '1' : v]);
  page = await request('Waitbox.asp', { method: 'POST', form: fields });

  const slots = parseSlots(page.html);
  const dt = dtOf(formFields(page.html));
  if (!slots.length && dt !== 'Waitbox_NV_RDV_ET3') throw new Error(`Flow changed: no slot list (dt=${dt})`);
  return slots;
}

/* ---------------- Notifications + state ---------------- */
async function notify(title, message, priority = 'high') {
  if (!NTFY_TOPIC) { console.log(`[no NTFY_TOPIC] ${title}: ${message}`); return; }
  const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST',
    body: message,
    headers: { Title: title, Priority: priority, Tags: 'date', Click: BASE },
  });
  if (!res.ok) console.error(`ntfy failed: HTTP ${res.status}`);
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return { notified: [], lastErrorAlert: 0 }; }
}
const saveState = (s) => writeFile(STATE_FILE, JSON.stringify(s, null, 2));

async function main() {
  const state = await loadState();
  let slots;
  try {
    slots = await fetchSlots();
  } catch (err) {
    console.error(new Date().toISOString(), 'ERROR', err.message);
    // At most one error alert every 12h, so a site outage doesn't spam you.
    if (Date.now() - (state.lastErrorAlert || 0) > 12 * 3600e3) {
      await notify('Slot watcher error', `${err.message}\nThe check will keep retrying.`, 'low');
      state.lastErrorAlert = Date.now();
    }
    await saveState(state);
    process.exitCode = 1;
    return;
  }

  const early = slots.filter((s) => s.iso < BEFORE);
  console.log(new Date().toISOString(), `earliest: ${slots[0]?.label ?? 'none'} | ${slots.length} days listed | ${early.length} before ${BEFORE}`);

  if (TEST) {
    await notify('Slot watcher test', `It works. Earliest slot right now: ${slots[0]?.label ?? 'none'}`, 'default');
    return;
  }

  const fresh = early.filter((s) => !state.notified.includes(s.label));
  if (fresh.length) {
    await notify(
      'Earlier Auderghem appointment!',
      `Première inscription UE:\n${early.map((s) => '• ' + s.label).join('\n')}\nBook fast at auderghem.covservices.net`,
      'urgent',
    );
  }
  // Remember what we've already alerted on (forget slots that disappeared, so they re-alert if they come back).
  state.notified = early.map((s) => s.label);
  state.lastEarliest = slots[0]?.label ?? null;
  state.lastCheck = new Date().toISOString();
  await saveState(state);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-slots.mjs')) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
