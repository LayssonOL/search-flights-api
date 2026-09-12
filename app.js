/**
 * search_flights webhook
 * ------------------------------------------------------------
 * This is the endpoint ElevenLabs' "search_flights" server tool
 * calls mid-conversation. It takes simple flat params extracted
 * by the LLM, calls Duffel's offer_requests endpoint, and returns
 * a SHORT, voice-friendly summary — never the raw Duffel payload.
 *
 * Run with: node search-flights-webhook.js
 * Requires: npm install express node-fetch
 * Env var:  DUFFEL_API_KEY  (your duffel_test_... key)
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DUFFEL_URL = process.env.DUFFEL_URL;

app.post("/tools/search-flights", async (req, res) => {
  try {
    const {
      origin,
      destination,
      departure_date,
      return_date, // optional — omit for one-way
      passengers = 1,
      cabin_class = "economy",
    } = req.body;

    if (!origin || !destination || !departure_date) {
      return res.status(400).json({
        error: "origin, destination, and departure_date are required",
      });
    }

    // Build Duffel's slice structure (one-way = 1 slice, round-trip = 2)
    const slices = [{ origin, destination, departure_date }];
    if (return_date) {
      slices.push({
        origin: destination,
        destination: origin,
        departure_date: return_date,
      });
    }

    const duffelBody = {
      data: {
        cabin_class,
        passengers: Array.from({ length: passengers }, () => ({
          type: "adult",
        })),
        slices,
      },
    };

    const duffelRes = await fetch(`${DUFFEL_URL}?return_offers=true`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Duffel-Version": "v2",
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
      },
      body: JSON.stringify(duffelBody),
    });

    if (!duffelRes.ok) {
      const errText = await duffelRes.text();
      console.error("Duffel error:", errText);
      return res.status(502).json({
        error: "Flight search failed. Try different dates or airports.",
      });
    }

    const duffelData = await duffelRes.json();
    const offers = duffelData.data?.offers || [];

    // Trim to the top 3 cheapest offers, and only the fields the agent
    // actually needs to speak out loud.
    const summarized = offers
      .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))
      .slice(0, 3)
      .map((offer) => {
        const firstSlice = offer.slices[0];
        const segments = firstSlice.segments;
        const stops = segments.length - 1;

        return {
          offer_id: offer.id,
          airline: segments[0].marketing_carrier.name,
          price: `${offer.total_amount} ${offer.total_currency}`,
          departure_time: segments[0].departing_at,
          arrival_time: segments[segments.length - 1].arriving_at,
          stops,
          duration_minutes: Math.round(
            (new Date(segments[segments.length - 1].arriving_at) -
              new Date(segments[0].departing_at)) /
              60000
          ),
        };
      });

    if (summarized.length === 0) {
      return res.json({
        found: false,
        message: "No flights found for those dates and airports.",
      });
    }

    return res.json({ found: true, options: summarized });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected error searching flights." });
  }
});

async function redisSet(key, value) {
  const res = await fetch(`${UPSTASH_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(value),
  });
  return res.ok;
}

async function redisSadd(setKey, member) {
  await fetch(`${UPSTASH_URL}/sadd/${setKey}/${member}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
}

app.post("/tools/watch-price", async (req, res) => {
  try {
    const {
      origin,
      destination,
      departure_date,
      return_date, // optional
      cabin_class = "economy",
      target_price, // optional — number, in USD
      email,
    } = req.body;

    if (!origin || !destination || !departure_date || !email) {
      return res.status(400).json({
        error: "origin, destination, departure_date, and email are required",
      });
    }

    const watchId = crypto.randomUUID();
    const record = {
      id: watchId,
      origin,
      destination,
      departure_date,
      return_date: return_date || null,
      cabin_class,
      target_price: target_price || null,
      email,
      last_seen_price: null,
      created_at: new Date().toISOString(),
    };

    await redisSet(`watch:${watchId}`, record);
    await redisSadd("watch:index", watchId);

    return res.json({
      registered: true,
      watch_id: watchId,
      message: target_price
        ? `I'll email you at ${email} if ${origin} to ${destination} drops below $${target_price}.`
        : `I'll email you at ${email} if the price for ${origin} to ${destination} drops.`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not register price watch." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`search_flights webhook running on :${PORT}`));
