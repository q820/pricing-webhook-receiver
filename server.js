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
// than memory here. The per-second [RATE] log line below is the durable backup:
// Render's log stream survives instance recycling, so the histogram can be
// rebuilt from logs even if this process restarts mid-test.
// ---------------------------------------------------------------------------
// stats: Map<phone, { webhooks, events, firstSecond, lastSecond,
//                     buckets: Map<second, { w, e }> }>
const stats = new Map();

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
// Webhook delivery: count it, then reply 200 as fast as possible.
// ---------------------------------------------------------------------------
app.post("/webhook", (req, res) => {
  const phone = extractPhone(req.body);
  const eventCount = countEvents(req.body) || 1; // count the delivery even if no events parsed
  record(phone, eventCount);

  // Log a full sample body at most once per SAMPLE_SECONDS window.
  const sec = nowSecond();
  if (SAMPLE_SECONDS > 0 && sec - lastSampleSec >= SAMPLE_SECONDS) {
    lastSampleSec = sec;
    console.log("[SAMPLE]", fmtPT(sec), "phone=", phone, "events=", eventCount);
    console.log(JSON.stringify(req.body, null, 2));
  }
  res.sendStatus(200);
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
// Control endpoints. Guarded by STATS_TOKEN if it is set.
// ---------------------------------------------------------------------------
function authorized(req) {
  return !STATS_TOKEN || req.query.token === STATS_TOKEN;
}

app.post("/stats/reset", (req, res) => {
  if (!authorized(req)) return res.sendStatus(403);
  stats.clear();
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

// ---------------------------------------------------------------------------
// Durable backup: one log line per active second per sender. Render retains
// logs across instance recycling, so the histogram survives a restart.
// ---------------------------------------------------------------------------
setInterval(() => {
  const sec = nowSecond() - 1; // the second that just completed
  for (const [phone, s] of stats.entries()) {
    const b = s.buckets.get(sec);
    if (b) {
      console.log(`[RATE] ${fmtPT(sec)} phone=${phone} webhooks=${b.w} events=${b.e}`);
    }
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (sampleSeconds=${SAMPLE_SECONDS})`);
});
