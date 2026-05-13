const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "pricing-test";

app.use(express.json());

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

app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK] Received at", new Date().toISOString());
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.get("/", (_req, res) => {
  res.send("Pricing Webhook Receiver is running");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
