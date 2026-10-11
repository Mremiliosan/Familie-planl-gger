// Henter iCal-kalendere og skriver dem som JSON, som appen kan læse.
// Kører i GitHub Actions (Node 20+, ingen afhængigheder).
//
// Miljøvariabler:
//   CALENDAR_FEEDS  JSON-liste: [{ "id":"icloud", "name":"iCloud", "url":"https://...", "member":"all" }]
//   TIMEZONE        Tidszone for klokkeslæt i output (standard Europe/Copenhagen)
//   OUT             Outputfil (standard data/calendar-events.json)
//   PREVIOUS_URL    Valgfri. Tidligere udgivet JSON, bruges hvis en kilde fejler
//   NOW             Kun til test (ISO-tidspunkt)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TZ = process.env.TIMEZONE || 'Europe/Copenhagen';
const OUT = process.env.OUT || 'data/calendar-events.json';
const NOW = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
const DAY = 86400000;
const WIN_START = NOW - 14 * DAY;
const WIN_END = NOW + 400 * DAY;
const MAX_EVENTS_PER_FEED = 6000;

/* ---------- tidszoner ---------- */
const WINDOWS_TZ = {
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London', 'UTC': 'UTC', 'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles'
};
const fmtCache = new Map();
function dtf(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }));
  return fmtCache.get(tz);
}
function resolveTz(tzid) {
  if (!tzid) return TZ;
  const name = WINDOWS_TZ[tzid] || tzid;
  try { dtf(name); return name; } catch { return TZ; }
}
function partsInTz(ms, tz) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function offsetMs(ms, tz) {
  const p = partsInTz(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function wallToUtc(y, m, d, h, mi, s, tz) {
  if (tz === 'UTC') return Date.UTC(y, m - 1, d, h, mi, s);
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off = offsetMs(guess, tz);
  let t = guess - off;
  const off2 = offsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}
const pad = n => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/* ---------- iCal-parsing ---------- */
const unfold = text => text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
function splitOutside(s, ch) {
  const out = []; let cur = '', q = false;
  for (const c of s) {
    if (c === '"') { q = !q; cur += c; } else if (c === ch && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function parseLine(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
  if (i >= line.length) return null;
  const parts = splitOutside(line.slice(0, i), ';');
  const name = parts.shift().toUpperCase(); const params = {};
  for (const p of parts) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
  return { name, params, value: line.slice(i + 1) };
}
const unescapeText = s => (s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseEvents(text) {
  const events = []; let cur = null, inAlarm = false;
  for (const line of unfold(text)) {
    if (!line) continue;
    const p = parseLine(line); if (!p) continue;
    if (p.name === 'BEGIN') {
      const v = p.value.trim().toUpperCase();
      if (v === 'VEVENT') cur = {}; else if (v === 'VALARM') inAlarm = true;
    } else if (p.name === 'END') {
      const v = p.value.trim().toUpperCase();
      if (v === 'VALARM') inAlarm = false;
      else if (v === 'VEVENT' && cur) { events.push(cur); cur = null; }
    } else if (cur && !inAlarm) { (cur[p.name] = cur[p.name] || []).push(p); }
  }
  return events;
}
function parseDateProp(prop) {
  if (!prop) return null;
  const m = prop.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { allDay: true, y: +y, m: +mo, d: +d, h: 0, mi: 0, s: 0, tz: null };
  return { allDay: false, y: +y, m: +mo, d: +d, h: +h, mi: +mi, s: +(s || 0), tz: z ? 'UTC' : resolveTz(prop.params.TZID) };
}
function parseDuration(v) {
  const m = (v || '').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000);
}
function parseRRule(v) {
  const r = {};
  for (const part of v.split(';')) { const [k, val] = part.split('='); if (k) r[k.toUpperCase()] = val; }
  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return {
    freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null, until: r.UNTIL || null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean) : [],
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : [],
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : []
  };
}

/* ---------- gentagelser (regnet i lokal vægtid) ---------- */
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const wdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
function* occurrenceDates(start, rule, limitMs) {
  // genererer {y,m,d} i rækkefølge, fra og med startdatoen
  const base = Date.UTC(start.y, start.m - 1, start.d);
  const pastLimit = (y, m, d) => Date.UTC(y, m - 1, d) > limitMs + 2 * DAY;
  const fromUtc = ms => { const d = new Date(ms); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
  if (rule.freq === 'DAILY') {
    for (let k = 0; k < 20000; k++) {
      const o = fromUtc(base + k * rule.interval * DAY);
      if (pastLimit(o.y, o.m, o.d)) return;
      if (rule.bymonth.length && !rule.bymonth.includes(o.m)) continue;
      if (rule.byday.length && !rule.byday.some(b => b.wd === wdayOf(o.y, o.m, o.d))) continue;
      yield o;
    }
  } else if (rule.freq === 'WEEKLY') {
    const wds = rule.byday.length ? [...new Set(rule.byday.map(b => b.wd))] : [wdayOf(start.y, start.m, start.d)];
    const startWd = wdayOf(start.y, start.m, start.d);
    const weekStart = base - ((startWd + 6) % 7) * DAY; // mandag
    for (let k = 0; k < 6000; k++) {
      const ws = weekStart + k * rule.interval * 7 * DAY;
      if (pastLimit(...Object.values(fromUtc(ws)))) return;
      const days = wds.map(wd => ws + ((wd + 6) % 7) * DAY).sort((a, b) => a - b);
      for (const ms of days) { if (ms < base) continue; const o = fromUtc(ms); if (rule.bymonth.length && !rule.bymonth.includes(o.m)) continue; yield o; }
    }
  } else if (rule.freq === 'MONTHLY') {
    for (let k = 0; k < 2400; k++) {
      const mi0 = start.m - 1 + k * rule.interval; const y = start.y + Math.floor(mi0 / 12); const m = (mi0 % 12) + 1;
      if (pastLimit(y, m, 1)) return;
      if (rule.bymonth.length && !rule.bymonth.includes(m)) continue;
      const n = dim(y, m); let days = [];
      if (rule.byday.length) {
        for (const b of rule.byday) {
          const cand = []; for (let d = 1; d <= n; d++) if (wdayOf(y, m, d) === b.wd) cand.push(d);
          if (!b.n) days.push(...cand); else { const pick = b.n > 0 ? cand[b.n - 1] : cand[cand.length + b.n]; if (pick) days.push(pick); }
        }
      } else if (rule.bymonthday.length) {
        days = rule.bymonthday.map(d => d > 0 ? d : n + d + 1).filter(d => d >= 1 && d <= n);
      } else if (start.d <= n) days = [start.d];
      for (const d of [...new Set(days)].sort((a, b) => a - b)) { if (Date.UTC(y, m - 1, d) < base) continue; yield { y, m, d }; }
    }
  } else if (rule.freq === 'YEARLY') {
    for (let k = 0; k < 400; k++) {
      const y = start.y + k * rule.interval;
      if (pastLimit(y, 1, 1)) return;
      const months = rule.bymonth.length ? rule.bymonth : [start.m];
      for (const m of months) {
        const days = rule.bymonthday.length ? rule.bymonthday.map(d => d > 0 ? d : dim(y, m) + d + 1) : [start.d];
        for (const d of days) { if (d < 1 || d > dim(y, m)) continue; if (Date.UTC(y, m - 1, d) < base) continue; yield { y, m, d }; }
      }
    }
  } else { yield { y: start.y, m: start.m, d: start.d }; }
}

/* ---------- fra VEVENT til flade aftaler ---------- */
const first = (ev, name) => (ev[name] && ev[name][0]) || null;
const clip = (s, n) => { const t = (s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function expandFeed(feed, text) {
  const raw = parseEvents(text); const out = [];
  const overrides = new Set();
  const keyFor = (uid, d) => `${uid}|${d.allDay ? dateKey(d.y, d.m, d.d) : wallToUtc(d.y, d.m, d.d, d.h, d.mi, d.s, d.tz)}`;
  for (const ev of raw) { // find overstyrede enkeltforekomster
    const rid = parseDateProp(first(ev, 'RECURRENCE-ID')); const uid = first(ev, 'UID');
    if (rid && uid) overrides.add(keyFor(uid.value, rid));
  }
  const push = (ev, startMs, endMs, allDay, dayStart, dayCount) => {
    const title = clip(unescapeText(first(ev, 'SUMMARY')?.value) || '(uden titel)', 200);
    const location = clip(unescapeText(first(ev, 'LOCATION')?.value), 200);
    const desc = clip(unescapeText(first(ev, 'DESCRIPTION')?.value), 600);
    const uid = first(ev, 'UID')?.value || title;
    if (allDay) {
      for (let i = 0; i < Math.min(dayCount, 60); i++) {
        const ms = dayStart + i * DAY; const d = new Date(ms);
        if (ms < WIN_START - DAY || ms > WIN_END) continue;
        out.push({ id: `${feed.id}:${uid}:${dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())}`, feed: feed.id, title, date: dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), start: '', end: '', allDay: true, location, desc });
      }
    } else {
      if (startMs < WIN_START || startMs > WIN_END) return;
      const s = partsInTz(startMs, TZ); const e = partsInTz(endMs, TZ);
      const sameDay = s.y === e.y && s.m === e.m && s.d === e.d;
      out.push({ id: `${feed.id}:${uid}:${startMs}`, feed: feed.id, title, date: dateKey(s.y, s.m, s.d), start: `${pad(s.h)}:${pad(s.mi)}`, end: sameDay && endMs > startMs ? `${pad(e.h)}:${pad(e.mi)}` : '', allDay: false, location, desc });
    }
  };
  for (const ev of raw) {
    const status = (first(ev, 'STATUS')?.value || '').toUpperCase();
    if (status === 'CANCELLED') continue;
    const start = parseDateProp(first(ev, 'DTSTART')); if (!start) continue;
    const uid = first(ev, 'UID')?.value || '';
    const isOverride = !!first(ev, 'RECURRENCE-ID');
    // varighed
    const endProp = parseDateProp(first(ev, 'DTEND')); const durProp = first(ev, 'DURATION');
    let durMs = 0, durDays = 1;
    if (start.allDay) {
      if (endProp && endProp.allDay) durDays = Math.max(1, Math.round((Date.UTC(endProp.y, endProp.m - 1, endProp.d) - Date.UTC(start.y, start.m - 1, start.d)) / DAY));
      else if (durProp) durDays = Math.max(1, Math.round((parseDuration(durProp.value) || DAY) / DAY));
    } else {
      const sMs = wallToUtc(start.y, start.m, start.d, start.h, start.mi, start.s, start.tz);
      if (endProp && !endProp.allDay) durMs = Math.max(0, wallToUtc(endProp.y, endProp.m, endProp.d, endProp.h, endProp.mi, endProp.s, endProp.tz) - sMs);
      else if (durProp) durMs = Math.max(0, parseDuration(durProp.value) || 0);
    }
    const emit = o => {
      if (start.allDay) push(ev, 0, 0, true, Date.UTC(o.y, o.m - 1, o.d), durDays);
      else { const ms = wallToUtc(o.y, o.m, o.d, start.h, start.mi, start.s, start.tz); push(ev, ms, ms + durMs, false); }
    };
    const rr = first(ev, 'RRULE');
    if (!rr || isOverride) { emit({ y: start.y, m: start.m, d: start.d }); continue; }
    const rule = parseRRule(rr.value);
    let untilMs = Infinity;
    if (rule.until) { const u = parseDateProp({ value: rule.until, params: {} }); if (u) untilMs = u.allDay ? Date.UTC(u.y, u.m - 1, u.d) + DAY - 1 : Date.UTC(u.y, u.m - 1, u.d, u.h, u.mi, u.s); }
    const ex = new Set();
    for (const p of ev.EXDATE || []) for (const v of p.value.split(',')) {
      const d = parseDateProp({ value: v, params: p.params }); if (!d) continue;
      ex.add(d.allDay ? dateKey(d.y, d.m, d.d) : String(wallToUtc(d.y, d.m, d.d, d.h, d.mi, d.s, d.tz)));
    }
    let n = 0;
    for (const o of occurrenceDates(start, rule, WIN_END)) {
      const ms = start.allDay ? Date.UTC(o.y, o.m - 1, o.d) : wallToUtc(o.y, o.m, o.d, start.h, start.mi, start.s, start.tz);
      if (ms > untilMs) break;
      n++; if (rule.count && n > rule.count) break;
      if (ms > WIN_END) break;
      const key = start.allDay ? dateKey(o.y, o.m, o.d) : String(ms);
      if (ex.has(key) || overrides.has(`${uid}|${key}`)) continue;
      emit(o);
      if (out.length > MAX_EVENTS_PER_FEED) break;
    }
  }
  return out;
}

/* ---------- hentning ---------- */
async function fetchIcs(rawUrl) {
  let url = rawUrl.trim().replace(/^webcal:\/\//i, 'https://');
  if (url.startsWith('file:')) return readFile(new URL(url), 'utf8'); // kun til test
  const tries = /^http:\/\//i.test(url) ? [url.replace(/^http:/i, 'https:'), url] : [url];
  let lastErr;
  for (const u of tries) {
    try {
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Familieplanlaegger/1.0 (kalendersync)', Accept: 'text/calendar, text/plain, */*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(t)) throw new Error('Svaret er ikke en iCal-fil');
      return t;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function loadPrevious() {
  const u = process.env.PREVIOUS_URL; if (!u) return null;
  try {
    const res = await fetch(u + '?t=' + NOW, { signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function main() {
  const raw = process.env.CALENDAR_FEEDS;
  let feeds = [];
  if (!raw) console.log('::warning::CALENDAR_FEEDS er ikke sat. Der skrives en tom kalenderfil.');
  else {
    try { feeds = JSON.parse(raw); if (!Array.isArray(feeds)) throw new Error('skal være en liste'); }
    catch (e) { console.error('CALENDAR_FEEDS er ikke gyldig JSON: ' + e.message); process.exit(1); }
    feeds = feeds.filter(f => f && f.id && f.url);
  }
  let previous; const events = []; const meta = [];
  for (const f of feeds) {
    const info = { id: String(f.id), name: f.name || String(f.id), member: f.member || 'all', count: 0, error: null };
    try {
      const text = await fetchIcs(f.url);
      const list = expandFeed({ id: info.id }, text);
      events.push(...list); info.count = list.length;
      console.log(`${info.name}: ${list.length} aftaler`);
    } catch (e) {
      console.log(`::warning::${info.name} kunne ikke hentes (${e.message})`);
      if (previous === undefined) previous = await loadPrevious();
      const old = previous && Array.isArray(previous.events) ? previous.events.filter(x => x.feed === info.id) : [];
      events.push(...old); info.count = old.length;
      info.error = old.length ? `Kunne ikke hente kalenderen (${e.message}). Viser seneste kendte aftaler.` : `Kunne ikke hente kalenderen (${e.message}).`;
    }
    meta.push(info);
  }
  events.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generated: new Date(NOW).toISOString(), timezone: TZ, feeds: meta, events }, null, 0) + '\n');
  console.log(`Skrev ${events.length} aftaler til ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1); });
