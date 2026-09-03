// index.mjs — Spurs Night calendar sync
// Node.js 24 · no npm dependencies
// Eventbrite + Google Calendar → merged .ics and month-grid .html in S3

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ssmClient = new SSMClient({});
const s3Client  = new S3Client({});

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
  const getParameter = (Name) => ssmClient.send(new GetParameterCommand({ Name, WithDecryption: true }));
  const [eventbriteTokenParam, googleKeyParam] = await Promise.all([
    getParameter(PARAM_EB_TOKEN), getParameter(PARAM_GOOGLE_KEY),
  ]);
  cache = { eventbriteToken: eventbriteTokenParam.Parameter.Value, googleKey: googleKeyParam.Parameter.Value };
  return cache;
}

// ---------------------------------------------------------------- helpers
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true,
});
const localDate = (date) => dateFormatter.format(date);
const shortTime = (date) =>
  timeFormatter.format(date).replace(/\s/g, "").replace(/\./g, "").toUpperCase();
const utcStamp  = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const escapeIcsText = (value) => String(value)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;")
  .replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function fold(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts = []; let current = "";
  for (const character of line) {
    if (Buffer.byteLength(current + character, "utf8") > 73) { parts.push(current); current = ""; }
    current += character;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

// Google Calendar descriptions may hold a ticket link (Hart House, etc.) either as
// a bare URL or as an <a href> that Google's editor inserts. Pull it out and clean
// the remaining text so the link renders as a button, not as raw text.
function extractLink(description) {
  if (!description) return { url: "", text: "" };
  const anchor = description.match(/href=["'](https?:\/\/[^"']+)["']/i);
  const bare   = description.match(/https?:\/\/[^\s<>"']+/i);
  const url    = (anchor && anchor[1]) || (bare && bare[0]) || "";

  let text = description.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ");
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

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Calendar ${response.status}: ${await response.text()}`);
  const { items = [] } = await response.json();

  return items
    .filter((event) => event.status !== "cancelled" && event.start)
    .map((event) => {
      const { url, text } = extractLink(event.description || "");
      return {
        uid: `gc-${event.id}@spursnight`,
        title: event.summary || "SPURS NIGHT",
        description: text,
        location: event.location || "",
        place: (event.location || "").split(",")[0].trim(),
        url,                                   // external ticket link, if one was pasted
        allDay: !event.start.dateTime,
        start: new Date(event.start.dateTime || `${event.start.date}T12:00:00Z`),
        end:   new Date(event.end?.dateTime  || `${event.end?.date || event.start.date}T12:00:00Z`),
        source: "google",
      };
    });
}

async function fetchEventbriteWithStatus(token, status) {
  const events = []; let continuationToken = null;
  do {
    const url = new URL(`https://www.eventbriteapi.com/v3/organizations/${EB_ORG_ID}/events/`);
    url.searchParams.set("status", status);
    url.searchParams.set("order_by", "start_asc");
    url.searchParams.set("expand", "venue,ticket_availability");
    if (continuationToken) url.searchParams.set("continuation", continuationToken);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Eventbrite ${response.status}: ${await response.text()}`);
    const data = await response.json();

    for (const event of data.events || []) {
      events.push({
        uid: `eb-${event.id}@spursnight`,
        title: event.name?.text || "SPURS NIGHT",
        description: event.description?.text || "",
        location: event.venue?.address?.localized_address_display || event.venue?.name || "",
        place: event.venue?.name || "",
        url: event.url || "",
        soldOut: event.ticket_availability?.is_sold_out === true,
        waitlist: event.ticket_availability?.waitlist_available === true,
        allDay: false,
        start: new Date(event.start.utc),
        end:   new Date(event.end.utc),
        source: "eventbrite",
      });
    }
    continuationToken = data.pagination?.has_more_items ? data.pagination.continuation : null;
  } while (continuationToken);
  return events;
}

// Past nights should stay on the calendar as history. Not every account accepts a
// multi-value status filter, so fall back to live-only rather than failing the run.
async function fetchEventbrite(token) {
  try {
    return await fetchEventbriteWithStatus(token, "live,started,ended,completed");
  } catch (error) {
    console.warn("multi-status filter rejected, falling back to live:", error.message);
    return await fetchEventbriteWithStatus(token, "live");
  }
}

// ------------- merge: Eventbrite supersedes the manual entry it corresponds to,
// ------------- but multiple events on one date are all kept
function merge(googleEvents, eventbriteEvents) {
  const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byDate = new Map();                    // date -> array of events

  for (const googleEvent of googleEvents) {
    const date = localDate(googleEvent.start);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(googleEvent);
  }

  for (const eventbriteEvent of eventbriteEvents) {
    const date = localDate(eventbriteEvent.start);
    const sameDay = byDate.get(date) || [];

    // which manual entry does this Eventbrite event replace?
    // prefer a title match; otherwise assume a lone manual entry is the same thing
    let matchIndex = sameDay.findIndex((googleEvent) => normalize(googleEvent.title) === normalize(eventbriteEvent.title));
    // "SPURS NIGHT" (manual) vs "SPURS NIGHT - BAILA SAFICA w/ AVRIL" (Eventbrite)
    if (matchIndex === -1) matchIndex = sameDay.findIndex((googleEvent) => {
      const normalizedGoogleTitle = normalize(googleEvent.title), normalizedEventbriteTitle = normalize(eventbriteEvent.title);
      return !googleEvent.url && normalizedGoogleTitle && normalizedEventbriteTitle &&
        (normalizedGoogleTitle.startsWith(normalizedEventbriteTitle) || normalizedEventbriteTitle.startsWith(normalizedGoogleTitle));
    });
    // a lone untitled-match manual entry is assumed to be the same night --
    // unless it has its own ticket link, which makes it a real separate event
    if (matchIndex === -1 && sameDay.length === 1 && !sameDay[0].url) matchIndex = 0;

    if (matchIndex !== -1) {
      const matchedEvent = sameDay[matchIndex];
      if (matchedEvent.description && !eventbriteEvent.description.includes(matchedEvent.description)) {
        eventbriteEvent.description = eventbriteEvent.description
          ? `${eventbriteEvent.description}\n\n${matchedEvent.description}`
          : matchedEvent.description;
      }
      sameDay.splice(matchIndex, 1);                    // superseded
    }
    sameDay.push(eventbriteEvent);
    byDate.set(date, sameDay);
  }

  return [...byDate.values()].flat().sort((eventA, eventB) => eventA.start - eventB.start);
}

// ---------------------------------------------------------------- iCal output
function buildIcs(events) {
  const now = utcStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//Spurs Night//Calendar Sync//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(CALENDAR_NAME)}`,
    `X-WR-TIMEZONE:${TIMEZONE}`,
  ];
  for (const event of events) {
    lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${now}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${localDate(event.start).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART:${utcStamp(event.start)}`, `DTEND:${utcStamp(event.end)}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.location)    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.url)         lines.push(`URL:${event.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------- month-grid output
function buildHtml(events) {
  const payload = events.map((event) => ({
    date: localDate(event.start),
    title: event.title,
    time: event.allDay ? "" : shortTime(event.start),
    range: event.allDay ? "" : `${timeFormatter.format(event.start)} – ${timeFormatter.format(event.end)}`,
    location: event.location,
    place: event.place || (event.location || "").split(",")[0].trim(),
    description: (event.description || "").replace(/\s+/g, " ").trim().slice(0, 260),
    url: event.url,
    soldOut: !!event.soldOut,
    waitlist: !!event.waitlist,
  }));

  const today = localDate(new Date());
  // always open on the current month; `today` is recomputed every run, so the
  // calendar rolls over to the new month on its own
  const [startYear, startMonth] = today.split("-").map(Number);

  const data = JSON.stringify({ events: payload, year: startYear, month: startMonth - 1, today })
    .replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${CALENDAR_NAME}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Syncopate:wght@400;700&display=swap">
<style>
  *{box-sizing:border-box}
  html,body{height:100%;-webkit-text-size-adjust:100%}
  body{margin:0 auto;max-width:1040px;display:flex;flex-direction:column;
    background:transparent;color:#2a1a12;
    font-family:"Inter Tight","Helvetica Neue",Helvetica,Arial,sans-serif}

  .hd{display:flex;align-items:center;justify-content:space-between;padding:0 0 14px;gap:4px}
  .hd h2{margin:0;flex:1 1 auto;text-align:center;
    font-family:"Syncopate","Helvetica Neue",Helvetica,Arial,sans-serif;
    font-size:clamp(15px,2.1vw,23px);font-weight:700;letter-spacing:.01em;
    text-transform:uppercase;color:#2a1108}
  .nav{background:none;border:0;cursor:pointer;font-size:22px;line-height:1;color:#3a2a20;
    opacity:.7;min-width:44px;min-height:44px;display:flex;align-items:center;
    justify-content:center;-webkit-tap-highlight-color:transparent}
  .nav:hover,.nav:active{opacity:1}

  .dow{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:4px}
  .dow span{text-align:center;font-size:11px;letter-spacing:.14em;color:#8d8177;
    text-transform:uppercase;font-weight:500;padding:3px 0}

  .wrap{position:relative;flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
  .grid{flex:1 1 auto;display:grid;grid-template-columns:repeat(7,1fr);gap:4px;
    grid-auto-rows:1fr}
  .cell{background:#edeae3;border:0;padding:9px 10px;display:flex;
    flex-direction:column;min-height:0;overflow:hidden}
  .cell.blank{background:#f1eee8}
  .num{text-align:right;font-size:12.5px;color:#9a8e83;line-height:1;flex:0 0 auto}
  .cell.today{box-shadow:inset 0 0 0 1px rgba(42,17,8,.4)}
  .cell.today .num{color:#2a1108;font-weight:700}
  .cell.has{cursor:pointer}
  .ev{display:block;text-decoration:none;color:#2a1108;margin-top:9px;
    font-size:12px;line-height:1.26;letter-spacing:.01em}
  .ev + .ev{margin-top:11px}
  .ev .tm{display:block;font-weight:700;margin-bottom:1px}
  .ev .ti{display:block;font-weight:400;text-transform:uppercase;color:#3a1d10}
  .ev .lo{display:block;font-weight:400;text-transform:uppercase;color:#7a6d60;
    font-size:10.5px;margin-top:2px}
  .ev:hover .ti{text-decoration:underline}
  .cell.has{cursor:pointer}

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
    .dow span{font-size:7px;letter-spacing:0;padding:3px 1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .grid{gap:2px;grid-auto-rows:minmax(38px,1fr)}
    .cell{padding:0;align-items:center;justify-content:center}
    .num{text-align:center;width:100%;font-size:12.5px}
    .cell.has{background:#ded5c8}
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
  <div class="dow"><span>Sunday</span><span>Monday</span><span>Tuesday</span><span>Wednesday</span>
    <span>Thursday</span><span>Friday</span><span>Saturday</span></div>
  <div class="wrap">
    <div class="grid" id="grid"></div>
    <div class="backdrop" id="backdrop"></div>
    <div class="pop" id="pop"></div>
  </div>
<script>
const calendarData = ${data};
const MONTHS = ["January","February","March","April","May","June","July",
  "August","September","October","November","December"];
const WEEKDAYS_LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const byDay = {};
for (const event of calendarData.events) (byDay[event.date] = byDay[event.date] || []).push(event);

let year = calendarData.year, month = calendarData.month, hideTimeout = null;
const padNumber = (number) => String(number).padStart(2, "0");
const escapeHtml = (value) => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;")
  .replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const grid = document.getElementById("grid");
const wrap = document.querySelector(".wrap");
const popover = document.getElementById("pop");
const backdrop = document.getElementById("backdrop");
const isMobile = () => window.matchMedia("(max-width:620px)").matches;

function renderGrid() {
  document.getElementById("title").textContent = MONTHS[month] + " " + year;
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const totalCells = 42;                       // always 6 rows: height never jumps
  let htmlString = "";

  for (let cellIndex = 0; cellIndex < totalCells; cellIndex++) {
    const day = cellIndex - firstWeekday + 1;
    if (day < 1 || day > daysInMonth) { htmlString += '<div class="cell blank"></div>'; continue; }
    const dateKey = year + "-" + padNumber(month + 1) + "-" + padNumber(day);
    const eventsForDay = byDay[dateKey] || [];
    const cellClassName = "cell" + (dateKey === calendarData.today ? " today" : "") + (eventsForDay.length ? " has" : "");
    htmlString += '<div class="' + cellClassName + '" data-date="' + dateKey + '"><div class="num">' + day + "</div>";
    for (const event of eventsForDay) {
      const eventInnerHtml = (event.time ? '<span class="tm">' + escapeHtml(event.time) + "</span>" : "") +
        '<span class="ti">' + escapeHtml(event.title) + "</span>" +
        (event.place ? '<span class="lo">' + escapeHtml(event.place) + "</span>" : "");
      const eventClassName = "ev" + (event.soldOut ? " sold" : "") + (event.url ? "" : " soon");
      htmlString += event.url
        ? '<a class="' + eventClassName + '" href="' + escapeHtml(event.url) +
          '" target="_blank" rel="noopener">' + eventInnerHtml + "</a>"
        : '<span class="' + eventClassName + '">' + eventInnerHtml + "</span>";
    }
    htmlString += "</div>";
  }
  grid.innerHTML = htmlString;
}

function popoverBody(events) {
  return '<button class="x" id="popx" aria-label="Close">&times;</button>' +
    events.map((event) => {
      const dateParts = event.date.split("-").map(Number);
      const weekdayName = WEEKDAYS_LONG[new Date(dateParts[0], dateParts[1] - 1, dateParts[2]).getDay()];
      const buildTicketLink = (label) => '<a class="btn" href="' + escapeHtml(event.url) +
        '" target="_blank" rel="noopener">' + label + "</a>";
      const callToAction = event.date < calendarData.today
        ? '<span class="pending">This event has passed</span>'
        : !event.url
          ? '<span class="pending">Tickets not on sale yet</span>'
          : event.soldOut
            ? '<p class="when" style="margin:10px 0 4px">Sold out</p>' +
              buildTicketLink(event.waitlist ? "Join the waitlist" : "View on Eventbrite")
            : buildTicketLink("Get tickets");
      return "<h3>" + escapeHtml(event.title) + "</h3>" +
        '<p class="when">' + weekdayName + ", " + MONTHS[dateParts[1] - 1] + " " + dateParts[2] +
        (event.range ? " &middot; " + escapeHtml(event.range) : "") + "</p>" +
        (event.location    ? "<p>" + escapeHtml(event.location)    + "</p>" : "") +
        (event.description ? "<p>" + escapeHtml(event.description) + "</p>" : "") + callToAction;
    }).join('<hr style="border:0;border-top:1px solid rgba(0,0,0,.1);margin:13px 0">');
}

function hidePopover() {
  popover.style.display = "none";
  backdrop.style.display = "none";
}

function showPopover(cell) {
  const eventsForDay = byDay[cell.dataset.date] || [];
  if (!eventsForDay.length) return;
  clearTimeout(hideTimeout);
  popover.innerHTML = popoverBody(eventsForDay);
  popover.style.display = "block";
  const closeButton = document.getElementById("popx");
  if (closeButton) closeButton.onclick = hidePopover;

  backdrop.style.display = isMobile() ? "block" : "none";
  const popoverWidth = popover.offsetWidth, popoverHeight = popover.offsetHeight;
  let left = isMobile()
    ? (wrap.clientWidth - popoverWidth) / 2
    : cell.offsetLeft + cell.offsetWidth / 2 - popoverWidth / 2;
  left = Math.max(0, Math.min(left, wrap.clientWidth - popoverWidth));
  // anchor to the chip, not the bottom of the (now much taller) square cell
  const firstEventChip = cell.querySelector(".ev");
  const anchorTop    = firstEventChip ? firstEventChip.offsetTop : cell.offsetTop;
  const anchorHeight = firstEventChip ? firstEventChip.offsetHeight : cell.offsetHeight;
  let top = anchorTop + anchorHeight + 3;
  if (top + popoverHeight > wrap.clientHeight) top = anchorTop - popoverHeight - 3;
  if (top < 0) top = 0;
  popover.style.left = left + "px";
  popover.style.top  = top + "px";
}

grid.addEventListener("mouseover", (mouseEvent) => {
  if (isMobile()) return;
  const cell = mouseEvent.target.closest(".cell.has");
  if (cell) { showPopover(cell); return; }
  // moved onto a day with no event -- close, but leave just enough time to
  // cross the few pixels between the chip and the popover itself
  hideTimeout = setTimeout(hidePopover, 90);
});
grid.addEventListener("mouseleave", () => {
  if (!isMobile()) hideTimeout = setTimeout(hidePopover, 90);
});
popover.addEventListener("mouseenter", () => clearTimeout(hideTimeout));
popover.addEventListener("mouseleave", () => { if (!isMobile()) hidePopover(); });
grid.addEventListener("click", (clickEvent) => {
  if (!isMobile()) return;
  const cell = clickEvent.target.closest(".cell.has");
  if (cell) showPopover(cell);
});
backdrop.addEventListener("click", hidePopover);
document.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Escape") hidePopover(); });

document.getElementById("prev").onclick = () => {
  if (--month < 0) { month = 11; year--; } hidePopover(); renderGrid();
};
document.getElementById("next").onclick = () => {
  if (++month > 11) { month = 0; year++; } hidePopover(); renderGrid();
};
renderGrid();
<\/script>
</body></html>`;
}

// ---------------------------------------------------------------- handler
export const handler = async () => {
  const { eventbriteToken, googleKey } = await getSecrets();

  const [googleEvents, eventbriteEvents] = await Promise.all([
    fetchGoogle(googleKey),
    fetchEventbrite(eventbriteToken),
  ]);

  const merged = merge(googleEvents, eventbriteEvents);

  const put = (Key, Body, ContentType) => s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET, Key, Body, ContentType,
    CacheControl: "public, max-age=300",
  }));

  await Promise.all([
    put(S3_KEY,   buildIcs(merged),  "text/calendar; charset=utf-8"),
    put(HTML_KEY, buildHtml(merged), "text/html; charset=utf-8"),
  ]);

  console.log(`Wrote ${merged.length} events ` +
    `(${eventbriteEvents.length} from Eventbrite, ${googleEvents.length} manual)`);
  return { ok: true, count: merged.length };
};
