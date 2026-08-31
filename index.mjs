// index.mjs — Spurs Night calendar sync
// Node.js 24 · no npm dependencies
// Eventbrite + Google Calendar → merged .ics and month-grid .html in S3

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ssm = new SSMClient({});
const s3  = new S3Client({});

const {
  CALENDAR_ID, S3_BUCKET, EB_ORG_ID,
  S3_KEY           = "spurs.ics",
  HTML_KEY         = "calendar.html",
  PARAM_EB_TOKEN   = "/spurs/eventbrite-token",
  PARAM_GOOGLE_KEY = "/spurs/google-api-key",
  TIMEZONE         = "America/Toronto",
  CALENDAR_NAME    = "SPURS Events",
} = process.env;

// ---------------------------------------------------------------- secrets
let cache = null;
async function getSecrets() {
  if (cache) return cache;
  const get = (Name) => ssm.send(new GetParameterCommand({ Name, WithDecryption: true }));
  const [eb, gk] = await Promise.all([get(PARAM_EB_TOKEN), get(PARAM_GOOGLE_KEY)]);
  cache = { ebToken: eb.Parameter.Value, googleKey: gk.Parameter.Value };
  return cache;
}

// ---------------------------------------------------------------- helpers
const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true,
});
const localDate = (d) => dateFmt.format(d);
const utcStamp  = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const esc = (s) => String(s)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;")
  .replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function fold(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts = []; let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > 73) { parts.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.join("\r\n ");
}

// Google Calendar descriptions may hold a ticket link (Hart House, etc.) either as
// a bare URL or as an <a href> that Google's editor inserts. Pull it out and clean
// the remaining text so the link renders as a button, not as raw text.
function extractLink(desc) {
  if (!desc) return { url: "", text: "" };
  const anchor = desc.match(/href=["'](https?:\/\/[^"']+)["']/i);
  const bare   = desc.match(/https?:\/\/[^\s<>"']+/i);
  const url    = (anchor && anchor[1]) || (bare && bare[0]) || "";

  let text = desc.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ");
  if (url) text = text.split(url).join(" ");
  text = text
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();

  return { url, text };
}

// ---------------------------------------------------------------- sources
async function fetchGoogle(googleKey) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`
  );
  url.searchParams.set("key", googleKey);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  // keep six months of history so the back arrow shows past nights, not empty grids
  url.searchParams.set("timeMin", new Date(Date.now() - 182 * 864e5).toISOString());
  url.searchParams.set("maxResults", "500");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${await res.text()}`);
  const { items = [] } = await res.json();

  return items
    .filter((e) => e.status !== "cancelled" && e.start)
    .map((e) => {
      const { url, text } = extractLink(e.description || "");
      return {
        uid: `gc-${e.id}@spursnight`,
        title: e.summary || "SPURS NIGHT",
        description: text,
        location: e.location || "",
        url,                                   // external ticket link, if one was pasted
        allDay: !e.start.dateTime,
        start: new Date(e.start.dateTime || `${e.start.date}T12:00:00Z`),
        end:   new Date(e.end?.dateTime  || `${e.end?.date || e.start.date}T12:00:00Z`),
        source: "google",
      };
    });
}

async function fetchEventbrite(token) {
  const out = []; let cont = null;
  do {
    const url = new URL(`https://www.eventbriteapi.com/v3/organizations/${EB_ORG_ID}/events/`);
    url.searchParams.set("status", "live");
    url.searchParams.set("order_by", "start_asc");
    url.searchParams.set("expand", "venue");
    if (cont) url.searchParams.set("continuation", cont);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Eventbrite ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (const e of data.events || []) {
      out.push({
        uid: `eb-${e.id}@spursnight`,
        title: e.name?.text || "SPURS NIGHT",
        description: e.description?.text || "",
        location: e.venue?.address?.localized_address_display || e.venue?.name || "",
        url: e.url || "",
        allDay: false,
        start: new Date(e.start.utc),
        end:   new Date(e.end.utc),
        source: "eventbrite",
      });
    }
    cont = data.pagination?.has_more_items ? data.pagination.continuation : null;
  } while (cont);
  return out;
}

// ------------- merge: Eventbrite supersedes the manual entry it corresponds to,
// ------------- but multiple events on one date are all kept
function merge(googleEvents, ebEvents) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byDate = new Map();                    // date -> array of events

  for (const g of googleEvents) {
    const d = localDate(g.start);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(g);
  }

  for (const e of ebEvents) {
    const d = localDate(e.start);
    const sameDay = byDate.get(d) || [];

    // which manual entry does this Eventbrite event replace?
    // prefer a title match; otherwise assume a lone manual entry is the same thing
    let i = sameDay.findIndex((g) => norm(g.title) === norm(e.title));
    // "SPURS NIGHT" (manual) vs "SPURS NIGHT - BAILA SAFICA w/ AVRIL" (Eventbrite)
    if (i === -1) i = sameDay.findIndex((g) => {
      const a = norm(g.title), b = norm(e.title);
      return !g.url && a && b && (a.startsWith(b) || b.startsWith(a));
    });
    // a lone untitled-match manual entry is assumed to be the same night --
    // unless it has its own ticket link, which makes it a real separate event
    if (i === -1 && sameDay.length === 1 && !sameDay[0].url) i = 0;

    if (i !== -1) {
      const m = sameDay[i];
      if (m.description && !e.description.includes(m.description)) {
        e.description = e.description
          ? `${e.description}\n\n${m.description}`
          : m.description;
      }
      sameDay.splice(i, 1);                    // superseded
    }
    sameDay.push(e);
    byDate.set(d, sameDay);
  }

  return [...byDate.values()].flat().sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- iCal output
function buildIcs(events) {
  const now = utcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//Spurs Night//Calendar Sync//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(CALENDAR_NAME)}`,
    `X-WR-TIMEZONE:${TIMEZONE}`,
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${now}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${localDate(e.start).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location)    lines.push(`LOCATION:${esc(e.location)}`);
    if (e.url)         lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------- month-grid output
function buildHtml(events) {
  const payload = events.map((e) => ({
    d: localDate(e.start),
    t: e.title,
    time: e.allDay ? "" : `${timeFmt.format(e.start)} – ${timeFmt.format(e.end)}`,
    loc: e.location,
    desc: (e.description || "").replace(/\s+/g, " ").trim().slice(0, 260),
    url: e.url,
  }));

  const today = localDate(new Date());
  // open on the month of the next upcoming event; fall back to the current month
  const next  = payload.find((p) => p.d >= today);
  const [sy, sm] = (next ? next.d : today).split("-").map(Number);

  const data = JSON.stringify({ events: payload, y: sy, m: sm - 1, today })
    .replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${CALENDAR_NAME}</title>
<style>
  *{box-sizing:border-box}
  html,body{-webkit-text-size-adjust:100%}
  body{margin:0;background:transparent;color:#2a1a12;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}

  .hd{display:flex;align-items:center;justify-content:space-between;padding:0 0 14px;gap:4px}
  .hd h2{margin:0;flex:1 1 auto;text-align:center;font-size:clamp(18px,3vw,30px);
    font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#2a1108}
  .nav{background:none;border:0;cursor:pointer;font-size:22px;line-height:1;color:#3a2a20;
    opacity:.7;min-width:44px;min-height:44px;display:flex;align-items:center;
    justify-content:center;-webkit-tap-highlight-color:transparent}
  .nav:hover,.nav:active{opacity:1}

  .dow{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:4px}
  .dow span{text-align:center;font-size:11.5px;letter-spacing:.12em;color:#8d8177;
    text-transform:uppercase;padding:3px 0}

  .wrap{position:relative}
  .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;grid-auto-rows:88px}
  .cell{background:transparent;border:1px solid rgba(42,17,8,.13);padding:7px 8px;
    display:flex;flex-direction:column;min-height:0;overflow:hidden}
  .cell.blank{border-color:rgba(42,17,8,.05)}
  .num{text-align:right;font-size:12.5px;color:#9a8e83;line-height:1;flex:0 0 auto}
  .cell.today{border-color:rgba(42,17,8,.45)}
  .cell.today .num{color:#2a1108;font-weight:700}
  .cell.has{cursor:pointer}
  .ev{margin-top:6px;display:block;text-decoration:none;background:#2a1108;color:#fff;
    border-radius:5px;padding:5px 7px;font-size:11px;font-weight:700;line-height:1.25;
    letter-spacing:.02em;overflow:hidden}
  .ev.soon{background:transparent;color:#6d6156;border:1px dashed rgba(42,17,8,.35)}
  .ev .tm{display:block;font-weight:400;opacity:.85;font-size:10px;margin-top:1px;
    letter-spacing:0}
  .cell.has:hover .ev{background:#4a2a18;color:#fff;border-color:transparent}

  /* popover (desktop) / modal (mobile) */
  .backdrop{display:none;position:absolute;inset:0;background:rgba(20,10,5,.32);z-index:8}
  .pop{display:none;position:absolute;z-index:9;width:270px;padding:15px 17px;
    border-radius:10px;background:#fbf8f3;border:1px solid rgba(42,17,8,.16);
    box-shadow:0 10px 28px rgba(42,17,8,.20)}
  .pop h3{margin:0 0 4px;font-size:14px;letter-spacing:.03em;text-transform:uppercase;
    font-weight:800;color:#2a1108;padding-right:18px}
  .pop .when{margin:0 0 9px;font-size:12.5px;font-weight:600;color:#3a2a20}
  .pop p{margin:0 0 8px;font-size:12px;color:#6d6156;line-height:1.5}
  .pop .btn{display:inline-block;margin-top:4px;padding:9px 16px;border-radius:999px;
    background:#2a1108;color:#fff;text-decoration:none;font-size:12.5px;font-weight:700}
  .pop .btn:hover{background:#4a2a18}
  .pop .pending{display:inline-block;margin-top:4px;font-size:12px;color:#8d8177;
    font-style:italic}
  .pop .x{display:none;position:absolute;top:8px;right:10px;background:none;border:0;
    font-size:20px;line-height:1;color:#8d8177;cursor:pointer;padding:4px 6px}

  @media (max-width:620px){
    .hd{padding:0 0 8px}
    .dow{gap:2px}
    .dow span{font-size:9.5px;letter-spacing:.03em}
    .grid{gap:2px;grid-auto-rows:42px}
    .cell{padding:0;align-items:center;justify-content:center}
    .num{text-align:center;width:100%;font-size:12.5px}
    .cell.has{background:#e6dfd4;border-color:rgba(42,17,8,.2)}
    .cell.has .num{color:#2a1108;font-weight:700}
    .ev{display:none}
    .pop{width:min(92%,300px);padding:14px 16px}
    .pop .x{display:block}
  }
</style></head>
<body>
  <div class="hd">
    <button class="nav" id="prev" aria-label="Previous month">&#8249;</button>
    <h2 id="title"></h2>
    <button class="nav" id="next" aria-label="Next month">&#8250;</button>
  </div>
  <div class="dow"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
    <span>Th</span><span>Fr</span><span>Sa</span></div>
  <div class="wrap">
    <div class="grid" id="grid"></div>
    <div class="backdrop" id="backdrop"></div>
    <div class="pop" id="pop"></div>
  </div>
<script>
const D = ${data};
const MONTHS = ["January","February","March","April","May","June","July",
  "August","September","October","November","December"];
const LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const byDay = {};
for (const e of D.events) (byDay[e.d] = byDay[e.d] || []).push(e);

let y = D.y, m = D.m, hideT = null;
const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
  .replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const grid = document.getElementById("grid");
const wrap = document.querySelector(".wrap");
const pop = document.getElementById("pop");
const backdrop = document.getElementById("backdrop");
const isMobile = () => window.matchMedia("(max-width:620px)").matches;

function renderGrid() {
  document.getElementById("title").textContent = MONTHS[m] + " " + y;
  const first = new Date(y, m, 1).getDay();
  const days  = new Date(y, m + 1, 0).getDate();
  const cells = Math.ceil((first + days) / 7) * 7;
  let html = "";

  for (let i = 0; i < cells; i++) {
    const day = i - first + 1;
    if (day < 1 || day > days) { html += '<div class="cell blank"></div>'; continue; }
    const key = y + "-" + pad(m + 1) + "-" + pad(day);
    const evs = byDay[key] || [];
    const cls = "cell" + (key === D.today ? " today" : "") + (evs.length ? " has" : "");
    html += '<div class="' + cls + '" data-d="' + key + '"><div class="num">' + day + "</div>";
    for (const e of evs) {
      const inner = esc(e.t) +
        (e.time ? '<span class="tm">' + esc(e.time) + "</span>" : "");
      html += e.url
        ? '<a class="ev" href="' + esc(e.url) + '" target="_blank" rel="noopener">' +
          inner + "</a>"
        : '<span class="ev soon">' + inner + "</span>";
    }
    html += "</div>";
  }
  grid.innerHTML = html;
}

function popBody(evs) {
  return '<button class="x" id="popx" aria-label="Close">&times;</button>' +
    evs.map((e) => {
      const p = e.d.split("-").map(Number);
      const wd = LONG[new Date(p[0], p[1] - 1, p[2]).getDay()];
      const cta = e.url
        ? '<a class="btn" href="' + esc(e.url) +
          '" target="_blank" rel="noopener">Get tickets</a>'
        : '<span class="pending">Tickets not on sale yet</span>';
      return "<h3>" + esc(e.t) + "</h3>" +
        '<p class="when">' + wd + ", " + MONTHS[p[1] - 1] + " " + p[2] +
        (e.time ? " &middot; " + esc(e.time) : "") + "</p>" +
        (e.loc  ? "<p>" + esc(e.loc)  + "</p>" : "") +
        (e.desc ? "<p>" + esc(e.desc) + "</p>" : "") + cta;
    }).join('<hr style="border:0;border-top:1px solid rgba(0,0,0,.1);margin:13px 0">');
}

function hidePop() {
  pop.style.display = "none";
  backdrop.style.display = "none";
}

function showPop(cell) {
  const evs = byDay[cell.dataset.d] || [];
  if (!evs.length) return;
  clearTimeout(hideT);
  pop.innerHTML = popBody(evs);
  pop.style.display = "block";
  const x = document.getElementById("popx");
  if (x) x.onclick = hidePop;

  backdrop.style.display = isMobile() ? "block" : "none";
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = isMobile()
    ? (wrap.clientWidth - pw) / 2
    : cell.offsetLeft + cell.offsetWidth / 2 - pw / 2;
  left = Math.max(0, Math.min(left, wrap.clientWidth - pw));
  let top = cell.offsetTop + cell.offsetHeight + 6;
  if (top + ph > wrap.clientHeight) top = cell.offsetTop - ph - 6;
  if (top < 0) top = 0;
  pop.style.left = left + "px";
  pop.style.top  = top + "px";
}

grid.addEventListener("mouseover", (ev) => {
  if (isMobile()) return;
  const cell = ev.target.closest(".cell.has");
  if (cell) showPop(cell);
});
grid.addEventListener("mouseleave", () => {
  if (!isMobile()) hideT = setTimeout(hidePop, 220);
});
pop.addEventListener("mouseenter", () => clearTimeout(hideT));
pop.addEventListener("mouseleave", () => {
  if (!isMobile()) hideT = setTimeout(hidePop, 180);
});
grid.addEventListener("click", (ev) => {
  if (!isMobile()) return;
  const cell = ev.target.closest(".cell.has");
  if (cell) showPop(cell);
});
backdrop.addEventListener("click", hidePop);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hidePop(); });

document.getElementById("prev").onclick = () => {
  if (--m < 0) { m = 11; y--; } hidePop(); renderGrid();
};
document.getElementById("next").onclick = () => {
  if (++m > 11) { m = 0; y++; } hidePop(); renderGrid();
};
renderGrid();
<\/script>
</body></html>`;
}

// ---------------------------------------------------------------- handler
export const handler = async () => {
  const { ebToken, googleKey } = await getSecrets();

  const [googleEvents, ebEvents] = await Promise.all([
    fetchGoogle(googleKey),
    fetchEventbrite(ebToken),
  ]);

  const merged = merge(googleEvents, ebEvents);

  const put = (Key, Body, ContentType) => s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET, Key, Body, ContentType,
    CacheControl: "public, max-age=300",
  }));

  await Promise.all([
    put(S3_KEY,   buildIcs(merged),  "text/calendar; charset=utf-8"),
    put(HTML_KEY, buildHtml(merged), "text/html; charset=utf-8"),
  ]);

  console.log(`Wrote ${merged.length} events ` +
    `(${ebEvents.length} from Eventbrite, ${googleEvents.length} manual)`);
  return { ok: true, count: merged.length };
};
