import express from "express";
import OpenAI from "openai";
import { Pool } from "pg";
import { Webhook } from "svix";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifyToken } from "@clerk/backend";
import { createStore } from "./data/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: false });

const app = express();
const port = process.env.PORT || 4000;
const MOCK_AI = String(process.env.MOCK_AI || "").trim().toLowerCase() === "true";

const allowedOrigins = String(
  process.env.CORS_ORIGINS ||
    "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

let pool = null;
if (process.env.DATABASE_URL) {
  const connectionString = process.env.DATABASE_URL;
  const needsSsl =
    /supabase\.co/i.test(connectionString) ||
    /sslmode=require/i.test(connectionString) ||
    String(process.env.PGSSLMODE || "").toLowerCase() === "require" ||
    String(process.env.DATABASE_SSL || "").toLowerCase() === "true";
  pool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}
const store = pool ? createStore({ pool }) : null;

let openaiClient = null;
function getOpenAIClient() {
  const rawKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!rawKey || rawKey === "sk-proj_your_openai_key_here") return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: rawKey,
    });
  }
  return openaiClient;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isMockAiEnabled() {
  return MOCK_AI;
}

let cachedInviteLogoDataUri = null;

function normalizeInviteLogoUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || "").toLowerCase();
    const pathParts = String(parsed.pathname || "")
      .split("/")
      .filter(Boolean);

    // Unsplash page URLs are HTML pages; convert them to direct downloadable image URLs.
    if ((host === "unsplash.com" || host.endsWith(".unsplash.com")) && pathParts.length >= 2) {
      const contentType = pathParts[0];
      const contentId = pathParts[1];
      if ((contentType === "illustrations" || contentType === "photos") && contentId) {
        return `https://unsplash.com/${contentType}/${contentId}/download?force=true&w=500`;
      }
    }

    return value;
  } catch (_) {
    return value;
  }
}

function getInviteLogoDataUri() {
  if (cachedInviteLogoDataUri) return cachedInviteLogoDataUri;
  try {
    const logoPath = path.resolve(__dirname, "../images/image.png");
    const bytes = fs.readFileSync(logoPath);
    const ext = path.extname(logoPath).toLowerCase();
    const mime =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".svg"
            ? "image/svg+xml"
            : "image/png";
    cachedInviteLogoDataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    return cachedInviteLogoDataUri;
  } catch (_) {
    return "";
  }
}

function resolveInviteLogoUrl(appBaseUrl) {
  const explicitLogo = normalizeInviteLogoUrl(process.env.EMAIL_LOGO_URL);
  if (explicitLogo) return explicitLogo;

  const base = String(appBaseUrl || "").trim().replace(/\/+$/, "");
  const isLocalBase =
    /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(base);

  if (!isLocalBase && base) return normalizeInviteLogoUrl(`${base}/images/image.png`);

  const inlineLogo = getInviteLogoDataUri();
  if (inlineLogo) return inlineLogo;

  return base ? normalizeInviteLogoUrl(`${base}/images/image.png`) : "";
}

function buildCollaboratorInviteEmailHtml(options = {}) {
  const brandName = String(options.brandName || "Yatrify").trim() || "Yatrify";
  const logoUrl = String(options.logoUrl || "").trim();
  const tripTitle = String(options.tripTitle || "your travel plan").trim() || "your travel plan";
  const joinUrl = String(options.joinUrl || "").trim();
  const homeUrl = String(options.homeUrl || "/").trim() || "/";
  const year = Number(options.year) || new Date().getFullYear();

  const safeBrand = escapeHtml(brandName);
  const safeLogo = escapeHtml(logoUrl);
  const safeTripTitle = escapeHtml(tripTitle);
  const safeJoinUrl = escapeHtml(joinUrl);
  const safeHomeUrl = escapeHtml(homeUrl);

  return (
    `<!doctype html>` +
    `<html><body style="margin:0;padding:14px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">` +
    `<table role="presentation" width="440" style="max-width:440px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;">` +
    `<tr><td align="left" style="padding-bottom:8px;">` +
    (safeLogo
      ? `<img src="${safeLogo}" alt="" style="display:block;width:120px;max-width:100%;height:auto;" />`
      : "") +
    (!safeLogo
      ? `<div style="font-size:18px;font-weight:700;color:#2563eb;line-height:1.2;">${safeBrand}</div>`
      : "") +
    `</td></tr>` +

    `<tr><td align="center" style="font-size:13px;line-height:1.55;font-weight:600;padding:2px 6px 0;">` +
    `You've been invited to join <span style="color:#0f172a;">${safeTripTitle}</span> Travel Plan on ${safeBrand}` +
    `</td></tr>` +

    `<tr><td height="10"></td></tr>` +
    `<tr><td align="center">` +
    `<a href="${safeJoinUrl}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:9px 16px;border-radius:6px;">Join the Plan</a>` +
    `</td></tr>` +

    `<tr><td height="10"></td></tr>` +
    `<tr><td align="center" style="font-size:13px;line-height:1.55;color:#111827;">` +
    `If you received this invite in error, you may safely ignore this.` +
    `</td></tr>` +

    `<tr><td height="6"></td></tr>` +
    `<tr><td align="center" style="font-size:13px;line-height:1.55;">` +
    `<a href="${safeHomeUrl}" style="color:#2563eb;font-weight:600;">Get Started</a> with ${safeBrand}.` +
    `</td></tr>` +

    `<tr><td height="14"></td></tr>` +
    `<tr><td style="border-top:1px solid #e2e8f0;padding-top:10px;font-size:11px;color:#64748b;">` +
    `&copy; ${year} ${safeBrand}. All rights reserved.` +
    `</td></tr>` +
    `</table></td></tr></table>` +
    `</body></html>`
  );
}

async function sendCollaboratorInviteEmail(options = {}) {
  const brevoApiKey = String(process.env.BREVO_API_KEY || "").trim();
  if (!brevoApiKey) {
    return { sent: false, skipped: true, reason: "BREVO_API_KEY not configured" };
  }

  const toEmail = String(options.toEmail || "").trim().toLowerCase();
  const planId = String(options.planId || "").trim();
  const inviteId = String(options.inviteId || "").trim();
  if (!toEmail || !planId) {
    return { sent: false, skipped: true, reason: "Missing toEmail or planId" };
  }

  const fromEmail = String(process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || "").trim();
  const fromName = String(process.env.BREVO_FROM_NAME || "Yatrify").trim();
  const appBaseUrl = String(
    process.env.APP_BASE_URL ||
      options.appBaseUrl ||
      "http://localhost:5500"
  ).replace(/\/+$/, "");
  if (!fromEmail) {
    return { sent: false, skipped: true, reason: "BREVO_FROM_EMAIL not configured" };
  }

  const destination = String(options.destination || "your travel plan").trim();
  const generatedPlanUrl =
    `${appBaseUrl}/generated-plan.html?planId=${encodeURIComponent(planId)}` +
    (inviteId ? `&inviteId=${encodeURIComponent(inviteId)}` : "");
  const homeUrl = `${appBaseUrl}/`;
  const logoUrl = resolveInviteLogoUrl(appBaseUrl);
  const inviterName = String(options.inviterName || "A Yatrify traveler").trim();
  const inviterEmail = String(options.inviterEmail || "").trim();
  const inviterLabel = inviterEmail ? `${inviterName} (${inviterEmail})` : inviterName;

  const subject = `${inviterName} invited you to collaborate on Yatrify`;
  const text = [
    `You were invited to collaborate on a travel plan for ${destination}.`,
    "",
    `Invited by: ${inviterLabel}`,
    `Join the plan: ${generatedPlanUrl}`,
    `Get started: ${homeUrl}`,
  ].join("\n");
  const html = buildCollaboratorInviteEmailHtml({
    brandName: "Yatrify",
    logoUrl,
    tripTitle: destination,
    joinUrl: generatedPlanUrl,
    homeUrl,
  });
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": brevoApiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      to: [{ email: toEmail }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });

  const raw = await response.text().catch(() => "");
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(`Brevo send failed: ${response.status} ${raw}`);
  }

  return {
    sent: true,
    id: payload && (payload.messageId || payload.id) ? String(payload.messageId || payload.id) : null,
  };
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (allowedOrigins[0]) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigins[0]);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    setCors(req, res);
  }
  next();
});

app.options("/api/*", (req, res) => {
  setCors(req, res);
  return res.sendStatus(204);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/public-config", (_req, res) => {
  return res.json({
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${port}`,
  });
});

function parseJsonFromText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const cleaned = text
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizePayloadArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function getAuthTokenFromRequest(req) {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

async function requireAuth(req, res, next) {
  const token = getAuthTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY || "",
    });
    const claims = result && result.payload ? result.payload : result;
    const clerkUserId = claims && claims.sub ? String(claims.sub) : "";
    if (!clerkUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.auth = {
      clerkUserId,
      email: claims && (claims.email || claims.primary_email || claims.email_address) ? String(claims.email || claims.primary_email || claims.email_address) : "",
      firstName: claims && (claims.first_name || claims.given_name) ? String(claims.first_name || claims.given_name) : "",
      lastName: claims && (claims.last_name || claims.family_name) ? String(claims.last_name || claims.family_name) : "",
    };
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireDb(_req, res, next) {
  if (!store) {
    return res.status(500).json({ error: "DATABASE_URL not set" });
  }
  return next();
}

function toIsoDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function diffDaysInclusive(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.floor((end - start) / oneDay) + 1);
}

async function getAuthedUser(req) {
  if (!req.auth || !req.auth.clerkUserId) return null;
  const existing = await store.getUserByClerkId(req.auth.clerkUserId);
  if (existing) return existing;
  return store.ensureUser(req.auth.clerkUserId, {
    email: req.auth.email || null,
    firstName: req.auth.firstName || null,
    lastName: req.auth.lastName || null,
  });
}

function buildFeasibilityPrompt(payload) {
  const data = normalizeGeminiTripPayload(payload || {});
  const themes = normalizePayloadArray(data.themes);
  const accommodation = normalizePayloadArray(data.accommodation);
  const food = normalizePayloadArray(data.food);
  const transport = normalizePayloadArray(data.transport);
  const landmarkHints = getDestinationLandmarkHints(data.destination);

  return [
    "Return only valid JSON.",
    "Provide feasibility analysis for this trip request:",
    `Start city: ${data.startCity || "Not specified"}`,
    `Destination: ${data.destination || "Not specified"}`,
    `Start date: ${data.startDate || "Not specified"}`,
    `End date: ${data.endDate || "Not specified"}`,
    `Trip length: ${data.totalDays} days`,
    `Themes: ${themes.length ? themes.join(", ") : "None"}`,
    `Pace: ${data.pace || "Not specified"}`,
    `Weather: ${data.weather || "Not specified"}`,
    `Accommodation: ${accommodation.length ? accommodation.join(", ") : "None"}`,
    `Food: ${food.length ? food.join(", ") : "None"}`,
    `Transport: ${transport.length ? transport.join(", ") : "None"}`,
    `Currency: ${data.currency || "INR"}`,
    `User budget: ${data.budget ? `${data.currency || "INR"} ${data.budget}` : "Not provided"}`,
    `Passengers: ${data.passengers || "Not specified"}`,
    `Preferences: ${data.preferences || "None"}`,
    `Destination landmark hints: ${landmarkHints.length ? landmarkHints.join(", ") : "None provided; infer destination-specific activities and landmarks."}`,
    "",
    "Response schema:",
    "{",
    '  "currency": "INR",',
    '  "suggestedBudgetMin": 100000,',
    '  "suggestedBudgetMax": 180000,',
    '  "budgetReasoning": "2-4 sentences",',
    '  "missingExperiences": ["item 1", "item 2"],',
    '  "alternativeDestinations": ["item 1", "item 2"]',
    "}",
    "",
    "Rules:",
    "- Calculate the suggested budget from the whole trip context, not just the entered budget value.",
    "- Use trip length, destination, passenger count, accommodation style, transport choices, food preferences, pace, weather, and special requests to estimate the range.",
    "- Treat the user budget as a comparison point only. Do not simply repeat it unless the full trip context truly supports it.",
    "- If the entered budget looks too low or too high for the trip, say so clearly in budgetReasoning and adjust the suggested range accordingly.",
    "- Make the reasoning specific and practical, explaining the biggest cost drivers.",
    "- missingExperiences must be destination-specific experiences, landmarks, areas, food, or activities for the requested destination only. Do not suggest experiences from other cities.",
    "- alternativeDestinations must be nearby cities, same-country cities, or realistic nearby places. Infer these on your own from the destination context; do not rely on hardcoded city examples.",
    "- Do not include unrelated cities from other countries unless the prompt explicitly asks for international alternatives.",
    "- Return 3 to 5 items for missingExperiences and 3 to 5 items for alternativeDestinations, each written as a short actionable suggestion.",
  ].join("\n");
}

function normalizeFeasibilityResult(rawResult, payload) {
  if (!rawResult || typeof rawResult !== "object") return null;

  const fallbackCurrency = String((payload && payload.currency) || "INR").toUpperCase();

  let currency = String(
    rawResult.currency ||
    rawResult.budgetCurrency ||
    fallbackCurrency
  ).toUpperCase();

  let minValue = Number(rawResult.suggestedBudgetMin);
  if (!Number.isFinite(minValue)) minValue = Number(rawResult.budgetMin);
  if (!Number.isFinite(minValue)) minValue = 0;

  let maxValue = Number(rawResult.suggestedBudgetMax);
  if (!Number.isFinite(maxValue)) maxValue = Number(rawResult.budgetMax);
  if (!Number.isFinite(maxValue)) maxValue = minValue;

  minValue = Math.max(0, Math.round(minValue));
  maxValue = Math.max(minValue, Math.round(maxValue));

  let budgetReasoning = String(rawResult.budgetReasoning || rawResult.reasoning || "").trim();
  if (!budgetReasoning) {
    budgetReasoning = "Generated from Gemini analysis using your current trip inputs.";
  }

  const missingExperiences = normalizePayloadArray(
    rawResult.missingExperiences || rawResult.experiencesYouAreMissing || rawResult.missing || []
  );

  const alternativeDestinations = normalizePayloadArray(
    rawResult.alternativeDestinations || rawResult.alternatives || []
  );

  return {
    currency,
    suggestedBudgetMin: minValue,
    suggestedBudgetMax: maxValue,
    budgetReasoning,
    missingExperiences,
    alternativeDestinations,
  };
}

function normalizeGeminiTripPayload(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const derivedDays = diffDaysInclusive(input.startDate, input.endDate);
  const explicitDays = Number(input.totalDays);
  return {
    startCity: String(input.startCity || "").trim(),
    destination: String(input.destination || "").trim(),
    startDate: String(input.startDate || "").trim(),
    endDate: String(input.endDate || "").trim(),
    themes: normalizePayloadArray(input.themes),
    pace: String(input.pace || "").trim(),
    weather: String(input.weather || "").trim(),
    accommodation: normalizePayloadArray(input.accommodation),
    food: normalizePayloadArray(input.food),
    transport: normalizePayloadArray(input.transport),
    currency: String(input.currency || "INR").trim().toUpperCase(),
    budget: String(input.budget || "").trim(),
    passengers: String(input.passengers || "").trim(),
    preferences: String(input.preferences || "").trim(),
    totalDays: Math.max(1, Number.isFinite(explicitDays) && explicitDays > 0 ? explicitDays : derivedDays || 1),
    dateRangeText: String(input.dateRangeText || "").trim(),
  };
}

function buildMockFeasibilityResult(payload) {
  const trip = normalizeGeminiTripPayload(payload || {});
  const themes = normalizePayloadArray(trip.themes);
  const accommodation = normalizePayloadArray(trip.accommodation);
  const food = normalizePayloadArray(trip.food);
  const transport = normalizePayloadArray(trip.transport);
  const passengersText = String(trip.passengers || "1 adult").toLowerCase();
  const passengerCount = Math.max(1, Number(String(passengersText).match(/\d+/)?.[0] || 1));
  const basePerDay = 4200;
  const themeLift = themes.length * 350;
  const accommodationLift = accommodation.some((item) => /luxury|5|premium|resort|villa|suite/i.test(item))
    ? 4200
    : accommodation.some((item) => /mid|boutique|comfort|standard/i.test(item))
      ? 2100
      : 1200;
  const foodLift = food.some((item) => /fine|dine|premium|fancy/i.test(item))
    ? 1800
    : food.some((item) => /local|street|simple|budget/i.test(item))
      ? 700
      : 1200;
  const transportLift = transport.some((item) => /flight|air/i.test(item))
    ? 2200
    : transport.some((item) => /cab|taxi|private/i.test(item))
      ? 1100
      : 800;
  const paceLift = /slow|relaxed|leisure/i.test(trip.pace) ? 1400 : /fast|packed|busy/i.test(trip.pace) ? -300 : 0;
  const weatherLift = /winter|rain|monsoon|snow|cold/i.test(trip.weather) ? 650 : 0;
  const passengerLift = Math.max(0, passengerCount - 1) * 1600;
  const tripLift = Math.max(0, trip.totalDays - 1) * 1800;
  const userBudget = Number(trip.budget || 0);
  const estimatedMin = Math.max(15000, Math.round(basePerDay + themeLift + accommodationLift + foodLift + transportLift + paceLift + weatherLift + passengerLift + tripLift));
  const estimatedMax = Math.max(estimatedMin + 5000, Math.round(estimatedMin * 1.28));
  const budgetReasoning = [
    `Mock analysis for ${trip.totalDays} day${trip.totalDays > 1 ? "s" : ""} based on destination, pace, passenger count, accommodation, food, and transport choices.`,
    userBudget > 0
      ? `Your entered budget of ${trip.currency} ${userBudget.toLocaleString("en-IN")} is being used only as a comparison point.`
      : "No entered budget was provided, so the estimate is based entirely on the trip details.",
    `The range moves upward for premium stay or flight-heavy trips and stays lower for shorter, simpler plans.`,
  ].join(" ");

  const destinationLabel = trip.destination || "your destination";
  const landmarkHints = getDestinationLandmarkHints(trip.destination);
  const nearbyHints = landmarkHints.length
    ? landmarkHints.slice(0, 3).map((item) => `${item} day`)
    : [
        `A deeper local-food trail in ${destinationLabel}`,
        `A heritage walk around ${destinationLabel}`,
        `A scenic viewpoint or market experience in ${destinationLabel}`,
      ];

  return {
    currency: trip.currency || "INR",
    suggestedBudgetMin: estimatedMin,
    suggestedBudgetMax: estimatedMax,
    budgetReasoning,
    missingExperiences: dedupeStrings([
      landmarkHints[0] ? `Spend more time at ${landmarkHints[0]}` : `Explore the main landmark scene in ${destinationLabel}`,
      landmarkHints[1] ? `Add ${landmarkHints[1]}` : `Try a local food street or market in ${destinationLabel}`,
      landmarkHints[2] ? `Include ${landmarkHints[2]}` : `Include a cultural walk or viewpoint in ${destinationLabel}`,
    ]).slice(0, 5),
    alternativeDestinations: dedupeStrings([
      nearbyHints[0],
      nearbyHints[1],
      nearbyHints[2],
    ]).slice(0, 5),
  };
}

function buildMockTripHighlights(trip) {
  const city = trip.destination || "your destination";
  const origin = trip.startCity || "your origin city";
  const themes = normalizePayloadArray(trip.themes);
  return {
    tripTitle: `${city} Trip Plan`,
    travelWindow: trip.dateRangeText || `${trip.startDate || "Start date"} to ${trip.endDate || "End date"}`,
    originCity: origin,
    hotelPreference: trip.accommodation.length ? trip.accommodation.join(", ") : "Balanced stay",
    foodPreference: trip.food.length ? trip.food.join(", ") : "Mixed local and easy dining",
    interestChips: dedupeStrings(
      themes.length
        ? themes
        : ["Sightseeing", "Food", "Culture"]
    ).slice(0, 4),
    summary: `A practical mock itinerary for ${city} with day-by-day planning, budget guidance, and packing details tailored to the trip form.`,
  };
}

function buildMockItineraryDay(trip, dayNumber, landmarkHints) {
  const city = trip.destination || "the destination";
  const theme = landmarkHints[(dayNumber - 1) % Math.max(1, landmarkHints.length)] || `${city} exploration`;
  return {
    dayNumber,
    title: `${theme} - Day ${dayNumber}`,
    dateLabel: `Day ${dayNumber}`,
    schedule: {
      morning: `${theme} morning start with a relaxed breakfast and a first stop near ${city}.`,
      afternoon: `Move into a nearby area for lunch, sightseeing, and a practical transfer window around ${city}.`,
      evening: `Visit a different landmark or market in ${city} for sunset, photos, or a guided stroll.`,
      night: `End with a calm dinner and return to your stay after a light evening in ${city}.`,
    },
    foodRecommendations: [
      `${city} local breakfast`,
      `${city} lunch stop`,
      `Dinner near ${city}`,
    ],
    stayOptions: [
      `Stay in central ${city}`,
      `Stay near a transit hub in ${city}`,
    ],
    optionalActivities: [
      `Short heritage walk around ${theme}`,
      `Local cafe or market stop in ${city}`,
    ],
    quickBookings: [
      `Reserve entry or transport for ${theme}`,
      `Book a local guide if needed`,
    ],
  };
}

function buildMockPackingChecklist(trip) {
  const city = trip.destination || "the destination";
  return dedupeStrings([
    "Passport or ID",
    "Travel tickets and hotel confirmations",
    "Wallet, cards, and some cash",
    "Phone charger and cable",
    "Power bank",
    "Basic medicines and prescriptions",
    "Toiletries kit",
    "Weather-appropriate clothing",
    "Comfortable walking shoes",
    "Light jacket or layering piece",
    `Any destination-specific adapter for ${city}`,
    `Sunglasses, sunscreen, and water bottle for ${city}`,
  ]);
}

function buildMockGeminiSections(payload) {
  const trip = normalizeGeminiTripPayload(payload || {});
  const landmarkHints = getDestinationLandmarkHints(trip.destination);
  const itinerary = [];
  for (let day = 1; day <= trip.totalDays; day += 1) {
    itinerary.push(buildMockItineraryDay(trip, day, landmarkHints));
  }

  return {
    parsed: {
      tripHighlights: buildMockTripHighlights(trip),
      weatherAnalysis: {
        expectedConditions: `Mock weather outlook for ${trip.destination || "the destination"} based on your selected weather preference.`,
        bestTimeToVisit: trip.weather || "Best time depends on the selected travel window.",
      },
      itinerary,
      budgetRange: {
        currency: trip.currency || "INR",
        essentials: [
          { id: "accommodation", label: "Accommodation", pct: 33, min: 25000, max: 40000 },
          { id: "food", label: "Food", pct: 15, min: 9000, max: 18000 },
          { id: "insurance", label: "Insurance", pct: 1, min: 800, max: 2500 },
          { id: "contingency", label: "Contingency", pct: 7, min: 4500, max: 10000 },
        ],
        activities: [
          { id: "activitiesIncluded", label: "Activities Included", pct: 7, min: 6000, max: 12000 },
          { id: "activitiesOptional", label: "Activities Optional", pct: 8, min: 7000, max: 15000 },
        ],
        transport: [
          { id: "travelStartReturn", label: "Travel Start/Return", pct: 22, min: 12000, max: 30000 },
          { id: "intercityTransport", label: "Intercity Transport", pct: 6, min: 3000, max: 9000 },
          { id: "intracityTransport", label: "Intracity Transport", pct: 4, min: 2500, max: 7000 },
          { id: "visa", label: "Visa", pct: 0, min: 0, max: 0 },
        ],
      },
      packingChecklist: buildMockPackingChecklist(trip),
    },
    meta: {
      source: "mock",
      model: "mock-ai",
      usedGoogleSearch: false,
      elapsedMs: 0,
      quality: {
        ok: true,
        issues: [],
        metrics: {
          itineraryDays: trip.totalDays,
          slotCoverageCount: trip.totalDays * 4,
          genericPhraseHits: 0,
          landmarkHintMatches: landmarkHints.length,
          packingItems: 12,
        },
      },
    },
  };
}

const DESTINATION_LANDMARK_HINTS = [
  {
    keys: ["manali", "himachal"],
    places: [
      "Hadimba Devi Temple",
      "Solang Valley",
      "Rohtang Pass",
      "Old Manali",
      "Vashisht Temple and Hot Springs",
      "Jogini Waterfall",
      "Mall Road Manali",
      "Naggar Castle",
    ],
  },
  {
    keys: ["goa"],
    places: [
      "Baga Beach",
      "Calangute Beach",
      "Anjuna Beach",
      "Dudhsagar Falls",
      "Fort Aguada",
      "Basilica of Bom Jesus",
      "Fontainhas",
      "Chapora Fort",
    ],
  },
  {
    keys: ["paris"],
    places: [
      "Eiffel Tower",
      "Louvre Museum",
      "Notre-Dame Cathedral",
      "Montmartre",
      "Arc de Triomphe",
      "Champs-Elysees",
      "Seine River Cruise",
      "Musee d'Orsay",
    ],
  },
  {
    keys: ["tokyo"],
    places: [
      "Senso-ji Temple",
      "Tokyo Skytree",
      "Shibuya Crossing",
      "Meiji Jingu",
      "Ueno Park",
      "Tsukiji Outer Market",
      "Asakusa",
      "Shinjuku Gyoen",
    ],
  },
  {
    keys: ["jaipur"],
    places: [
      "Amber Fort",
      "Hawa Mahal",
      "City Palace Jaipur",
      "Jantar Mantar",
      "Nahargarh Fort",
      "Jal Mahal",
      "Albert Hall Museum",
      "Bapu Bazaar",
    ],
  },
  {
    keys: ["agra"],
    places: [
      "Taj Mahal",
      "Agra Fort",
      "Mehtab Bagh",
      "Itmad-ud-Daulah",
      "Fatehpur Sikri",
      "Kinari Bazaar",
    ],
  },
  {
    keys: ["mumbai", "bombay"],
    places: [
      "Gateway of India",
      "Marine Drive",
      "Colaba Causeway",
      "Chhatrapati Shivaji Maharaj Terminus",
      "Elephanta Caves",
      "Bandra-Worli Sea Link",
      "Juhu Beach",
      "Sanjay Gandhi National Park",
    ],
  },
  {
    keys: ["delhi", "new delhi"],
    places: [
      "India Gate",
      "Red Fort",
      "Qutub Minar",
      "Humayun's Tomb",
      "Lotus Temple",
      "Akshardham",
      "Chandni Chowk",
      "Lodhi Garden",
    ],
  },
  {
    keys: ["rishikesh"],
    places: [
      "Laxman Jhula",
      "Ram Jhula",
      "Triveni Ghat",
      "The Beatles Ashram",
      "Neer Garh Waterfall",
      "Shivpuri rafting point",
    ],
  },
  {
    keys: ["amritsar"],
    places: [
      "Golden Temple",
      "Jallianwala Bagh",
      "Wagah Border",
      "Partition Museum",
      "Hall Bazaar",
      "Durgiana Temple",
    ],
  },
  {
    keys: ["dubai"],
    places: [
      "Burj Khalifa",
      "Dubai Mall",
      "Palm Jumeirah",
      "Dubai Marina",
      "Al Fahidi Historical District",
      "Dubai Creek",
      "Jumeirah Beach",
      "Museum of the Future",
    ],
  },
  {
    keys: ["london"],
    places: [
      "Tower Bridge",
      "Buckingham Palace",
      "British Museum",
      "Westminster Abbey",
      "Big Ben",
      "Covent Garden",
      "Camden Market",
      "London Eye",
    ],
  },
  {
    keys: ["rome"],
    places: [
      "Colosseum",
      "Roman Forum",
      "Trevi Fountain",
      "Pantheon",
      "Vatican Museums",
      "St. Peter's Basilica",
      "Piazza Navona",
      "Spanish Steps",
    ],
  },
  {
    keys: ["bangkok"],
    places: [
      "Grand Palace",
      "Wat Pho",
      "Wat Arun",
      "Chatuchak Market",
      "Asiatique The Riverfront",
      "Chao Phraya River",
      "Khao San Road",
      "Siam Square",
    ],
  },
  {
    keys: ["singapore"],
    places: [
      "Marina Bay Sands",
      "Gardens by the Bay",
      "Merlion Park",
      "Sentosa Island",
      "Chinatown Singapore",
      "Little India Singapore",
      "Orchard Road",
      "Clarke Quay",
    ],
  },
];

const GENERIC_TRAVEL_PHRASES = [
  "explore local attractions",
  "visit nearby places",
  "day at leisure",
  "city tour",
  "local sightseeing",
  "enjoy local culture",
  "discover hidden gems",
  "travel at your own pace",
  "experience the local vibe",
];

const ITINERARY_SIGNATURE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "around",
  "at",
  "before",
  "best",
  "between",
  "by",
  "day",
  "days",
  "during",
  "each",
  "evening",
  "explore",
  "from",
  "get",
  "go",
  "in",
  "includes",
  "into",
  "itinerary",
  "lunch",
  "morning",
  "night",
  "of",
  "on",
  "or",
  "out",
  "plan",
  "pm",
  "route",
  "see",
  "spend",
  "start",
  "stay",
  "stop",
  "take",
  "the",
  "to",
  "travel",
  "trip",
  "visit",
  "way",
  "with",
  "your",
]);

const PACKING_GENERIC_LABELS = [
  "clothes",
  "clothing",
  "documents",
  "electronics",
  "essentials",
  "first aid",
  "gear",
  "jacket",
  "items",
  "kit",
  "medicines",
  "medication",
  "toiletries",
  "toiletry",
  "toiletry kit",
  "travel kit",
  "shoes",
  "footwear",
  "snacks",
  "supplies",
  "things to pack",
];

function normalizeLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9,\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const text = String(value || "").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });
  return out;
}

function getDestinationLandmarkHints(destination) {
  const normalized = normalizeLookupText(destination);
  if (!normalized) return [];
  const matches = [];
  DESTINATION_LANDMARK_HINTS.forEach((entry) => {
    const hasMatch = (entry.keys || []).some((key) => normalized.includes(String(key || "").toLowerCase()));
    if (hasMatch && Array.isArray(entry.places)) {
      matches.push(...entry.places);
    }
  });
  return dedupeStrings(matches).slice(0, 12);
}

function flattenGeminiSectionsText(parsed) {
  const chunks = [];
  if (!parsed || typeof parsed !== "object") return "";
  const highlights = parsed.tripHighlights && typeof parsed.tripHighlights === "object" ? parsed.tripHighlights : {};
  const weather = parsed.weatherAnalysis && typeof parsed.weatherAnalysis === "object" ? parsed.weatherAnalysis : {};
  if (highlights.tripTitle) chunks.push(highlights.tripTitle);
  if (highlights.summary) chunks.push(highlights.summary);
  if (Array.isArray(highlights.interestChips)) chunks.push(highlights.interestChips.join(" "));
  if (weather.expectedConditions) chunks.push(weather.expectedConditions);
  if (weather.bestTimeToVisit) chunks.push(weather.bestTimeToVisit);

  const itinerary = Array.isArray(parsed.itinerary) ? parsed.itinerary : [];
  itinerary.forEach((day) => {
    if (!day || typeof day !== "object") return;
    if (day.title) chunks.push(day.title);
    const schedule = day.schedule && typeof day.schedule === "object" ? day.schedule : {};
    ["morning", "afternoon", "evening", "night"].forEach((slot) => {
      if (schedule[slot]) chunks.push(schedule[slot]);
    });
    if (Array.isArray(day.foodRecommendations)) chunks.push(day.foodRecommendations.join(" "));
    if (Array.isArray(day.stayOptions)) chunks.push(day.stayOptions.join(" "));
    if (Array.isArray(day.optionalActivities)) chunks.push(day.optionalActivities.join(" "));
    if (Array.isArray(day.quickBookings)) chunks.push(day.quickBookings.join(" "));
  });
  if (Array.isArray(parsed.packingChecklist)) chunks.push(parsed.packingChecklist.join(" "));
  return chunks.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

function buildSignatureStopwords(trip) {
  const stopwords = new Set(ITINERARY_SIGNATURE_STOPWORDS);
  [trip && trip.startCity, trip && trip.destination].forEach((value) => {
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .forEach((token) => stopwords.add(token));
  });
  return stopwords;
}

function tokenizeComparableText(value, stopwords) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  const seen = new Set();
  const tokens = [];
  text.split(/\s+/g).forEach((token) => {
    const clean = token.trim();
    if (!clean || clean.length < 3) return;
    if (/^\d+$/.test(clean)) return;
    if (stopwords && stopwords.has(clean)) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    tokens.push(clean);
  });
  return tokens;
}

function buildItineraryDaySignature(day, tripStopwords) {
  if (!day || typeof day !== "object") return [];
  const chunks = [];
  if (day.title) chunks.push(day.title);
  const schedule = day.schedule && typeof day.schedule === "object" ? day.schedule : {};
  ["morning", "afternoon", "evening", "night"].forEach((slot) => {
    if (schedule[slot]) chunks.push(schedule[slot]);
  });
  if (Array.isArray(day.foodRecommendations)) chunks.push(day.foodRecommendations.join(" "));
  if (Array.isArray(day.stayOptions)) chunks.push(day.stayOptions.join(" "));
  if (Array.isArray(day.optionalActivities)) chunks.push(day.optionalActivities.join(" "));
  if (Array.isArray(day.quickBookings)) chunks.push(day.quickBookings.join(" "));
  return tokenizeComparableText(chunks.join(" "), tripStopwords);
}

function compareTokenSignatures(leftTokens, rightTokens) {
  const left = new Set(Array.isArray(leftTokens) ? leftTokens : []);
  const right = new Set(Array.isArray(rightTokens) ? rightTokens : []);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  left.forEach((token) => {
    if (right.has(token)) shared += 1;
  });
  const denom = left.size + right.size;
  return denom ? (shared * 2) / denom : 0;
}

function countDestinationHintMatches(text, landmarkHints) {
  const source = String(text || "").toLowerCase();
  const matched = new Set();
  (Array.isArray(landmarkHints) ? landmarkHints : []).forEach((hint) => {
    const normalizedHint = String(hint || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedHint) return;
    if (source.includes(normalizedHint)) {
      matched.add(normalizedHint);
      return;
    }
    const hintTokens = normalizedHint
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4);
    if (hintTokens.length >= 2 && hintTokens.every((token) => source.includes(token))) {
      matched.add(normalizedHint);
    }
  });
  return matched.size;
}

function evaluateGeminiSectionsQuality(parsed, payload) {
  const trip = normalizeGeminiTripPayload(payload || {});
  const issues = [];
  const itinerary = Array.isArray(parsed && parsed.itinerary) ? parsed.itinerary : [];
  if (itinerary.length !== trip.totalDays) {
    issues.push(`itinerary_days_mismatch:${itinerary.length}_of_${trip.totalDays}`);
  }

  let slotCoverageCount = 0;
  itinerary.forEach((day) => {
    if (!day || typeof day !== "object") return;
    const schedule = day.schedule && typeof day.schedule === "object" ? day.schedule : {};
    ["morning", "afternoon", "evening", "night"].forEach((slot) => {
      const text = String(schedule[slot] || "").trim();
      if (text.length >= 14) slotCoverageCount += 1;
    });
  });
  const minSlotsExpected = Math.max(4, trip.totalDays * 3);
  if (slotCoverageCount < minSlotsExpected) {
    issues.push(`thin_schedule_coverage:${slotCoverageCount}_of_${minSlotsExpected}`);
  }

  const tripStopwords = buildSignatureStopwords(trip);
  const daySignatures = itinerary.map((day) => buildItineraryDaySignature(day, tripStopwords));
  for (let i = 0; i < daySignatures.length; i += 1) {
    for (let j = i + 1; j < daySignatures.length; j += 1) {
      const similarity = compareTokenSignatures(daySignatures[i], daySignatures[j]);
      if (similarity >= 0.78 && daySignatures[i].length >= 6 && daySignatures[j].length >= 6) {
        issues.push(`repeated_itinerary_day:${i + 1}_and_${j + 1}_similarity:${similarity.toFixed(2)}`);
      }
    }
  }

  const flatText = flattenGeminiSectionsText(parsed);
  const genericPhraseHits = GENERIC_TRAVEL_PHRASES.filter((phrase) => flatText.includes(phrase)).length;
  if (genericPhraseHits >= 2) {
    issues.push(`generic_phrasing:${genericPhraseHits}`);
  }

  const landmarkHints = getDestinationLandmarkHints(trip.destination);
  const hintMatches = countDestinationHintMatches(flatText, landmarkHints);
  if (landmarkHints.length) {
    const expectedHints = Math.min(4, Math.max(2, Math.min(trip.totalDays + 1, landmarkHints.length)));
    if (hintMatches < expectedHints) {
      issues.push(`landmark_specificity_low:${hintMatches}_of_${expectedHints}`);
    }
  }

  const packing = Array.isArray(parsed && parsed.packingChecklist) ? parsed.packingChecklist : [];
  const uniquePacking = dedupeStrings(packing.map((item) => String(item || "").trim()));
  const genericPackingHits = uniquePacking.filter((item) => {
    const normalizedItem = String(item || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedItem) return false;
    return PACKING_GENERIC_LABELS.some((phrase) => {
      const normalizedPhrase = String(phrase || "").toLowerCase().trim();
      return (
        normalizedItem === normalizedPhrase ||
        normalizedItem.startsWith(`${normalizedPhrase} `) ||
        normalizedItem.endsWith(` ${normalizedPhrase}`) ||
        normalizedItem.includes(` ${normalizedPhrase} `)
      );
    });
  }).length;
  if (packing.length < 12) {
    issues.push(`packing_too_short:${packing.length}`);
  }
  if (uniquePacking.length < Math.max(10, Math.floor(packing.length * 0.85))) {
    issues.push(`packing_too_repetitive:${uniquePacking.length}_of_${packing.length}`);
  }
  if (genericPackingHits >= 4) {
    issues.push(`packing_too_generic:${genericPackingHits}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      itineraryDays: itinerary.length,
      slotCoverageCount,
      genericPhraseHits,
      landmarkHintMatches: hintMatches,
      packingItems: packing.length,
    },
  };
}

function buildGeminiSectionsPrompt(payload, options = {}) {
  const data = normalizeGeminiTripPayload(payload);
  const landmarkHints = getDestinationLandmarkHints(data.destination);
  const focusIssues = Array.isArray(options.focusIssues)
    ? options.focusIssues.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const minimumHintUsage = landmarkHints.length
    ? Math.min(4, Math.max(2, Math.min(data.totalDays + 1, landmarkHints.length)))
    : 0;
  const isRevision = !!options.isRevision;
  const previousJson =
    options.previousJson && typeof options.previousJson === "object" ? options.previousJson : null;
  const serializedPrevious =
    previousJson && JSON.stringify(previousJson).length > 0
      ? JSON.stringify(previousJson).slice(0, 7000)
      : "";

  return [
    "Return only valid JSON. Do not use markdown.",
    "You are an expert local travel planner generating real-life, actionable trip content for a travel web app.",
    "Your output must be specific, practical, and destination-grounded.",
    "",
    "Trip request:",
    `Start city: ${data.startCity || "Not specified"}`,
    `Destination: ${data.destination || "Not specified"}`,
    `Start date: ${data.startDate || "Not specified"}`,
    `End date: ${data.endDate || "Not specified"}`,
    `Date range label: ${data.dateRangeText || "Not specified"}`,
    `Total days: ${data.totalDays}`,
    `Themes: ${data.themes.length ? data.themes.join(", ") : "None"}`,
    `Pace: ${data.pace || "Not specified"}`,
    `Weather preference: ${data.weather || "Not specified"}`,
    `Accommodation: ${data.accommodation.length ? data.accommodation.join(", ") : "None"}`,
    `Food: ${data.food.length ? data.food.join(", ") : "None"}`,
    `Transport: ${data.transport.length ? data.transport.join(", ") : "None"}`,
    `Currency: ${data.currency}`,
    `Budget input: ${data.budget || "Not provided"}`,
    `Passengers: ${data.passengers || "Not specified"}`,
    `Extra preferences: ${data.preferences || "None"}`,
    `Destination landmark hints: ${
      landmarkHints.length ? landmarkHints.join(", ") : "Not available; use best-known places for this destination."
    }`,
    "",
    "Generate these sections: Trip Highlights, Weather Analysis, Itinerary, Budget Range, Packing Checklist.",
    "Use real popular attractions/landmarks and practical movement between spots.",
    "Do not write generic template text like 'explore local attractions' without naming places.",
    "In itinerary slot text, include concrete place names and practical transit/area context.",
    "",
    "Output schema:",
    "{",
    '  "tripHighlights": {',
    '    "tripTitle": "string",',
    '    "travelWindow": "string",',
    '    "originCity": "string",',
    '    "hotelPreference": "string",',
    '    "foodPreference": "string",',
    '    "interestChips": ["string"],',
    '    "summary": "string"',
    "  },",
    '  "weatherAnalysis": {',
    '    "expectedConditions": "string",',
    '    "bestTimeToVisit": "string"',
    "  },",
    '  "itinerary": [',
    "    {",
    '      "dayNumber": 1,',
    '      "title": "string",',
    '      "dateLabel": "string",',
    '      "schedule": {',
    '        "morning": "string",',
    '        "afternoon": "string",',
    '        "evening": "string",',
    '        "night": "string"',
    "      },",
    '      "foodRecommendations": ["string"],',
    '      "stayOptions": ["string"],',
    '      "optionalActivities": ["string"],',
    '      "quickBookings": ["string"]',
    "    }",
    "  ],",
    '  "budgetRange": {',
    '    "currency": "INR",',
    '    "essentials": [',
    '      { "id": "accommodation", "label": "Accommodation", "pct": 33, "min": 25000, "max": 40000 },',
    '      { "id": "food", "label": "Food", "pct": 13, "min": 9000, "max": 17000 },',
    '      { "id": "insurance", "label": "Insurance", "pct": 1, "min": 800, "max": 2500 },',
    '      { "id": "contingency", "label": "Contingency", "pct": 7, "min": 4500, "max": 10000 }',
    "    ],",
    '    "activities": [',
    '      { "id": "activitiesIncluded", "label": "Activities Included", "pct": 6, "min": 6000, "max": 12000 },',
    '      { "id": "activitiesOptional", "label": "Activities Optional", "pct": 8, "min": 7000, "max": 15000 }',
    "    ],",
    '    "transport": [',
    '      { "id": "travelStartReturn", "label": "Travel Start/Return", "pct": 22, "min": 12000, "max": 30000 },',
    '      { "id": "intercityTransport", "label": "Intercity Transport", "pct": 6, "min": 3000, "max": 9000 },',
    '      { "id": "intracityTransport", "label": "Intracity Transport", "pct": 4, "min": 2500, "max": 7000 },',
    '      { "id": "visa", "label": "Visa", "pct": 0, "min": 0, "max": 0 }',
    "    ]",
    "  },",
    '  "packingChecklist": ["string"]',
    "}",
    "",
    "Rules:",
    `- Itinerary array must have exactly ${data.totalDays} items.`,
    "- Use realistic and concise text per field with useful details.",
    "- Each itinerary day title and schedule should include real place names for the destination.",
    "- Every itinerary day must be meaningfully different from every other day. Do not reuse the same sightseeing order or the same morning/afternoon/evening/night plan across multiple days.",
    "- Give each day a distinct theme or anchor so Day 1, Day 2, Day 3, etc. feel like separate parts of the trip, not copies of each other.",
    "- Avoid rephrasing the same day with slightly different words. The route, activities, and places must change from day to day.",
    "- Across the full itinerary include at least 8 unique real place names (if destination supports it).",
    "- Mention practical route context: nearby areas, transfer hints, or timing windows.",
    "- Include realistic local anchors such as neighborhoods, viewpoints, ghats, beaches, markets, districts, temples, forts, museums, or monuments where relevant.",
    "- Budget values must be integers, non-negative, and min <= max.",
    "- Use only allowed budget ids shown in schema.",
    "- packingChecklist should contain 12-18 actionable items.",
    "- Packing checklist items must be specific and practical, not just category labels. Include must-have items such as documents, wallet/cards, medicines, chargers, power bank, weather protection, footwear, toiletries, clothing layers, and destination-specific gear.",
    "- Avoid generic one-word checklist items unless they are truly essential, and do not repeat the same packing item in different words.",
    "- If uncertain about a specific place, prefer widely known landmarks and districts.",
    landmarkHints.length
      ? `- Use at least ${minimumHintUsage} names from 'Destination landmark hints' in the itinerary schedule/day titles.`
      : "- If no hints are provided, infer well-known landmarks from the destination and avoid generic wording.",
    isRevision ? "- This is a revision task: improve specificity and remove all generic placeholders." : "",
    focusIssues.length ? `- Fix these quality issues explicitly: ${focusIssues.join(", ")}.` : "",
    serializedPrevious ? `Previous weak JSON to improve: ${serializedPrevious}` : "",
  ].join("\n");
}

function extractGeminiText(payload) {
  const candidates = payload && Array.isArray(payload.candidates) ? payload.candidates : [];
  const first = candidates[0];
  const parts = first && first.content && Array.isArray(first.content.parts) ? first.content.parts : [];
  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function summarizeGeminiErrorText(rawText) {
  return String(rawText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

async function requestGeminiSectionsOnce({ apiKey, model, promptText, useGoogleSearch }) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: String(promptText || "").trim() }],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      responseMimeType: "application/json",
    },
  };
  if (useGoogleSearch) {
    body.tools = [{ google_search: {} }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      errorText: summarizeGeminiErrorText(rawText),
      payload,
      useGoogleSearch,
      model,
    };
  }

  const text = extractGeminiText(payload || {});
  const parsed = parseJsonFromText(text);
  if (!parsed) {
    return {
      ok: false,
      status: 502,
      errorText: "Gemini response parsing failed",
      payload,
      useGoogleSearch,
      model,
    };
  }

  return {
    ok: true,
    status: response.status,
    payload,
    text,
    parsed,
    useGoogleSearch,
    model,
  };
}

async function requestGeminiSectionsWithFallback({ apiKey, model, promptText }) {
  const normalizedModel = String(model || "").trim();
  const preferWithoutTools = /\b1\.5\b/i.test(normalizedModel);
  const modeOrder = preferWithoutTools ? [false, true] : [true, false];
  const attempts = [];
  for (let index = 0; index < modeOrder.length; index += 1) {
    const useGoogleSearch = modeOrder[index];
    const result = await requestGeminiSectionsOnce({
      apiKey,
      model: normalizedModel,
      promptText,
      useGoogleSearch,
    });
    attempts.push({
      model: normalizedModel,
      useGoogleSearch,
      ok: !!result.ok,
      status: result.status,
      errorText: result.ok ? "" : String(result.errorText || ""),
    });
    if (result.ok) {
      return {
        ok: true,
        result,
        attempts,
      };
    }
  }
  return {
    ok: false,
    attempts,
  };
}

app.post("/api/plan", express.json(), async (req, res) => {
  const client = getOpenAIClient();
  if (!client) {
    return res.status(500).json({ error: "OPENAI_API_KEY not set" });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt" });
  }

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are a helpful travel planner. Produce a concise itinerary with day-by-day bullets, highlight must-see spots, and include local tips. Keep it under 350 words.",
        },
        { role: "user", content: prompt },
      ],
    });

    const text = response.output_text || "";
    return res.json({ text });
  } catch (error) {
    return res.status(500).json({
      error:
        error && error.message
          ? `OpenAI request failed: ${error.message}`
          : "OpenAI request failed",
    });
  }
});

app.post("/api/feasibility", express.json(), async (req, res) => {
  const payload = normalizeGeminiTripPayload(req.body || {});
  if (isMockAiEnabled()) {
    const mock = buildMockFeasibilityResult(payload);
    return res.json({
      ...mock,
      _meta: {
        source: "mock",
        model: "mock-ai",
        usedGoogleSearch: false,
        elapsedMs: 0,
      },
    });
  }

  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  }

  const startedAt = Date.now();
  const configuredModel = String(process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();
  const modelCandidates = dedupeStrings([
    configuredModel,
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash",
  ]);

  try {
    for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
      const model = modelCandidates[modelIndex];
      const attempt = await requestGeminiSectionsWithFallback({
        apiKey,
        model,
        promptText: buildFeasibilityPrompt(payload),
      });

      if (!attempt.ok || !attempt.result || !attempt.result.parsed) {
        continue;
      }

      const normalized = normalizeFeasibilityResult(attempt.result.parsed, payload);
      if (!normalized) {
        continue;
      }

      return res.json({
        ...normalized,
        _meta: {
          source: "gemini",
          model,
          usedGoogleSearch: !!attempt.result.useGoogleSearch,
          elapsedMs: Date.now() - startedAt,
        },
      });
    }

    return res.status(502).json({ error: "Gemini response parsing failed" });
  } catch (error) {
    return res.status(500).json({
      error:
        error && error.message
          ? `Gemini feasibility request failed: ${error.message}`
          : "Gemini feasibility request failed",
    });
  }
});

async function generateGeminiSections(payload) {
  if (isMockAiEnabled()) {
    return buildMockGeminiSections(payload);
  }

  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const configuredModel = String(process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();
  const normalized = normalizeGeminiTripPayload(payload || {});
  const startedAt = Date.now();

  const modelCandidates = dedupeStrings([
    configuredModel,
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash",
  ]);
  const attemptLog = [];
  let bestOutput = null;

  for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
    const modelName = modelCandidates[modelIndex];
    const basePrompt = buildGeminiSectionsPrompt(normalized);
    const primary = await requestGeminiSectionsWithFallback({
      apiKey,
      model: modelName,
      promptText: basePrompt,
    });
    attemptLog.push(...primary.attempts);
    if (!primary.ok || !primary.result || !primary.result.parsed) {
      continue;
    }

    const baseQuality = evaluateGeminiSectionsQuality(primary.result.parsed, normalized);
    let selected = {
      parsed: primary.result.parsed,
      quality: baseQuality,
      model: modelName,
      usedGoogleSearch: primary.result.useGoogleSearch,
    };

    if (!baseQuality.ok) {
      const revisionPrompt = buildGeminiSectionsPrompt(normalized, {
        isRevision: true,
        focusIssues: baseQuality.issues,
        previousJson: primary.result.parsed,
      });
      const revision = await requestGeminiSectionsWithFallback({
        apiKey,
        model: modelName,
        promptText: revisionPrompt,
      });
      attemptLog.push(...revision.attempts);
      if (revision.ok && revision.result && revision.result.parsed) {
        const revisionQuality = evaluateGeminiSectionsQuality(revision.result.parsed, normalized);
        if (revisionQuality.issues.length <= selected.quality.issues.length) {
          selected = {
            parsed: revision.result.parsed,
            quality: revisionQuality,
            model: modelName,
            usedGoogleSearch: revision.result.useGoogleSearch,
          };
        }
      }
    }

    if (
      !bestOutput ||
      selected.quality.issues.length < bestOutput.quality.issues.length ||
      (selected.quality.issues.length === bestOutput.quality.issues.length && selected.quality.ok)
    ) {
      bestOutput = selected;
    }
    if (selected.quality.ok) break;
  }

  if (!bestOutput) {
    const detail = attemptLog
      .map((entry) => {
        const toolMode = entry.useGoogleSearch ? "with_google_search" : "without_google_search";
        return `${entry.model}:${toolMode}:${entry.status}${entry.errorText ? `:${entry.errorText}` : ""}`;
      })
      .join(" | ")
      .slice(0, 900);
    const err = new Error("Gemini request failed");
    err.detail = detail;
    throw err;
  }

  return {
    parsed: bestOutput.parsed,
    meta: {
      source: "gemini",
      model: bestOutput.model,
      usedGoogleSearch: bestOutput.usedGoogleSearch,
      elapsedMs: Date.now() - startedAt,
      quality: bestOutput.quality,
    },
  };
}

app.post("/api/gemini/plan-sections", express.json(), async (req, res) => {
  try {
    const result = await generateGeminiSections(req.body || {});
    return res.json({
      ...result.parsed,
      _meta: result.meta,
    });
  } catch (error) {
    if (error && error.message === "GEMINI_API_KEY not set") {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }
    if (error && error.detail) {
      return res.status(502).json({ error: "Gemini request failed", detail: error.detail });
    }
    return res.status(500).json({
      error:
        error && error.message
          ? `Gemini request failed: ${error.message}`
          : "Gemini request failed",
    });
  }
});

function normalizeDestinationText(destinationText) {
  const base = String(destinationText || "")
    .replace(/\s+/g, " ")
    .trim();
  return base;
}

function normalizeThemeList(themeInput) {
  if (Array.isArray(themeInput)) {
    return themeInput.map((theme) => String(theme || "").trim()).filter(Boolean);
  }
  return String(themeInput || "")
    .split(",")
    .map((theme) => theme.trim())
    .filter(Boolean);
}

function splitQueryTokens(value, minLength) {
  const min = Number.isFinite(Number(minLength)) ? Number(minLength) : 3;
  return normalizeDestinationText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= min);
}

function getThemeKeywords(themeValue) {
  const normalized = String(themeValue || "").toLowerCase();
  if (!normalized) return [];
  if (normalized.includes("beach")) return ["beach", "coastline", "sunset"];
  if (normalized.includes("adventure")) return ["mountains", "hiking", "nature"];
  if (
    normalized.includes("hill") ||
    normalized.includes("nature") ||
    normalized.includes("wildlife")
  ) {
    return ["mountains", "valley", "forest"];
  }
  if (
    normalized.includes("culture") ||
    normalized.includes("histor") ||
    normalized.includes("heritage") ||
    normalized.includes("temple") ||
    normalized.includes("monument")
  ) {
    return ["historic", "architecture", "temple", "monument"];
  }
  if (normalized.includes("night")) return ["city", "skyline", "night", "lights"];
  if (normalized.includes("shopping") || normalized.includes("market")) {
    return ["city", "street", "market"];
  }
  return [];
}

function dedupeWords(words) {
  const seen = new Set();
  const output = [];
  words.forEach((word) => {
    const text = String(word || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(text);
  });
  return output;
}

function generateOptimizedUnsplashQuery(input) {
  const payload = input && typeof input === "object" ? input : {};
  const destination = normalizeDestinationText(payload.destination);
  const startCity = normalizeDestinationText(payload.startCity);
  const themes = normalizeThemeList(payload.themes);
  const primaryLocation = destination || startCity;

  const words = [];
  words.push(...splitQueryTokens(primaryLocation));
  words.push("travel", "tourism", "landmark", "famous place", "landscape");

  themes.forEach((theme) => {
    words.push(...getThemeKeywords(theme));
  });

  return dedupeWords(words).join(" ").trim();
}

function buildDestinationImageQueries(destinationText, startCity, themes) {
  const destination = normalizeDestinationText(destinationText);
  const origin = normalizeDestinationText(startCity);
  const base = destination || origin;
  const optimizedQuery = generateOptimizedUnsplashQuery({
    startCity: origin,
    destination: destination,
    themes: themes,
  });

  if (!base && !optimizedQuery) {
    return ["popular travel destination landmark tourism landscape"];
  }

  const city = String(base.split(",")[0] || "").trim();
  const queries = [
    optimizedQuery,
    `${base} famous landmarks`,
    `${base} popular tourist attractions`,
    `${base} iconic places`,
    `${base} travel landscape`,
  ];
  if (city && city.toLowerCase() !== base.toLowerCase()) {
    queries.splice(2, 0, `${city} famous landmarks`);
  }

  return Array.from(new Set(queries.map((query) => String(query || "").trim().toLowerCase())))
    .filter(Boolean)
    .map((query) => query.replace(/\s+/g, " ").trim());
}

function buildLocationTokens(destinationText, startCity) {
  const location = normalizeDestinationText(destinationText) || normalizeDestinationText(startCity);
  return dedupeWords(splitQueryTokens(location, 2)).map((token) => token.toLowerCase());
}

function buildThemeTokens(themes) {
  const tokens = [];
  normalizeThemeList(themes).forEach((theme) => {
    getThemeKeywords(theme).forEach((keyword) => {
      tokens.push(...splitQueryTokens(keyword, 2));
    });
  });
  return dedupeWords(tokens).map((token) => token.toLowerCase());
}

function getUnsplashPhotoText(photo) {
  const altText = String(photo && photo.alt_description ? photo.alt_description : "").trim();
  const description = String(photo && photo.description ? photo.description : "").trim();
  const slug = String(photo && photo.slug ? photo.slug : "").trim();
  const altSlugEn = String(
    photo && photo.alternative_slugs && photo.alternative_slugs.en
      ? photo.alternative_slugs.en
      : ""
  ).trim();
  const userLocation = String(
    photo && photo.user && photo.user.location ? photo.user.location : ""
  ).trim();
  return String(`${altText} ${description} ${slug} ${altSlugEn} ${userLocation}`)
    .trim()
    .toLowerCase();
}

function pickUnsplashHeroImage(photo) {
  if (!photo || typeof photo !== "object") return "";
  const urls = photo.urls && typeof photo.urls === "object" ? photo.urls : {};
  return String(urls.regular || urls.full || urls.raw || urls.small || "").trim();
}

function scoreUnsplashPhoto(photo, locationTokens, themeTokens, queryBias) {
  if (!photo || typeof photo !== "object") return -1;
  const text = getUnsplashPhotoText(photo);
  const width = Number(photo.width || 0);
  const height = Number(photo.height || 0);

  const landmarkKeywords = [
    "landmark",
    "tourist",
    "attraction",
    "famous",
    "iconic",
    "historic",
    "monument",
    "temple",
    "fort",
    "palace",
    "cathedral",
    "church",
    "mosque",
    "bridge",
    "tower",
    "museum",
    "square",
    "beach",
    "mountain",
    "lake",
    "waterfall",
    "skyline",
    "city",
    "travel",
  ];

  let score = Number(queryBias) || 0;
  let locationMatchCount = 0;
  locationTokens.forEach((token) => {
    if (text.includes(token)) {
      locationMatchCount += 1;
      score += 22;
    }
  });
  themeTokens.forEach((token) => {
    if (text.includes(token)) score += 4;
  });
  landmarkKeywords.forEach((keyword) => {
    if (text.includes(keyword)) score += 2;
  });
  if (width > 0 && height > 0 && width >= height) score += 8;
  if (text) score += 2;
  if (locationTokens.length && locationMatchCount === 0) score -= 35;
  if (locationMatchCount >= Math.min(2, locationTokens.length)) score += 20;
  return {
    score,
    locationMatchCount,
  };
}

async function searchUnsplashPhotos(accessKey, query, perPage) {
  const searchParams = new URLSearchParams({
    query,
    per_page: String(perPage || 10),
    order_by: "relevant",
    orientation: "landscape",
    content_filter: "high",
  });
  const response = await fetch(`https://api.unsplash.com/search/photos?${searchParams.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
    },
  });
  if (!response.ok) {
    throw new Error(`Unsplash request failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload && Array.isArray(payload.results) ? payload.results : [];
}

app.get("/api/unsplash/hero", async (req, res) => {
  if (isMockAiEnabled()) {
    return res.json({
      imageUrl: "/images/image_2.jpg",
      query: "mock travel hero",
      source: "mock",
    });
  }

  const accessKey = String(process.env.UNSPLASH_ACCESS_KEY || "").trim();
  if (!accessKey) {
    return res.status(500).json({ error: "UNSPLASH_ACCESS_KEY not set" });
  }

  const destination = String(req.query.destination || "").trim();
  const startCity = String(req.query.startCity || "").trim();
  const themes = normalizeThemeList(req.query.themes);
  const queries = buildDestinationImageQueries(destination, startCity, themes);
  const locationTokens = buildLocationTokens(destination, startCity);
  const themeTokens = buildThemeTokens(themes);

  try {
    let bestMatchedImageUrl = "";
    let bestMatchedQuery = queries[0] || "travel landscape";
    let bestMatchedScore = -1;
    let bestFallbackImageUrl = "";
    let bestFallbackQuery = queries[0] || "travel landscape";
    let bestFallbackScore = -1;

    for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
      const query = queries[queryIndex];
      let photos = [];
      try {
        photos = await searchUnsplashPhotos(accessKey, query, 12);
      } catch {
        continue;
      }

      const queryBias = Math.max(0, (queries.length - queryIndex) * 4);
      for (let i = 0; i < photos.length; i += 1) {
        const photo = photos[i];
        const imageUrl = pickUnsplashHeroImage(photo);
        if (!imageUrl) continue;
        const ranked = scoreUnsplashPhoto(photo, locationTokens, themeTokens, queryBias);
        if (ranked.locationMatchCount > 0 && ranked.score > bestMatchedScore) {
          bestMatchedScore = ranked.score;
          bestMatchedImageUrl = imageUrl;
          bestMatchedQuery = query;
        }
        if (ranked.score > bestFallbackScore) {
          bestFallbackScore = ranked.score;
          bestFallbackImageUrl = imageUrl;
          bestFallbackQuery = query;
        }
      }

      if (bestMatchedScore >= 60) break;
    }

    return res.json({
      imageUrl: bestMatchedImageUrl || bestFallbackImageUrl,
      query: bestMatchedImageUrl ? bestMatchedQuery : bestFallbackQuery,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch destination image" });
  }
});

async function requirePlanAccess(userId, planId) {
  const access = await store.getPlanAccess(userId, planId);
  if (!access || !access.role) return null;
  return access;
}

app.get("/api/users/me", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return res.json({
      id: user.id,
      clerkUserId: user.clerk_user_id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      credits: Number(user.credits || 0),
      planTier: user.plan_tier || "free",
    });
  } catch (error) {
    console.error("GET /api/users/me failed:", error);
    return res.status(500).json({ error: "Unable to fetch user" });
  }
});

app.get("/api/plans", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const plans = await store.listPlansForUser(user.id);
    return res.json(plans);
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch plans" });
  }
});

app.post("/api/plans/generate", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const payload = normalizeGeminiTripPayload(req.body || {});

    const totalDays = diffDaysInclusive(payload.startDate, payload.endDate);
    if (!totalDays) {
      return res.status(400).json({ error: "Invalid travel dates" });
    }
    const limit = user.plan_tier === "paid" ? 30 : 7;
    if (totalDays > limit) {
      return res.status(400).json({ error: "Trip length exceeds plan limit", limit });
    }
    if (Number(user.credits || 0) < 1) {
      return res.status(402).json({ error: "Insufficient credits" });
    }

    const generated = await generateGeminiSections(payload);
    const plan = await store.createPlan(user.id, payload, generated.parsed, {});
    const creditsResult = await store.consumeCredits(user.id, 1, "generate", plan.id);
    if (!creditsResult) {
      await store.deletePlan(user.id, plan.id);
      return res.status(402).json({ error: "Insufficient credits" });
    }
    const creditsLeft = Number(creditsResult.credits || 0);

    return res.json({
      plan,
      credits: creditsLeft,
      _meta: generated.meta,
    });
  } catch (error) {
    console.error("POST /api/plans/generate failed:", error);
    if (error && error.message === "GEMINI_API_KEY not set") {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }
    if (error && error.detail) {
      return res.status(502).json({ error: "Gemini request failed", detail: error.detail });
    }
    if (error && error.message) {
      return res.status(500).json({ error: error.message });
    }
    return res.status(500).json({ error: "Plan generation failed" });
  }
});

app.get("/api/plans/:id", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    let access = await requirePlanAccess(user.id, req.params.id);
    if (!access) {
      const inviteId = String(req.query.inviteId || "").trim();
      if (inviteId && typeof store.acceptInviteById === "function") {
        try {
          await store.acceptInviteById(req.params.id, inviteId, user.id);
        } catch (_) {}
        access = await requirePlanAccess(user.id, req.params.id);
      }
    }
    if (!access) {
      // Fallback auto-accept by email for older invite links.
      const inviteEmail = String(user.email || req.auth.email || "").trim();
      if (inviteEmail) {
        try {
          await store.acceptInvite(req.params.id, user.id, inviteEmail);
        } catch (_) {}
        access = await requirePlanAccess(user.id, req.params.id);
      }
    }
    if (!access) return res.status(403).json({ error: "Forbidden" });
    return res.json({
      plan: access.plan,
      accessRole: access.role,
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch plan" });
  }
});

app.patch("/api/plans/:id", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const updates = req.body || {};
    let plan = await store.updatePlan(user.id, req.params.id, updates);
    if (updates.sections) {
      plan = await store.updatePlanSections(user.id, req.params.id, updates.sections);
    }
    return res.json({ plan });
  } catch (error) {
    return res.status(500).json({ error: "Unable to update plan" });
  }
});

app.delete("/api/plans/:id", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access || access.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const deleted = await store.deletePlan(user.id, req.params.id);
    return res.json({ deleted: !!deleted });
  } catch (error) {
    return res.status(500).json({ error: "Unable to delete plan" });
  }
});

app.post("/api/plans/:id/refine", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const refineCost = 0.25;
    if (Number(user.credits || 0) < refineCost) {
      return res.status(402).json({ error: "Insufficient credits" });
    }
    const current = access.plan;
    const input = Object.assign({}, current, req.body || {});
    const payload = normalizeGeminiTripPayload(input);
    const generated = await generateGeminiSections(payload);
    await store.updatePlan(user.id, req.params.id, input);
    const plan = await store.updatePlanSections(user.id, req.params.id, generated.parsed);
    const creditsResult = await store.consumeCredits(user.id, refineCost, "refine", req.params.id);
    const creditsLeft = creditsResult ? Number(creditsResult.credits || 0) : Number(user.credits || 0);
    return res.json({ plan, credits: creditsLeft, _meta: generated.meta });
  } catch (error) {
    console.error("Refine plan failed:", error);
    if (error && error.message === "GEMINI_API_KEY not set") {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }
    if (error && error.detail) {
      return res.status(502).json({ error: "Gemini request failed", detail: error.detail });
    }
    return res.status(500).json({
      error:
        error && error.message
          ? `Unable to refine plan: ${error.message}`
          : "Unable to refine plan",
    });
  }
});

app.patch("/api/plans/:id/itinerary", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) return res.status(403).json({ error: "Forbidden" });
    const body = req.body || {};
    let itinerary = Array.isArray(body.itinerary) ? body.itinerary : null;
    if (!itinerary && typeof body.dayIndex === "number" && body.day) {
      const current = access.plan.sections && Array.isArray(access.plan.sections.itinerary)
        ? access.plan.sections.itinerary.slice()
        : [];
      current[body.dayIndex] = body.day;
      itinerary = current;
    }
    const plan = await store.updatePlanItinerary(req.params.id, itinerary || []);
    return res.json({ plan });
  } catch (error) {
    return res.status(500).json({ error: "Unable to update itinerary" });
  }
});

app.get("/api/plans/:id/collaborators", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) return res.status(403).json({ error: "Forbidden" });
    const collaborators = await store.listCollaborators(req.params.id);
    return res.json({ collaborators });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch collaborators" });
  }
});

app.post("/api/plans/:id/collaborators", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access || access.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const email = String(req.body && req.body.email ? req.body.email : "").trim();
    if (!email) return res.status(400).json({ error: "Email is required" });
    const invite = await store.inviteCollaborator(req.params.id, email);

    const inviterName =
      [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
      user.email ||
      "A Yatrify traveler";
    const destination =
      access && access.plan && access.plan.destination
        ? String(access.plan.destination)
        : "your travel plan";

    let emailDelivery = { sent: false, skipped: true, reason: "not attempted" };
    try {
      emailDelivery = await sendCollaboratorInviteEmail({
        toEmail: email,
        planId: req.params.id,
        inviteId: invite && invite.id ? String(invite.id) : "",
        destination,
        inviterName,
        inviterEmail: user.email || "",
        appBaseUrl: process.env.APP_BASE_URL || req.headers.origin || "http://localhost:5500",
      });
    } catch (mailError) {
      emailDelivery = { sent: false, skipped: false, reason: mailError.message || "send failed" };
      console.error("Collaborator invite email failed:", mailError);
    }

    return res.json({ invite, emailDelivery });
  } catch (error) {
    console.error("POST /api/plans/:id/collaborators failed:", error);
    const detail =
      String(process.env.NODE_ENV || "").toLowerCase() === "production"
        ? undefined
        : (error && error.message ? String(error.message) : "Unknown error");
    return res.status(500).json({ error: "Unable to invite collaborator", detail });
  }
});

app.post("/api/plans/:id/collaborators/accept", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const inviteId = String((req.body && req.body.inviteId) || "").trim();
    let invite = null;
    if (inviteId && typeof store.acceptInviteById === "function") {
      invite = await store.acceptInviteById(req.params.id, inviteId, user.id);
    }
    if (!invite) {
      const email = user.email || req.auth.email || "";
      invite = await store.acceptInvite(req.params.id, user.id, email);
    }
    if (!invite) return res.status(404).json({ error: "Invite not found" });
    return res.json({ invite });
  } catch (error) {
    return res.status(500).json({ error: "Unable to accept invite" });
  }
});

app.delete("/api/plans/:id/collaborators/:collaboratorId", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access || access.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const collaboratorEmail = String(req.query && req.query.email ? req.query.email : "").trim().toLowerCase();
    const revoked = await store.revokeCollaborator(req.params.id, req.params.collaboratorId, collaboratorEmail);
    if (!revoked) return res.status(404).json({ error: "Collaborator not found" });
    return res.json({ revoked });
  } catch (error) {
    return res.status(500).json({ error: "Unable to revoke collaborator" });
  }
});
app.get("/api/plans/:id/expenses", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) return res.status(403).json({ error: "Forbidden" });
    const expenses = await store.listExpenses(req.params.id);
    return res.json({ expenses });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch expenses" });
  }
});

app.post("/api/plans/:id/expenses", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) return res.status(403).json({ error: "Forbidden" });
    const expense = await store.createExpense(req.params.id, user.id, req.body || {});
    return res.json({ expense });
  } catch (error) {
    return res.status(500).json({ error: "Unable to create expense" });
  }
});

app.patch("/api/plans/:id/expenses/:expenseId", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) return res.status(403).json({ error: "Forbidden" });
    const expense = await store.updateExpense(req.params.id, user.id, req.params.expenseId, req.body || {});
    return res.json({ expense });
  } catch (error) {
    return res.status(500).json({ error: "Unable to update expense" });
  }
});

app.delete("/api/plans/:id/expenses/:expenseId", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access) return res.status(403).json({ error: "Forbidden" });
    const deleted = await store.deleteExpense(req.params.id, user.id, req.params.expenseId);
    return res.json({ deleted });
  } catch (error) {
    return res.status(500).json({ error: "Unable to delete expense" });
  }
});

app.post("/api/plans/:id/publish", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access || access.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const body = req.body || {};
    const plan = await store.setPlanPublished(
      user.id,
      req.params.id,
      true,
      body.visitStartDate,
      body.visitEndDate
    );
    return res.json({ plan });
  } catch (error) {
    return res.status(500).json({ error: "Unable to publish plan" });
  }
});

app.post("/api/plans/:id/unpublish", requireAuth, requireDb, async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const access = await requirePlanAccess(user.id, req.params.id);
    if (!access || access.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const plan = await store.setPlanPublished(user.id, req.params.id, false, null, null);
    return res.json({ plan });
  } catch (error) {
    return res.status(500).json({ error: "Unable to unpublish plan" });
  }
});

app.get("/api/community/plans", requireDb, async (_req, res) => {
  try {
    const plans = await store.listCommunityPlans();
    return res.json({ plans });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch community plans" });
  }
});

app.get("/api/community/plans/:id", requireDb, async (req, res) => {
  try {
    const plan = await store.getCommunityPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    return res.json({ plan });
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch plan" });
  }
});

async function fetchCSCJson(pathname) {
  if (!process.env.CSC_API_KEY) {
    throw new Error("CSC_API_KEY missing");
  }
  const response = await fetch(`https://api.countrystatecity.in/v1${pathname}`, {
    method: "GET",
    headers: {
      "X-CSCAPI-KEY": process.env.CSC_API_KEY,
    },
  });
  if (!response.ok) {
    throw new Error(`CSC request failed: ${response.status}`);
  }
  return response.json();
}

app.get("/api/csc/countries", async (_req, res) => {
  try {
    const countries = await fetchCSCJson("/countries");
    return res.json(countries);
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch countries from CSC API" });
  }
});

app.get("/api/csc/countries/:iso2/cities", async (req, res) => {
  const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
  if (!iso2) {
    return res.status(400).json({ error: "Country code is required" });
  }
  try {
    const cities = await fetchCSCJson(`/countries/${encodeURIComponent(iso2)}/cities`);
    return res.json(cities);
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch cities from CSC API" });
  }
});

// Clerk webhook endpoint
app.post("/webhooks/clerk", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret || secret === "REPLACE_ME") {
    return res.status(500).json({ error: "CLERK_WEBHOOK_SECRET not set" });
  }
  if (!pool) {
    return res.status(500).json({ error: "DATABASE_URL not set" });
  }

  const svix_id = req.headers["svix-id"];
  const svix_timestamp = req.headers["svix-timestamp"];
  const svix_signature = req.headers["svix-signature"];

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return res.status(400).json({ error: "Missing Svix headers" });
  }

  let evt;
  try {
    const wh = new Webhook(secret);
    evt = wh.verify(req.body, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    });
  } catch {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const { type, data } = evt;

  try {
    if (type === "user.created" || type === "user.updated") {
      const clerkUserId = data.id;
      const primaryEmail = (data.email_addresses || []).find(
        (e) => e.id === data.primary_email_address_id
      );
      const email = primaryEmail ? primaryEmail.email_address : null;
      const imageUrl = data.image_url || null;
      const firstName = data.first_name || null;
      const lastName = data.last_name || null;

      await pool.query(
        `INSERT INTO users (clerk_user_id, email, image_url, first_name, last_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (clerk_user_id)
         DO UPDATE SET email = EXCLUDED.email,
                       image_url = EXCLUDED.image_url,
                       first_name = EXCLUDED.first_name,
                       last_name = EXCLUDED.last_name,
                       updated_at = NOW()`,
        [clerkUserId, email, imageUrl, firstName, lastName]
      );
    }

    if (type === "user.deleted") {
      const clerkUserId = data.id;
      await pool.query("DELETE FROM users WHERE clerk_user_id = $1", [clerkUserId]);
    }
  } catch {
    return res.status(500).json({ error: "Database error" });
  }

  res.json({ received: true });
});

app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
