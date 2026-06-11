const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "pricing-test";
const STATS_TOKEN = process.env.STATS_TOKEN; // optional: protects /stats/reset

// Sampled body logging: dump at most one full request body per this many
// seconds. Keeps the hot path cheap under load while still giving periodic
// payload samples to eyeball. Set SAMPLE_SECONDS=0 to disable entirely.
const SAMPLE_SECONDS = process.env.SAMPLE_SECONDS !== undefined ? Number(process.env.SAMPLE_SECONDS) : 5;
let lastSampleSec = 0;

app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// In-memory per-second counters, grouped by sender (business phone number).
// On Render's free tier the disk is ephemeral, so a file/DB is no more durable
// than memory here; counters reset if the instance recycles.
// ---------------------------------------------------------------------------
// stats: Map<phone, { webhooks, events, firstSecond, lastSecond,
//                     buckets: Map<second, { w, e }> }>
const stats = new Map();

// ---------------------------------------------------------------------------
// Identity tracking for duplicate diagnosis. Counters above tell us HOW MANY
// events arrived; these tell us WHICH events arrived and how many times each.
//   idIndex:     Map<eventKey, { count, field, phone, firstSec, lastSec, gaps[] }>
//                where eventKey is the event's own id when present, else a
//                content fingerprint. count>1 == the same event was delivered
//                more than once (true duplicate, not just a high tally).
//   fieldCounts: Map<change.field, deliveryCount> — so we can separate pricing
//                events from messages/statuses/etc. The receiver is subscribed
//                to whatever the WABA sends; this is the only way to know what
//                field these actually are.
// ---------------------------------------------------------------------------
const idIndex = new Map();
const fieldCounts = new Map();

function nowSecond() {
  return Math.floor(Date.now() / 1000);
}

// Format an epoch-second as Pacific wall-clock, e.g. "2026-06-09 15:00:00 PDT".
// Uses the America/Los_Angeles zone so it auto-shows PDT/PST per DST.
function fmtPT(sec) {
  const d = new Date(sec * 1000);
  const date = d.toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }); // "2026-06-09 15:00:00"
  const tz = d
    .toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" })
    .split(" ")
    .pop(); // "PDT" / "PST"
  return `${date} ${tz}`;
}

function statsFor(phone) {
  let s = stats.get(phone);
  if (!s) {
    s = { webhooks: 0, events: 0, firstSecond: null, lastSecond: null, buckets: new Map() };
    stats.set(phone, s);
  }
  return s;
}

function record(phone, eventCount) {
  const sec = nowSecond();
  const s = statsFor(phone);
  s.webhooks += 1;
  s.events += eventCount;
  if (s.firstSecond === null) s.firstSecond = sec;
  s.lastSecond = sec;
  const b = s.buckets.get(sec) || { w: 0, e: 0 };
  b.w += 1;
  b.e += eventCount;
  s.buckets.set(sec, b);
}

// Pull the business phone number out of whatever envelope shape arrives:
// the real delivery (entry[].changes[].value.metadata), or Meta's sample
// shapes (value.metadata, sample.value.metadata). Falls back to "unknown".
function extractPhone(body) {
  if (!body || typeof body !== "object") return "unknown";
  const fromValue = (v) => v && v.metadata && v.metadata.display_phone_number;

  if (Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const p = fromValue(change.value);
        if (p) return String(p);
      }
    }
  }
  return String(
    fromValue(body.value) ||
      (body.sample && fromValue(body.sample.value)) ||
      "unknown"
  );
}

// Count events across every shape we might receive in one POST.
function countEvents(body) {
  if (!body || typeof body !== "object") return 0;
  const len = (v) => (v && Array.isArray(v.events) ? v.events.length : 0);
  let total = 0;
  if (Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) total += len(change.value);
    }
  }
  total += len(body.value);
  if (body.sample) total += len(body.sample.value);
  return total;
}

// Stable, order-independent fingerprint of an event object, used as a fallback
// identity when the event carries no id of its own. djb2 over sorted-key JSON,
// so two byte-identical redeliveries collapse to the same key.
function fingerprint(v) {
  let s;
  try {
    s = JSON.stringify(v, Object.keys(v || {}).sort());
  } catch {
    s = String(v);
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The event's own identity if it has one (covers the common id shapes), else a
// content fingerprint prefixed "hash:" so you can tell inferred keys apart.
function eventKey(ev) {
  if (ev && typeof ev === "object") {
    const id =
      ev.id ||
      ev.event_id ||
      ev.eventId ||
      ev.message_id ||
      (ev.message && ev.message.id);
    if (id) return String(id);
  }
  return "hash:" + fingerprint(ev);
}

// Walk every event across all envelope shapes, yielding (event, field, phone).
// field comes from change.field — the webhook field (e.g. pricing, messages).
function forEachEvent(body, cb) {
  if (!body || typeof body !== "object") return;
  const drain = (v, field) => {
    if (v && Array.isArray(v.events)) {
      const phone = (v.metadata && v.metadata.display_phone_number) || null;
      for (const ev of v.events) cb(ev, field || "unknown", phone ? String(phone) : "unknown");
    }
  };
  if (Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) drain(change.value, change.field);
    }
  }
  drain(body.value, body.field);
  if (body.sample) drain(body.sample.value, "sample");
}

// Record one event occurrence. On a repeat key, log a [DUP] line with the gap
// since the previous copy — that cadence is what separates a fixed fan-out
// (small, fixed number of copies) from an open retry loop (copies every N min).
function recordEvent(ev, field, phone) {
  const key = eventKey(ev);
  const sec = nowSecond();
  fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1);
  const rec = idIndex.get(key);
  if (!rec) {
    idIndex.set(key, { key, field, phone, count: 1, firstSec: sec, lastSec: sec, gaps: [] });
    return;
  }
  const gap = sec - rec.lastSec;
  rec.count += 1;
  rec.gaps.push(gap);
  rec.lastSec = sec;
  console.log(
    `[DUP] key=${key} delivery#${rec.count} gapFromPrev=${gap}s totalSpan=${sec - rec.firstSec}s field=${field} phone=${phone}`
  );
}

// ---------------------------------------------------------------------------
// Webhook verification handshake (unchanged behaviour).
// ---------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[VERIFY] Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("[VERIFY] Failed verification. Token mismatch.");
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// Webhook delivery. ACK first, then process: a slow acknowledgement is itself
// a cause of redelivery (Meta retries when it doesn't see a timely 200), so we
// reply immediately and do all tallying afterward. If duplicates persist with
// this in place, they are NOT slow-ACK retries — they are structural.
// ---------------------------------------------------------------------------
app.post("/webhook", (req, res) => {
  const body = req.body;
  res.sendStatus(200);

  try {
    const phone = extractPhone(body);
    const eventCount = countEvents(body) || 1; // count the delivery even if no events parsed
    record(phone, eventCount);
    forEachEvent(body, recordEvent); // per-event identity + field tracking

    // Log a full sample body at most once per SAMPLE_SECONDS window.
    const sec = nowSecond();
    if (SAMPLE_SECONDS > 0 && sec - lastSampleSec >= SAMPLE_SECONDS) {
      lastSampleSec = sec;
      console.log("[SAMPLE]", fmtPT(sec), "phone=", phone, "events=", eventCount);
      console.log(JSON.stringify(body, null, 2));
    }
  } catch (e) {
    console.log("[WEBHOOK] processing error:", e && e.message);
  }
});

app.get("/", (_req, res) => {
  res.send("Pricing Webhook Receiver is running");
});

// ---------------------------------------------------------------------------
// /stats — read the counters. Default: JSON summary per sender.
//   ?buckets=true     include the full per-second breakdown
//   ?format=csv       CSV: phone,second,webhooks,events  (spreadsheet-friendly)
//   ?phone=<number>   limit to one sender
// ---------------------------------------------------------------------------
function summarize(phone, s, includeBuckets) {
  const windowSeconds = s.firstSecond ? s.lastSecond - s.firstSecond + 1 : 0;
  let peakWebhooks = 0;
  let peakEvents = 0;
  for (const { w, e } of s.buckets.values()) {
    if (w > peakWebhooks) peakWebhooks = w;
    if (e > peakEvents) peakEvents = e;
  }
  const summary = {
    phone,
    webhooks: s.webhooks,
    events: s.events,
    firstSecond: s.firstSecond ? fmtPT(s.firstSecond) : null,
    lastSecond: s.lastSecond ? fmtPT(s.lastSecond) : null,
    windowSeconds,
    activeSeconds: s.buckets.size,
    avgWebhooksPerSecond: windowSeconds ? +(s.webhooks / windowSeconds).toFixed(2) : 0,
    avgEventsPerSecond: windowSeconds ? +(s.events / windowSeconds).toFixed(2) : 0,
    peakWebhooksPerSecond: peakWebhooks,
    peakEventsPerSecond: peakEvents,
  };
  if (includeBuckets) {
    summary.buckets = {};
    for (const sec of [...s.buckets.keys()].sort((a, b) => a - b)) {
      const b = s.buckets.get(sec);
      summary.buckets[fmtPT(sec)] = { webhooks: b.w, events: b.e };
    }
  }
  return summary;
}

app.get("/stats", (req, res) => {
  const filter = req.query.phone ? String(req.query.phone) : null;
  const entries = [...stats.entries()].filter(([p]) => !filter || p === filter);

  if (req.query.format === "csv") {
    res.type("text/csv");
    let csv = "phone,second,webhooks,events\n";
    for (const [phone, s] of entries) {
      for (const sec of [...s.buckets.keys()].sort((a, b) => a - b)) {
        const b = s.buckets.get(sec);
        csv += `${phone},${fmtPT(sec)},${b.w},${b.e}\n`;
      }
    }
    return res.send(csv);
  }

  const includeBuckets = req.query.buckets === "true";
  const senders = entries.map(([phone, s]) => summarize(phone, s, includeBuckets));
  res.json({
    totals: {
      webhooks: senders.reduce((a, s) => a + s.webhooks, 0),
      events: senders.reduce((a, s) => a + s.events, 0),
      senders: senders.length,
    },
    senders,
  });
});

// ---------------------------------------------------------------------------
// /stats/events — the duplicate-vs-distinct view. Answers "are we receiving N
// genuine events, or N/2 events each delivered twice?" and "what field are
// they?". This is the artifact for the delivery-path owner.
//   ?field=<name>   limit to one webhook field (e.g. pricing)
//   ?phone=<number> limit to one sender
//   ?all=true       list every key, not just the duplicated ones
// ---------------------------------------------------------------------------
app.get("/stats/events", (req, res) => {
  const fieldFilter = req.query.field ? String(req.query.field) : null;
  const phoneFilter = req.query.phone ? String(req.query.phone) : null;
  const listAll = req.query.all === "true";

  let totalDeliveries = 0;
  let uniqueEvents = 0;
  let duplicatedEvents = 0;
  const rows = [];
  for (const rec of idIndex.values()) {
    if (fieldFilter && rec.field !== fieldFilter) continue;
    if (phoneFilter && rec.phone !== phoneFilter) continue;
    uniqueEvents += 1;
    totalDeliveries += rec.count;
    if (rec.count > 1) duplicatedEvents += 1;
    if (listAll || rec.count > 1) {
      rows.push({
        key: rec.key,
        field: rec.field,
        phone: rec.phone,
        deliveries: rec.count,
        firstSeen: fmtPT(rec.firstSec),
        lastSeen: fmtPT(rec.lastSec),
        spanSeconds: rec.lastSec - rec.firstSec,
        gapsSeconds: rec.gaps, // seconds between consecutive copies
      });
    }
  }
  rows.sort((a, b) => b.deliveries - a.deliveries || b.spanSeconds - a.spanSeconds);

  const byField = {};
  for (const [f, c] of fieldCounts.entries()) byField[f] = c;

  res.json({
    totals: {
      totalDeliveries,
      uniqueEvents,
      duplicatedEvents,
      // fraction of deliveries that were redundant copies; 0.5 == clean 2x
      duplicateRate: totalDeliveries ? +((totalDeliveries - uniqueEvents) / totalDeliveries).toFixed(3) : 0,
    },
    byField,
    rows,
  });
});

// ---------------------------------------------------------------------------
// Control endpoints. Guarded by STATS_TOKEN if it is set.
// ---------------------------------------------------------------------------
function authorized(req) {
  return !STATS_TOKEN || req.query.token === STATS_TOKEN;
}

app.post("/stats/reset", (req, res) => {
  if (!authorized(req)) return res.sendStatus(403);
  stats.clear();
  idIndex.clear();
  fieldCounts.clear();
  console.log("[STATS] reset");
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Body-parser failures still count the delivery (as "unknown") and return 200,
// so a malformed payload never silently drops from the received tally.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed" && req.method === "POST" && req.path === "/webhook") {
    record("unknown", 1);
    console.log("[WEBHOOK] unparseable body counted as unknown");
    return res.sendStatus(200);
  }
  return next(err);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (sampleSeconds=${SAMPLE_SECONDS})`);
});
