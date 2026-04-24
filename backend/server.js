import express from "express";
import { Pool } from "pg";
import { Webhook } from "svix";
import dotenv from "dotenv";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { createStore } from "./data/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT_DIR = path.resolve(__dirname, "..");
const FRONTEND_ASSET_DIRS = ["css", "js", "images", "fonts", "_next", "Screenshots"];

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: false });

const app = express();
const port = process.env.PORT || 4000;
const MOCK_AI = String(process.env.MOCK_AI || "").trim().toLowerCase() === "true";
const RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1";
const DB_CONNECTION_TIMEOUT_MS = Number(process.env.DB_CONNECTION_TIMEOUT_MS || 15000);
const DB_IDLE_TIMEOUT_MS = Number(process.env.DB_IDLE_TIMEOUT_MS || 10000);
const DB_QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 12000);
const CLERK_PROFILE_TIMEOUT_MS = Number(process.env.CLERK_PROFILE_TIMEOUT_MS || 8000);
const GEMINI_CACHE_TTL_MS = Number(process.env.GEMINI_CACHE_TTL_MS || 30 * 60 * 1000);
const geminiSectionCache = new Map();
const geminiFeasibilityCache = new Map();

// Vercel serverless functions can surface the request path without the "/api" prefix.
// Normalize only in Vercel-like runtimes so the same Express routes work locally and in production.
const isVercelRuntime = Boolean(
  String(
    process.env.VERCEL ||
      process.env.VERCEL_URL ||
      process.env.VERCEL_ENV ||
      process.env.VERCEL_REGION ||
      ""
  ).trim()
);

if (isVercelRuntime) {
  app.use((req, _res, next) => {
    const originalUrl = String(req.originalUrl || "");
    const currentUrl = String(req.url || "");
    const url = originalUrl.startsWith("/api/") ? originalUrl : currentUrl;
    if (url && url !== "/" && !url.startsWith("/api/")) {
      req.url = `/api${url.startsWith("/") ? url : `/${url}`}`;
    } else if (originalUrl.startsWith("/api/") && currentUrl !== originalUrl) {
      req.url = originalUrl;
    }
    next();
  });
}

const allowedOrigins = String(
  process.env.CORS_ORIGINS ||
    "http://localhost:4000,http://127.0.0.1:4000"
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
  const poolOptions = {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: Number.isFinite(DB_CONNECTION_TIMEOUT_MS) && DB_CONNECTION_TIMEOUT_MS > 0
      ? DB_CONNECTION_TIMEOUT_MS
      : 15000,
    idleTimeoutMillis: Number.isFinite(DB_IDLE_TIMEOUT_MS) && DB_IDLE_TIMEOUT_MS > 0
      ? DB_IDLE_TIMEOUT_MS
      : 10000,
    max: Number.isFinite(Number(process.env.DB_POOL_MAX))
      ? Math.max(1, Number(process.env.DB_POOL_MAX))
      : 2,
    allowExitOnIdle: true,
  };
  const statementTimeoutMs = Number.isFinite(DB_QUERY_TIMEOUT_MS) && DB_QUERY_TIMEOUT_MS > 0
    ? DB_QUERY_TIMEOUT_MS
    : 12000;
  if (statementTimeoutMs > 0) {
    poolOptions.options = `-c statement_timeout=${statementTimeoutMs}`;
  }
  pool = new Pool({
    ...poolOptions,
  });
}
const store = pool ? createStore({ pool }) : null;

function withTimeout(promise, timeoutMs, label) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      const error = new Error(label || "Operation timed out");
      error.status = 504;
      reject(error);
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

let clerkClient = null;
function getClerkClient() {
  const secretKey = String(process.env.CLERK_SECRET_KEY || "").trim();
  if (!secretKey || secretKey === "REPLACE_ME") return null;
  if (!clerkClient) {
    clerkClient = createClerkClient({ secretKey });
  }
  return clerkClient;
}

function getRazorpayCredentials() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

function getCreditPackConfig() {
  const credits = Number(process.env.RAZORPAY_CREDIT_PACK_CREDITS || 5);
  const amountSubunits = Number.parseInt(
    String(process.env.RAZORPAY_CREDIT_PACK_AMOUNT || "25000"),
    10
  );
  const currency = String(process.env.RAZORPAY_CREDIT_PACK_CURRENCY || "INR")
    .trim()
    .toUpperCase();

  return {
    credits: Number.isFinite(credits) && credits > 0 ? credits : 5,
    amountSubunits:
      Number.isInteger(amountSubunits) && amountSubunits > 0 ? amountSubunits : 25000,
    currency: currency || "INR",
  };
}

function buildRazorpayBasicAuth(credentials) {
  return `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`;
}

async function razorpayApiRequest(method, endpoint, payload) {
  const credentials = getRazorpayCredentials();
  if (!credentials) {
    throw new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set");
  }

  const headers = {
    Authorization: buildRazorpayBasicAuth(credentials),
    Accept: "application/json",
  };

  const options = {
    method,
    headers,
  };

  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }

  const response = await fetch(`${RAZORPAY_API_BASE_URL}${endpoint}`, options);
  const raw = await response.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const detail =
      data && data.error && data.error.description
        ? String(data.error.description)
        : raw || `Razorpay request failed with status ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  return data;
}

function signaturesMatch(expected, received) {
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  const receivedBuffer = Buffer.from(String(received || ""), "utf8");
  if (!expectedBuffer.length || expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function ensurePaymentTables() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_receipts (
      id UUID PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      credit_transaction_id UUID REFERENCES credit_transactions(id) ON DELETE SET NULL,
      provider TEXT NOT NULL DEFAULT 'razorpay',
      razorpay_order_id TEXT UNIQUE,
      razorpay_payment_id TEXT UNIQUE NOT NULL,
      razorpay_signature TEXT,
      amount_subunits BIGINT NOT NULL DEFAULT 0,
      currency TEXT DEFAULT 'INR',
      credits_added NUMERIC(6,2) NOT NULL DEFAULT 0,
      status TEXT,
      method TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
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

function isLikelyAssetPath(requestPath) {
  const pathname = String(requestPath || "");
  if (!pathname) return false;

  const isFromAssetDir = FRONTEND_ASSET_DIRS.some(
    (dir) => pathname === `/${dir}` || pathname.startsWith(`/${dir}/`)
  );
  if (isFromAssetDir) return true;

  const ext = path.extname(pathname).toLowerCase();
  return !!ext && ext !== ".html";
}

function deriveNotFoundPageTitle(requestPath) {
  const pathname = String(requestPath || "").trim();
  if (!pathname || pathname === "/") {
    return "Yatrify - Your Smart Travel Planner";
  }

  const cleanPath = pathname.split("?")[0].split("#")[0];
  const normalized = cleanPath.replace(/\/+$/, "");
  const slug = path.basename(normalized).replace(/\.html$/i, "");

  const knownTitles = {
    dashboard: "Dashboard - Yatrify",
    index: "Yatrify - Your Smart Travel Planner",
    "newplan": "Create Plan - Yatrify",
    "generated-plan": "Generated Plan - Yatrify",
  };

  if (knownTitles[slug]) return knownTitles[slug];
  if (!slug) return "Yatrify - Your Smart Travel Planner";

  const prettyTitle = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

  return prettyTitle ? `${prettyTitle} - Yatrify` : "Yatrify - Your Smart Travel Planner";
}

function sendFrontendNotFoundPage(res, options) {
  const details = options && typeof options === "object" ? options : {};
  const scenario = String(details.scenario || "MISTYPED_URL").trim().toUpperCase();
  const resource = String(details.resource || "").trim();
  const pageTitle = String(
    details.pageTitle || deriveNotFoundPageTitle(details.requestPath || resource)
  ).trim();

  const renderOptions = {
    scenario,
    resource,
    pageTitle,
    replaceBody: true,
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle || "Yatrify")}</title>
  <link rel="icon" href="/images/favicon.ico?v=20260408" type="image/x-icon">
</head>
<body>
  <noscript>This page needs JavaScript enabled to show the custom 404 design.</noscript>
  <script src="/js/error-page.js"></script>
  <script>
    (function () {
      var options = ${JSON.stringify(renderOptions)};
      if (window.YatrifyErrorPage && typeof window.YatrifyErrorPage.render === "function") {
        window.YatrifyErrorPage.render(options);
      }
    })();
  </script>
</body>
</html>`;

  return res.status(404).type("html").send(html);
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
    const logoPath = path.resolve(__dirname, "../images/logo_light.svg");
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

  if (!isLocalBase && base) return normalizeInviteLogoUrl(`${base}/images/logo_light.svg`);

  const inlineLogo = getInviteLogoDataUri();
  if (inlineLogo) return inlineLogo;

  return base ? normalizeInviteLogoUrl(`${base}/images/logo_light.svg`) : "";
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
      "http://localhost:4000"
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

function buildContactSubmissionEmailHtml(options = {}) {
  const submittedAt = String(options.submittedAt || new Date().toISOString()).trim();
  const name = String(options.name || "").trim();
  const email = String(options.email || "").trim();
  const subject = String(options.subject || "General Inquiry").trim();
  const message = String(options.message || "").trim();
  const pageUrl = String(options.pageUrl || "").trim();
  const ipAddress = String(options.ipAddress || "").trim();
  const userAgent = String(options.userAgent || "").trim();

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\r?\n/g, "<br />");
  const safeSubmittedAt = escapeHtml(submittedAt);
  const safePageUrl = escapeHtml(pageUrl);
  const safeIpAddress = escapeHtml(ipAddress);
  const safeUserAgent = escapeHtml(userAgent);

  return (
    `<!doctype html>` +
    `<html><body style="margin:0;padding:18px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">` +
    `<table role="presentation" width="560" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">` +
    `<tr><td style="font-size:22px;font-weight:700;color:#0f172a;padding-bottom:6px;">New Contact Form Submission</td></tr>` +
    `<tr><td style="font-size:13px;line-height:1.6;color:#64748b;padding-bottom:18px;">A visitor submitted the Yatrify contact form.</td></tr>` +
    `<tr><td style="padding-bottom:18px;">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">` +
    `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;">Name</td><td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${safeName}</td></tr>` +
    `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;">Email</td><td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;"><a href="mailto:${safeEmail}" style="color:#2563eb;text-decoration:none;">${safeEmail}</a></td></tr>` +
    `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;">Subject</td><td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${safeSubject}</td></tr>` +
    `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;">Submitted</td><td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${safeSubmittedAt}</td></tr>` +
    (safePageUrl
      ? `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;">Page</td><td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${safePageUrl}</td></tr>`
      : "") +
    (safeIpAddress
      ? `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;">IP Address</td><td style="padding:8px 0;font-size:14px;color:#0f172a;border-bottom:1px solid #e2e8f0;">${safeIpAddress}</td></tr>`
      : "") +
    (safeUserAgent
      ? `<tr><td style="width:140px;padding:8px 0;font-size:12px;font-weight:700;color:#475569;">User Agent</td><td style="padding:8px 0;font-size:14px;color:#0f172a;">${safeUserAgent}</td></tr>`
      : "") +
    `</table>` +
    `</td></tr>` +
    `<tr><td style="font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#475569;padding-bottom:8px;">Message</td></tr>` +
    `<tr><td style="font-size:14px;line-height:1.7;color:#0f172a;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;">${safeMessage}</td></tr>` +
    `</table></td></tr></table>` +
    `</body></html>`
  );
}

function normalizeContactSubject(value) {
  const key = String(value || "").trim().toLowerCase();
  const subjectMap = {
    general: "General Inquiry",
    support: "Technical Support",
    billing: "Billing & Payments",
    partnership: "Partnership Inquiry",
    feedback: "Feedback & Suggestions",
    bug: "Report a Bug",
    other: "Other",
  };
  return subjectMap[key] || String(value || "").trim() || "General Inquiry";
}

function parseBrevoListIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number.parseInt(String(item || "").trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
}

async function sendContactSubmissionEmail(options = {}) {
  const brevoApiKey = String(process.env.BREVO_API_KEY || "").trim();
  if (!brevoApiKey) {
    return { sent: false, skipped: true, reason: "BREVO_API_KEY not configured" };
  }

  const fromEmail = String(process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || "").trim();
  const fromName = String(process.env.BREVO_FROM_NAME || "Yatrify").trim();
  const toEmail = String(process.env.CONTACT_FORM_TO_EMAIL || "support.yatrify@gmail.com").trim().toLowerCase();
  if (!fromEmail) {
    return { sent: false, skipped: true, reason: "BREVO_FROM_EMAIL not configured" };
  }
  if (!toEmail) {
    return { sent: false, skipped: true, reason: "CONTACT_FORM_TO_EMAIL not configured" };
  }

  const name = String(options.name || "").trim();
  const email = String(options.email || "").trim();
  const subject = normalizeContactSubject(options.subject);
  const message = String(options.message || "").trim();
  if (!name || !email || !subject || !message) {
    return { sent: false, skipped: true, reason: "Missing name, email, subject, or message" };
  }

  const submittedAt = String(options.submittedAt || new Date().toISOString()).trim();
  const pageUrl = String(options.pageUrl || "").trim();
  const ipAddress = String(options.ipAddress || "").trim();
  const userAgent = String(options.userAgent || "").trim();

  const emailSubject = `[Yatrify Contact] ${subject} - ${name}`;
  const text = [
    "New contact form submission",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Subject: ${subject}`,
    `Submitted: ${submittedAt}`,
    pageUrl ? `Page: ${pageUrl}` : "",
    ipAddress ? `IP Address: ${ipAddress}` : "",
    userAgent ? `User Agent: ${userAgent}` : "",
    "",
    "Message:",
    message,
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildContactSubmissionEmailHtml({
    submittedAt,
    name,
    email,
    subject,
    message,
    pageUrl,
    ipAddress,
    userAgent,
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
      replyTo: { email, name },
      subject: emailSubject,
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

async function subscribeNewsletterEmail(options = {}) {
  const brevoApiKey = String(process.env.BREVO_API_KEY || "").trim();
  if (!brevoApiKey) {
    return { ok: false, skipped: true, reason: "BREVO_API_KEY not configured" };
  }

  const email = String(options.email || "").trim().toLowerCase();
  if (!email) {
    return { ok: false, skipped: true, reason: "Missing email" };
  }

  const newsletterListIds = parseBrevoListIds(
    process.env.BREVO_NEWSLETTER_LIST_IDS || process.env.BREVO_NEWSLETTER_LIST_ID || ""
  );
  const payload = {
    email,
    emailBlacklisted: false,
    smsBlacklisted: true,
    updateEnabled: true,
  };

  if (newsletterListIds.length > 0) {
    payload.listIds = newsletterListIds;
  }

  const response = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "api-key": brevoApiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text().catch(() => "");
  let responseData = {};
  try {
    responseData = raw ? JSON.parse(raw) : {};
  } catch (_) {
    responseData = {};
  }

  if (!response.ok) {
    throw new Error(`Brevo newsletter subscribe failed: ${response.status} ${raw}`);
  }

  return {
    ok: true,
    listIds: newsletterListIds,
    id:
      responseData && (responseData.id || responseData.contactId)
        ? String(responseData.id || responseData.contactId)
        : null,
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
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    setCors(req, res);
  }
  next();
});

app.options("/api/*", (req, res) => {
  setCors(req, res);
  return res.sendStatus(204);
});

app.options("/api", (req, res) => {
  setCors(req, res);
  return res.sendStatus(204);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function isLocalRequestHost(hostValue) {
  const host = String(hostValue || "").trim().toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("0.0.0.0:") ||
    host.startsWith("[::1]:")
  );
}

function createCacheKey(parts) {
  const serialized = JSON.stringify(Array.isArray(parts) ? parts : [parts]);
  return createHash("sha256").update(serialized).digest("hex");
}

function getCachedGeminiValue(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > GEMINI_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedGeminiValue(cache, key, value) {
  cache.set(key, { ts: Date.now(), value });
  return value;
}

app.get("/api/public-config", (req, res) => {
  const razorpayCredentials = getRazorpayCredentials();
  const requestHost = String(req.hostname || req.get("host") || "").trim();
  return res.json({
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    apiBaseUrl: isLocalRequestHost(requestHost) ? "" : (process.env.API_BASE_URL || ""),
    razorpayKeyId: razorpayCredentials ? razorpayCredentials.keyId : "",
    creditPack: getCreditPackConfig(),
  });
});

app.post("/api/contact", express.json(), async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const subject = String(body.subject || "").trim();
  const message = String(body.message || "").trim();
  const pageUrl = String(body.pageUrl || "").trim();

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: "Name, email, subject, and message are required." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  if (name.length > 120 || email.length > 320 || subject.length > 160 || message.length > 5000) {
    return res.status(400).json({ error: "One or more fields exceed the allowed length." });
  }

  try {
    const delivery = await sendContactSubmissionEmail({
      name,
      email,
      subject: normalizeContactSubject(subject),
      message,
      pageUrl,
      submittedAt: new Date().toISOString(),
      ipAddress: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
      userAgent: req.headers["user-agent"] || "",
    });

    if (!delivery.sent) {
      return res.status(503).json({
        error: delivery.reason || "Contact email delivery is not configured.",
      });
    }

    return res.json({ ok: true, id: delivery.id || null });
  } catch (error) {
    console.error("Contact submission failed", error);
    return res.status(500).json({ error: "Unable to send your message right now." });
  }
});

app.post("/api/newsletter/subscribe", express.json(), async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const email = String(body.email || "").trim().toLowerCase();
  const source = String(body.source || "").trim();
  const pageUrl = String(body.pageUrl || "").trim();

  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  if (email.length > 320) {
    return res.status(400).json({ error: "Email exceeds the allowed length." });
  }

  try {
    const subscription = await subscribeNewsletterEmail({
      email,
    });

    if (!subscription.ok) {
      return res.status(503).json({
        error: subscription.reason || "Newsletter signup is not configured.",
      });
    }

    return res.json({
      ok: true,
      id: subscription.id || null,
      listIds: subscription.listIds || [],
    });
  } catch (error) {
    console.error("Newsletter subscribe failed", error);
    return res.status(500).json({ error: "Unable to subscribe right now." });
  }
});

function parseJsonFromText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const cleaned = text
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const normalizeLooseJson = (value) =>
    String(value || "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      try {
        return JSON.parse(normalizeLooseJson(match[0]));
      } catch {
        try {
          return JSON.parse(normalizeLooseJson(cleaned));
        } catch {
          return null;
        }
      }
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

const FREE_PLAN_INCLUDED_CREDITS = 2;

function normalizePlanTier(planTier) {
  const normalized = String(planTier || "").trim().toLowerCase();
  if (normalized === "paid" || normalized === "business") return normalized;
  return "free";
}

function derivePlanTierFromUser(user) {
  if (!user || typeof user !== "object") return "free";
  const explicitPlanTier = normalizePlanTier(user.plan_tier);
  if (explicitPlanTier !== "free") return explicitPlanTier;
  const credits = Number(user.credits || 0);
  return Number.isFinite(credits) && credits > FREE_PLAN_INCLUDED_CREDITS ? "paid" : "free";
}

async function reconcileUserPlanTier(user) {
  if (!user || !user.id) return user;
  const storedPlanTier = normalizePlanTier(user.plan_tier);
  const effectivePlanTier = derivePlanTierFromUser(user);

  if (storedPlanTier !== effectivePlanTier && typeof store.updateUserPlanTier === "function") {
    const updatedUser = await store.updateUserPlanTier(user.id, effectivePlanTier);
    if (updatedUser) return updatedUser;
  }

  if (storedPlanTier === effectivePlanTier && storedPlanTier === user.plan_tier) {
    return user;
  }

  return Object.assign({}, user, { plan_tier: effectivePlanTier });
}

function normalizeOptionalText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function getPrimaryEmailFromClerkUser(clerkUser) {
  if (!clerkUser || typeof clerkUser !== "object") return null;
  const primaryEmail = clerkUser.primaryEmailAddress;
  if (primaryEmail && primaryEmail.emailAddress) {
    return normalizeOptionalText(primaryEmail.emailAddress);
  }
  if (Array.isArray(clerkUser.emailAddresses)) {
    for (let i = 0; i < clerkUser.emailAddresses.length; i += 1) {
      const emailAddress = normalizeOptionalText(
        clerkUser.emailAddresses[i] && clerkUser.emailAddresses[i].emailAddress
      );
      if (emailAddress) return emailAddress;
    }
  }
  return null;
}

function shouldSyncUserProfile(existingUser, authProfile) {
  if (!existingUser) return true;
  if (!existingUser.email || !existingUser.first_name || !existingUser.last_name || !existingUser.image_url) {
    return true;
  }
  if (authProfile.email && authProfile.email !== existingUser.email) return true;
  if (authProfile.firstName && authProfile.firstName !== existingUser.first_name) return true;
  if (authProfile.lastName && authProfile.lastName !== existingUser.last_name) return true;
  return false;
}

async function fetchClerkUserProfile(clerkUserId) {
  const client = getClerkClient();
  if (!client) return null;
  try {
    const clerkUser = await withTimeout(
      client.users.getUser(clerkUserId),
      CLERK_PROFILE_TIMEOUT_MS,
      "Clerk profile request timed out"
    );
    return {
      email: getPrimaryEmailFromClerkUser(clerkUser),
      firstName: normalizeOptionalText(clerkUser.firstName),
      lastName: normalizeOptionalText(clerkUser.lastName),
      imageUrl: normalizeOptionalText(clerkUser.imageUrl),
    };
  } catch (error) {
    console.error("Unable to fetch Clerk profile:", error);
    return null;
  }
}

async function getAuthedUser(req, options = {}) {
  if (!req.auth || !req.auth.clerkUserId) return null;

  const settings = options && typeof options === "object" ? options : {};
  const existing = await store.getUserByClerkId(req.auth.clerkUserId);
  const authProfile = {
    email: normalizeOptionalText(req.auth.email),
    firstName: normalizeOptionalText(req.auth.firstName),
    lastName: normalizeOptionalText(req.auth.lastName),
    imageUrl: null,
  };

  let profile = Object.assign({}, authProfile);
  if (!settings.skipProfileSync && shouldSyncUserProfile(existing, authProfile)) {
    const clerkProfile = await fetchClerkUserProfile(req.auth.clerkUserId);
    if (clerkProfile) {
      profile = {
        email: clerkProfile.email || profile.email,
        firstName: clerkProfile.firstName || profile.firstName,
        lastName: clerkProfile.lastName || profile.lastName,
        imageUrl: clerkProfile.imageUrl || profile.imageUrl,
      };
    }
  }

  const user = await store.ensureUser(req.auth.clerkUserId, profile);
  if (settings.skipPlanTierReconcile) return user;
  return reconcileUserPlanTier(user);
}

function buildFeasibilityPrompt(payload) {
  const data = normalizeGeminiTripPayload(payload || {});
  const themes = normalizePayloadArray(data.themes);
  const accommodation = normalizePayloadArray(data.accommodation);
  const food = normalizePayloadArray(data.food);
  const transport = normalizePayloadArray(data.transport);
  const landmarkHints = getDestinationLandmarkHints(data.destination);
  const exactDestinationRule = String(data.destination || "").trim()
    ? `Use the destination exactly as entered: ${String(data.destination).trim()}. If it includes a country or region, do not swap it for a more famous same-named place elsewhere.`
    : "Use the destination exactly as entered and do not normalize it into a different place with the same name.";

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
    `- ${exactDestinationRule}`,
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

const BUDGET_ALLOCATION_BLUEPRINT = [
  { group: "essentials", id: "accommodation", label: "Accommodation", pct: 33 },
  { group: "essentials", id: "food", label: "Food", pct: 13 },
  { group: "essentials", id: "insurance", label: "Insurance", pct: 1 },
  { group: "essentials", id: "contingency", label: "Contingency", pct: 7 },
  { group: "activities", id: "activitiesIncluded", label: "Activities Included", pct: 6 },
  { group: "activities", id: "activitiesOptional", label: "Activities Optional", pct: 8 },
  { group: "transport", id: "travelStartReturn", label: "Travel Start/Return", pct: 22 },
  { group: "transport", id: "intercityTransport", label: "Intercity Transport", pct: 6 },
  { group: "transport", id: "intracityTransport", label: "Intracity Transport", pct: 4 },
  { group: "transport", id: "visa", label: "Visa", pct: 0 },
];

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric));
}

function allocateBudgetByBlueprint(totalBudget) {
  const normalizedTotal = toNonNegativeInteger(totalBudget);
  if (!normalizedTotal) {
    return BUDGET_ALLOCATION_BLUEPRINT.map((entry) => ({
      id: entry.id,
      amount: 0,
    }));
  }

  const rawShares = BUDGET_ALLOCATION_BLUEPRINT.map((entry) => {
    const exact = (normalizedTotal * Number(entry.pct || 0)) / 100;
    const base = Math.floor(exact);
    return {
      id: entry.id,
      base,
      fraction: exact - base,
      pct: Number(entry.pct || 0),
    };
  });
  let used = rawShares.reduce((sum, item) => sum + item.base, 0);
  let remainder = Math.max(0, normalizedTotal - used);

  rawShares
    .slice()
    .sort((left, right) => {
      if (right.fraction !== left.fraction) return right.fraction - left.fraction;
      if (right.pct !== left.pct) return right.pct - left.pct;
      return String(left.id).localeCompare(String(right.id));
    })
    .forEach((item) => {
      if (remainder <= 0) return;
      const target = rawShares.find((entry) => entry.id === item.id);
      if (!target) return;
      target.base += 1;
      remainder -= 1;
    });

  used = rawShares.reduce((sum, item) => sum + item.base, 0);
  if (used !== normalizedTotal) {
    const delta = normalizedTotal - used;
    if (rawShares.length) {
      rawShares[0].base = Math.max(0, rawShares[0].base + delta);
    }
  }

  return rawShares.map((item) => ({
    id: item.id,
    amount: Math.max(0, Math.round(item.base)),
  }));
}

function buildBudgetRangeFromTotals(minValue, maxValue, currencyCode) {
  const minBudget = toNonNegativeInteger(minValue);
  const maxBudget = Math.max(minBudget, toNonNegativeInteger(maxValue));
  const minSplit = allocateBudgetByBlueprint(minBudget);
  const maxSplit = allocateBudgetByBlueprint(maxBudget);
  const currency = String(currencyCode || "INR").trim().toUpperCase() || "INR";

  const minMap = {};
  const maxMap = {};
  minSplit.forEach((item) => {
    minMap[item.id] = toNonNegativeInteger(item.amount);
  });
  maxSplit.forEach((item) => {
    maxMap[item.id] = toNonNegativeInteger(item.amount);
  });

  const output = {
    currency,
    essentials: [],
    activities: [],
    transport: [],
  };
  BUDGET_ALLOCATION_BLUEPRINT.forEach((entry) => {
    const minAmount = toNonNegativeInteger(minMap[entry.id]);
    const maxAmount = Math.max(minAmount, toNonNegativeInteger(maxMap[entry.id]));
    output[entry.group].push({
      id: entry.id,
      label: entry.label,
      pct: Number(entry.pct || 0),
      min: minAmount,
      max: maxAmount,
    });
  });
  return output;
}

function normalizeBudgetRangeSeed(rawSeed, fallbackCurrency) {
  if (!rawSeed || typeof rawSeed !== "object") return null;
  const currency = String(rawSeed.currency || fallbackCurrency || "INR").trim().toUpperCase() || "INR";
  const idToEntry = {};
  ["essentials", "activities", "transport"].forEach((group) => {
    const list = Array.isArray(rawSeed[group]) ? rawSeed[group] : [];
    list.forEach((item) => {
      const id = String(item && item.id ? item.id : "").trim();
      if (!id) return;
      idToEntry[id] = {
        id,
        label: String(item && item.label ? item.label : "").trim(),
        pct: toNonNegativeInteger(item && item.pct),
        min: toNonNegativeInteger(item && item.min),
        max: toNonNegativeInteger(item && item.max),
      };
    });
  });

  const hasAnySupported = BUDGET_ALLOCATION_BLUEPRINT.some((entry) => !!idToEntry[entry.id]);
  if (!hasAnySupported) return null;

  const output = {
    currency,
    essentials: [],
    activities: [],
    transport: [],
  };
  BUDGET_ALLOCATION_BLUEPRINT.forEach((entry) => {
    const seeded = idToEntry[entry.id];
    const minAmount = seeded ? seeded.min : 0;
    const maxAmount = seeded ? Math.max(seeded.max, minAmount) : minAmount;
    output[entry.group].push({
      id: entry.id,
      label: seeded && seeded.label ? seeded.label : entry.label,
      pct: seeded && Number.isFinite(Number(seeded.pct)) ? Number(seeded.pct) : Number(entry.pct),
      min: minAmount,
      max: maxAmount,
    });
  });
  return output;
}

function extractBudgetRangeSeedFromRequest(rawInput, normalizedPayload) {
  const body = rawInput && typeof rawInput === "object" ? rawInput : {};
  const fallbackCurrency = String(
    (normalizedPayload && normalizedPayload.currency) || body.currency || "INR"
  ).trim().toUpperCase();

  const explicitSeed = normalizeBudgetRangeSeed(body.budgetRangeSeed, fallbackCurrency);
  if (explicitSeed) return explicitSeed;
  return null;
}

function extractBudgetGuidanceFromRequest(rawInput, normalizedPayload) {
  const body = rawInput && typeof rawInput === "object" ? rawInput : {};
  const feasibility =
    body.feasibility && typeof body.feasibility === "object"
      ? body.feasibility
      : body.step4Data && typeof body.step4Data === "object"
        ? body.step4Data
        : null;
  if (!feasibility) return null;

  let minValue = Number(feasibility.suggestedBudgetMin);
  if (!Number.isFinite(minValue)) minValue = Number(feasibility.budgetMin);
  let maxValue = Number(feasibility.suggestedBudgetMax);
  if (!Number.isFinite(maxValue)) maxValue = Number(feasibility.budgetMax);

  if (!Number.isFinite(minValue) && !Number.isFinite(maxValue)) return null;
  if (!Number.isFinite(minValue)) minValue = maxValue;
  if (!Number.isFinite(maxValue)) maxValue = minValue;

  const normalizedMin = toNonNegativeInteger(minValue);
  const normalizedMax = Math.max(normalizedMin, toNonNegativeInteger(maxValue));
  const currency = String(
    feasibility.currency ||
    (normalizedPayload && normalizedPayload.currency) ||
    body.currency ||
    "INR"
  ).trim().toUpperCase() || "INR";

  return {
    currency,
    suggestedBudgetMin: normalizedMin,
    suggestedBudgetMax: normalizedMax,
  };
}

function normalizeBudgetRangePercentages(rawBudgetRange, fallbackCurrency) {
  const normalized = normalizeBudgetRangeSeed(rawBudgetRange, fallbackCurrency || "INR");
  if (!normalized) return null;

  const entries = [];
  ["essentials", "activities", "transport"].forEach((group) => {
    const list = Array.isArray(normalized[group]) ? normalized[group] : [];
    list.forEach((item) => {
      const minAmount = toNonNegativeInteger(item.min);
      const maxAmount = Math.max(minAmount, toNonNegativeInteger(item.max));
      const midpoint = (minAmount + maxAmount) / 2;
      entries.push({
        item,
        midpoint,
        base: 0,
        fraction: 0,
      });
    });
  });

  const totalMidpoint = entries.reduce((sum, entry) => sum + entry.midpoint, 0);
  if (totalMidpoint <= 0) {
    entries.forEach((entry) => {
      entry.item.pct = 0;
    });
    return normalized;
  }

  entries.forEach((entry) => {
    const exact = (entry.midpoint * 100) / totalMidpoint;
    entry.base = Math.max(0, Math.floor(exact));
    entry.fraction = exact - entry.base;
  });

  let used = entries.reduce((sum, entry) => sum + entry.base, 0);
  let remainder = Math.max(0, 100 - used);
  entries
    .slice()
    .sort((left, right) => {
      if (right.fraction !== left.fraction) return right.fraction - left.fraction;
      if (right.midpoint !== left.midpoint) return right.midpoint - left.midpoint;
      return String(left.item && left.item.id || "").localeCompare(String(right.item && right.item.id || ""));
    })
    .forEach((entry) => {
      if (remainder <= 0) return;
      entry.base += 1;
      remainder -= 1;
    });

  used = entries.reduce((sum, entry) => sum + entry.base, 0);
  if (entries.length && used !== 100) {
    entries[0].base = Math.max(0, entries[0].base + (100 - used));
  }

  entries.forEach((entry) => {
    entry.item.pct = toNonNegativeInteger(entry.base);
  });

  return normalized;
}

function normalizeBudgetLocationParts(value, fallbackCity, fallbackCountry) {
  const text = String(value || "").trim();
  if (!text) {
    return {
      city: fallbackCity,
      country: fallbackCountry,
      full: fallbackCountry ? `${fallbackCity}, ${fallbackCountry}` : fallbackCity,
    };
  }
  const parts = text
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const city = parts[0] || fallbackCity;
  const country = parts.length > 1 ? parts[parts.length - 1] : fallbackCountry;
  return {
    city,
    country,
    full: parts.length > 1 ? parts.join(", ") : (country ? `${city}, ${country}` : city),
  };
}

function normalizeBudgetToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePassengerCountsFromText(label) {
  const text = String(label || "").toLowerCase();
  const counts = { adults: 1, children: 0, infants: 0 };
  const adults = text.match(/(\d+)\s*adult/);
  const children = text.match(/(\d+)\s*child/);
  const infants = text.match(/(\d+)\s*infant/);
  if (adults) counts.adults = Math.max(1, toNonNegativeInteger(adults[1]));
  if (children) counts.children = Math.max(0, toNonNegativeInteger(children[1]));
  if (infants) counts.infants = Math.max(0, toNonNegativeInteger(infants[1]));
  return counts;
}

function parseBudgetAmount(value) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[, ]+/g, "");
  if (!text) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)(k|m|l|lac|lakh|cr|crore)?/i);
  if (!match) return 0;
  let amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = String(match[2] || "").toLowerCase();
  if (suffix === "k") amount *= 1e3;
  else if (suffix === "m") amount *= 1e6;
  else if (suffix === "l" || suffix === "lac" || suffix === "lakh") amount *= 1e5;
  else if (suffix === "cr" || suffix === "crore") amount *= 1e7;
  return Math.max(0, Math.round(amount));
}

function getHotelFactorFromTrip(accommodation) {
  const text = normalizePayloadArray(accommodation).join(" ").toLowerCase();
  if (/(luxury|premium|resort|villa|suite|5)/i.test(text)) return 1.48;
  if (/(boutique|comfort|standard|4|mid)/i.test(text)) return 1.16;
  if (/(hostel|budget|dorm|guesthouse|homestay|3)/i.test(text)) return 0.9;
  return 1.02;
}

function getFoodFactorFromTrip(food) {
  const text = normalizePayloadArray(food).join(" ").toLowerCase();
  if (/(fine|dine|premium|upscale|gourmet)/i.test(text)) return 1.28;
  if (/(local|street|simple|budget|economy)/i.test(text)) return 0.84;
  if (/(balanced|mixed|family|casual)/i.test(text)) return 0.98;
  return 1.0;
}

function getActivityFactorFromTrip(themes, pace, preferences) {
  const themeCount = normalizePayloadArray(themes).length;
  const text = `${pace || ""} ${preferences || ""}`.toLowerCase();
  let factor = 1 + Math.min(0.2, themeCount * 0.04);
  if (/(slow|relaxed|leisure)/i.test(text)) factor -= 0.04;
  if (/(fast|packed|busy|adventure|intense)/i.test(text)) factor += 0.07;
  return Math.min(1.32, Math.max(0.9, factor));
}

function getTransportModeFromTrip(transport, isInternational) {
  const transportText = normalizePayloadArray(transport).map((value) => String(value || "").toLowerCase());
  const hasFlight = transportText.some((value) => value.indexOf("flight") !== -1 || value.indexOf("plane") !== -1 || value.indexOf("air") !== -1);
  const hasTrain = transportText.some((value) => value.indexOf("train") !== -1 || value.indexOf("rail") !== -1);
  const hasBus = transportText.some((value) => value.indexOf("bus") !== -1);
  const hasRoad = transportText.some((value) => value.indexOf("road") !== -1 || value.indexOf("car") !== -1 || value.indexOf("drive") !== -1 || value.indexOf("cab") !== -1 || value.indexOf("taxi") !== -1);

  if (hasFlight) return "flight";
  if (hasTrain) return "train";
  if (hasBus) return "bus";
  if (hasRoad) return "road";
  return isInternational ? "flight" : "train";
}

function getVisaEstimateBand(countryText) {
  const text = normalizeBudgetToken(countryText);
  if (!text) return { min: 4000, max: 14000 };
  if (/^(india|bharat)$/.test(text)) return { min: 0, max: 0 };
  if (/(nepal|bhutan)/.test(text)) return { min: 0, max: 1200 };
  if (/(maldives|sri lanka|srilanka)/.test(text)) return { min: 1200, max: 4500 };
  if (/(singapore|malaysia|thailand|vietnam|indonesia|philippines|cambodia|laos|myanmar|brunei)/.test(text)) return { min: 1800, max: 6500 };
  if (/(uae|united arab emirates|dubai|qatar|saudi arabia|bahrain|kuwait|oman)/.test(text)) return { min: 2500, max: 9000 };
  if (/(uk|united kingdom|england|scotland|wales|europe|schengen|france|germany|italy|spain|switzerland|netherlands|greece|portugal|austria|belgium|denmark|finland|sweden|norway|iceland|ireland|poland|czech|hungary|croatia)/.test(text)) {
    return { min: 5000, max: 18000 };
  }
  if (/(usa|united states|canada|australia|new zealand|japan|south korea|korea|taiwan|hong kong|macau)/.test(text)) {
    return { min: 6000, max: 22000 };
  }
  if (/(south africa|egypt|kenya|morocco|tanzania|uganda|zambia|zimbabwe|botswana|namibia|mauritius)/.test(text)) {
    return { min: 4500, max: 16000 };
  }
  if (/(brazil|argentina|chile|peru|colombia|mexico|panama|costa rica)/.test(text)) {
    return { min: 5000, max: 17000 };
  }
  return { min: 4000, max: 14000 };
}

function isInternationalTripFromPayload(trip) {
  const origin = normalizeBudgetLocationParts(trip.startCity, "Origin City", "Origin Country");
  const destination = normalizeBudgetLocationParts(trip.destination, "Destination City", "Destination Country");
  const originCountry = normalizeBudgetToken(origin.country);
  const destinationCountry = normalizeBudgetToken(destination.country);
  const placeholderCountry = /^(origin country|destination country|country|not specified|unknown|n\/a)$/i;
  const originKnown = !!originCountry && !placeholderCountry.test(String(origin.country || ""));
  const destinationKnown = !!destinationCountry && !placeholderCountry.test(String(destination.country || ""));
  if (originKnown && destinationKnown) return originCountry !== destinationCountry;
  return false;
}

function scaleBudgetModelToTargets(model, targetMinTotal, targetMaxTotal) {
  const normalized = normalizeBudgetRangeSeed(model, "INR");
  if (!normalized) return null;

  const items = [];
  ["essentials", "activities", "transport"].forEach((group) => {
    (Array.isArray(normalized[group]) ? normalized[group] : []).forEach((item) => {
      items.push(item);
    });
  });

  const rawMinTotal = items.reduce((sum, item) => sum + toNonNegativeInteger(item.min), 0);
  const rawMaxTotal = items.reduce((sum, item) => sum + toNonNegativeInteger(item.max), 0);
  if (rawMinTotal > 0 && Number.isFinite(Number(targetMinTotal)) && Number(targetMinTotal) > 0) {
    const minScale = Number(targetMinTotal) / rawMinTotal;
    items.forEach((item) => {
      item.min = Math.max(0, Math.round(toNonNegativeInteger(item.min) * minScale));
    });
  }
  if (rawMaxTotal > 0 && Number.isFinite(Number(targetMaxTotal)) && Number(targetMaxTotal) > 0) {
    const maxScale = Number(targetMaxTotal) / rawMaxTotal;
    items.forEach((item) => {
      item.max = Math.max(item.min, Math.round(toNonNegativeInteger(item.max) * maxScale));
    });
  }
  return normalized;
}

function buildRealisticBudgetRange(trip, budgetGuidance) {
  const normalizedTrip = normalizeGeminiTripPayload(trip || {});
  const passengerCounts = parsePassengerCountsFromText(normalizedTrip.passengers || "1 adult");
  const travelerCount = Math.max(1, passengerCounts.adults + passengerCounts.children + passengerCounts.infants);
  const days = Math.max(1, Number(normalizedTrip.totalDays) || 1);
  const isInternational = isInternationalTripFromPayload(normalizedTrip);
  const mode = getTransportModeFromTrip(normalizedTrip.transport, isInternational);
  const hotelFactor = getHotelFactorFromTrip(normalizedTrip.accommodation);
  const foodFactor = getFoodFactorFromTrip(normalizedTrip.food);
  const activityFactor = getActivityFactorFromTrip(normalizedTrip.themes, normalizedTrip.pace, normalizedTrip.preferences);

  const accommodationMin = travelerCount * days * (isInternational ? 3600 : 1800) * hotelFactor;
  const accommodationMax = travelerCount * days * (isInternational ? 7600 : 3800) * hotelFactor;
  const foodMin = travelerCount * days * (isInternational ? 1200 : 550) * foodFactor;
  const foodMax = travelerCount * days * (isInternational ? 3000 : 1500) * foodFactor;
  const insuranceMin = travelerCount * (isInternational ? 1400 : 450);
  const insuranceMax = travelerCount * (isInternational ? 5200 : 1500);
  const activitiesIncludedMin = travelerCount * days * (isInternational ? 700 : 280) * activityFactor;
  const activitiesIncludedMax = travelerCount * days * (isInternational ? 1800 : 900) * activityFactor;
  const activitiesOptionalMin = travelerCount * days * (isInternational ? 1000 : 420) * activityFactor;
  const activitiesOptionalMax = travelerCount * days * (isInternational ? 2600 : 1500) * activityFactor;

  const startReturnBase = {
    flight: isInternational ? [18000, 65000] : [5500, 22000],
    train: isInternational ? [6000, 18000] : [1200, 9000],
    bus: isInternational ? [2500, 9000] : [700, 4500],
    road: isInternational ? [3200, 11000] : [1200, 5500],
  }[mode] || (isInternational ? [12000, 35000] : [2500, 12000]);
  const travelStartReturnMin = travelerCount * startReturnBase[0];
  const travelStartReturnMax = travelerCount * startReturnBase[1];

  const intercityBase = {
    flight: isInternational ? [700, 2200] : [280, 1200],
    train: isInternational ? [500, 1600] : [220, 1000],
    bus: isInternational ? [420, 1400] : [180, 850],
    road: isInternational ? [450, 1500] : [200, 900],
  }[mode] || [250, 950];
  const intercityDays = Math.max(0, days - 1);
  const intercityTransportMin = travelerCount * intercityDays * intercityBase[0];
  const intercityTransportMax = travelerCount * Math.max(1, intercityDays || 1) * intercityBase[1];

  const intracityBase = isInternational ? [550, 1600] : [220, 950];
  const intracityTransportMin = travelerCount * days * intracityBase[0];
  const intracityTransportMax = travelerCount * days * intracityBase[1];

  const visaBand = isInternational ? getVisaEstimateBand(normalizedTrip.destination) : { min: 0, max: 0 };
  const visaMin = travelerCount * visaBand.min;
  const visaMax = travelerCount * visaBand.max;

  const subtotalMin =
    accommodationMin +
    foodMin +
    insuranceMin +
    activitiesIncludedMin +
    activitiesOptionalMin +
    travelStartReturnMin +
    intercityTransportMin +
    intracityTransportMin +
    visaMin;
  const subtotalMax =
    accommodationMax +
    foodMax +
    insuranceMax +
    activitiesIncludedMax +
    activitiesOptionalMax +
    travelStartReturnMax +
    intercityTransportMax +
    intracityTransportMax +
    visaMax;
  const contingencyMin = Math.max(travelerCount * days * 350, subtotalMin * 0.08);
  const contingencyMax = Math.max(travelerCount * days * 900, subtotalMax * 0.15);

  const rawModel = {
    currency: normalizedTrip.currency || "INR",
    essentials: [
      { id: "accommodation", label: "Accommodation", min: accommodationMin, max: accommodationMax },
      { id: "food", label: "Food", min: foodMin, max: foodMax },
      { id: "insurance", label: "Insurance", min: insuranceMin, max: insuranceMax },
      { id: "contingency", label: "Contingency", min: contingencyMin, max: contingencyMax },
    ],
    activities: [
      { id: "activitiesIncluded", label: "Activities Included", min: activitiesIncludedMin, max: activitiesIncludedMax },
      { id: "activitiesOptional", label: "Activities Optional", min: activitiesOptionalMin, max: activitiesOptionalMax },
    ],
    transport: [
      { id: "travelStartReturn", label: "Travel Start/Return", min: travelStartReturnMin, max: travelStartReturnMax },
      { id: "intercityTransport", label: "Intercity Transport", min: intercityTransportMin, max: intercityTransportMax },
      { id: "intracityTransport", label: "Intracity Transport", min: intracityTransportMin, max: intracityTransportMax },
      { id: "visa", label: "Visa", min: visaMin, max: visaMax },
    ],
  };

  const normalizedBudget = normalizeBudgetRangePercentages(rawModel, normalizedTrip.currency || "INR");
  if (!normalizedBudget) return null;
  normalizedBudget.currency = normalizedTrip.currency || "INR";
  return normalizedBudget;
}

function sumBudgetRangeTotals(budgetRange) {
  const range = budgetRange && typeof budgetRange === "object" ? budgetRange : {};
  let minTotal = 0;
  let maxTotal = 0;
  ["essentials", "activities", "transport"].forEach((group) => {
    const list = Array.isArray(range[group]) ? range[group] : [];
    list.forEach((item) => {
      const minValue = toNonNegativeInteger(item && item.min);
      const maxValue = Math.max(minValue, toNonNegativeInteger(item && item.max));
      minTotal += minValue;
      maxTotal += maxValue;
    });
  });
  return {
    min: Math.max(0, Math.round(minTotal)),
    max: Math.max(Math.max(0, Math.round(minTotal)), Math.round(maxTotal)),
  };
}

function anchorDestinationMentions(text, exactDestinationLabel) {
  const exact = String(exactDestinationLabel || "").trim();
  const source = String(text || "");
  if (!exact) return source;

  const parsed = normalizeBudgetLocationParts(exact, exact, "");
  const city = String(parsed.city || "").trim();
  if (!city || exact.toLowerCase() === city.toLowerCase()) {
    return source;
  }

  const cityPattern = escapeRegExp(city);
  let output = source;
  output = output.replace(
    new RegExp(`\\b${cityPattern}\\s*,\\s*[A-Za-z][A-Za-z\\s.-]{1,40}\\b`, "gi"),
    exact
  );
  output = output.replace(
    new RegExp(`\\b${cityPattern}\\s+[A-Za-z][A-Za-z\\s.-]{1,40}\\b`, "gi"),
    exact
  );
  return output;
}

function anchorDestinationMentionsInValue(value, exactDestinationLabel) {
  if (typeof value === "string") return anchorDestinationMentions(value, exactDestinationLabel);
  if (Array.isArray(value)) return value.map((item) => anchorDestinationMentionsInValue(item, exactDestinationLabel));
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach((key) => {
      out[key] = anchorDestinationMentionsInValue(value[key], exactDestinationLabel);
    });
    return out;
  }
  return value;
}

function buildLocalFeasibilityResult(payload, reasonText) {
  const trip = normalizeGeminiTripPayload(payload || {});
  const budgetRange = buildRealisticBudgetRange(trip, null);
  const totals = sumBudgetRangeTotals(budgetRange);
  const destinationLabel = trip.destination || "your destination";
  const originLabel = trip.startCity || "your origin city";
  const userBudget = Number(trip.budget || 0);
  const landmarkHints = getDestinationLandmarkHints(trip.destination);
  const nearbyHints = landmarkHints.length
    ? landmarkHints.slice(0, 3).map((item) => `${item} day`)
    : [
        `A deeper local-food trail in ${destinationLabel}`,
        `A heritage walk around ${destinationLabel}`,
        `A scenic viewpoint or market experience in ${destinationLabel}`,
      ];

  const budgetReasoning = [
    `Local budget estimate for ${trip.totalDays} day${trip.totalDays > 1 ? "s" : ""} from ${originLabel} to ${destinationLabel} based on trip length, passenger count, accommodation, food, transport, and weather.`,
    userBudget > 0
      ? `Your entered budget of ${trip.currency} ${userBudget.toLocaleString("en-IN")} is used only as a comparison point.`
      : "No entered budget was provided, so the estimate is based entirely on the trip details.",
    "This estimate stays practical even when live AI is unavailable or returns incomplete data.",
    "The numbers are grounded in the category breakdown below so they stay usable for planning.",
  ].join(" ");

  return {
    currency: trip.currency || "INR",
    suggestedBudgetMin: totals.min,
    suggestedBudgetMax: totals.max,
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
  const landmarkHints = getDestinationLandmarkHints(trip.destination);
  const placeLine = landmarkHints.length
    ? `It gives you a natural path through ${dedupeStrings(landmarkHints.slice(0, 3)).join(", ")} while still leaving room for meals, short breaks, and slower local moments.`
    : `It keeps the plan grounded in ${city} with a mix of the main sights, practical transfers, and enough breathing room for meals, short breaks, and unhurried local moments.`;
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
    summary: `This ${trip.totalDays}-day trip from ${origin} to ${city} is shaped around the route, your pace, and the kind of experiences you picked in the form. ${placeLine} Expect a trip that feels organized but still interesting, with the main landmarks and neighborhood stops doing the heavy lifting instead of generic filler.`,
  };
}

function buildMockItineraryDay(trip, dayNumber, totalDays, landmarkHints) {
  const city = trip.destination || "the destination";
  const origin = trip.startCity || "your origin city";
  const firstHint = landmarkHints[0] || `${city} main sights`;
  const secondHint = landmarkHints[1] || firstHint;
  const thirdHint = landmarkHints[2] || secondHint;
  const fourthHint = landmarkHints[3] || thirdHint;
  const dayAnchor = totalDays === 1
    ? "Arrival and orientation"
    : dayNumber === 1
      ? "Arrival and check-in"
      : dayNumber === totalDays
        ? "Wrap-up and departure"
        : dayNumber === 2
          ? "Main sightseeing loop"
          : `Day ${dayNumber} exploration`;
  const theme = landmarkHints[(dayNumber - 1) % Math.max(1, landmarkHints.length)] || `${city} exploration`;
  const anchorName = dayNumber === 1 ? firstHint : dayNumber === totalDays ? thirdHint : theme;
  const secondaryName = dayNumber === 1 ? secondHint : dayNumber === totalDays ? secondHint : fourthHint;
  const transport = normalizePayloadArray(trip.transport).map((value) => String(value || "").toLowerCase());
  const hasFlight = transport.some((value) => value.includes("flight") || value.includes("plane") || value.includes("air"));
  const hasTrain = transport.some((value) => value.includes("train") || value.includes("rail"));
  const hasBus = transport.some((value) => value.includes("bus"));
  const hasRoad = transport.some((value) => value.includes("road") || value.includes("car") || value.includes("drive"));
  const wantsSurface = hasTrain || hasBus || hasRoad;
  const routeText = `${origin} to ${city}`;
  const returnRouteText = `${city} to ${origin}`;
  const stayStyle = trip.accommodation.length ? String(trip.accommodation[0] || "").trim() : "Preferred Stay";
  const quickBookings = [];
  if (dayNumber === 1) {
    if (wantsSurface) {
      if (hasTrain) quickBookings.push(`Search train tickets ${routeText}`);
      else if (hasBus) quickBookings.push(`Search bus tickets ${routeText}`);
      else quickBookings.push(`Book private taxi for ${routeText}`);
    } else if (hasFlight) {
      quickBookings.push(routeText);
    }
  } else if (totalDays > 1 && dayNumber === totalDays) {
    if (wantsSurface) {
      if (hasTrain) quickBookings.push(`Search return train tickets ${returnRouteText}`);
      else if (hasBus) quickBookings.push(`Search return bus tickets ${returnRouteText}`);
      else quickBookings.push(`Book return private taxi for ${returnRouteText}`);
    } else if (hasFlight) {
      quickBookings.push(returnRouteText);
    }
  }
  if (dayNumber === 1) {
    quickBookings.push(`Hotels in ${city}`);
  }
   quickBookings.push(`${theme}`);
  if (dayNumber === 1 && firstHint) quickBookings.push(firstHint);
  if (dayNumber !== 1 && secondaryName) quickBookings.push(secondaryName);
  return {
    dayNumber,
    title: `${dayAnchor} - Day ${dayNumber}`,
    dateLabel: `Day ${dayNumber}`,
    schedule: {
      morning: dayNumber === 1
        ? `Arrive from ${origin}, check in, and keep the morning light with a relaxed breakfast and an easy first stop near ${firstHint}.`
        : dayNumber === totalDays
          ? `Start with a slower breakfast and a short final stop near ${firstHint} before checkout and departure.`
          : `Start with a relaxed breakfast and a first stop near ${anchorName}.`,
      afternoon: dayNumber === 1
        ? `Use the afternoon for an orientation walk, a first landmark, and a practical transfer window around ${secondHint}.`
        : dayNumber === totalDays
          ? `Keep the afternoon open for checkout, a last lunch, and the transfer back toward ${origin}.`
          : `Move through the main sightseeing loop with lunch, a useful transfer window, and time around ${anchorName}.`,
      evening: dayNumber === totalDays
        ? `Use the evening for a final look at ${city} or the airport/station transfer, depending on your return timing.`
        : `Visit a different landmark or market near ${secondaryName} for sunset, photos, or a guided stroll.`,
      night: dayNumber === totalDays
        ? `End the trip with a calm dinner and the return journey toward ${origin}.`
        : `End with a calm dinner and return to your stay after a light evening in ${city}.`,
    },
    foodRecommendations: [
      `${city} local breakfast`,
      `${city} lunch stop`,
      `Dinner near ${city}`,
      `${city} local snack stop`,
    ],
    stayOptions: dayNumber === 1
      ? [
          `Curated ${stayStyle} stays in ${city}`,
          `Best-value ${stayStyle} options in ${city}`,
          `Comfort stays in ${city}`,
        ]
      : [
          `Keep your ${stayStyle} base in ${city}`,
          `Return to your stay in ${city} after the day`,
          `Stay close to your current hotel for an easy evening`,
        ],
    optionalActivities: [
      `Short heritage walk around ${anchorName}`,
      `Local cafe or market stop in ${city}`,
      `Easy scenic break near ${city}`,
    ],
    tip: dayNumber === 1
      ? `Start early so transfers stay easy on the ${routeText} route.`
      : dayNumber === totalDays
        ? `Keep your bags ready and leave a buffer for checkout and the final transfer back toward ${origin}.`
        : `Keep the middle of the day flexible and use the quieter evening hours for ${anchorName}.`,
    quickBookings: dedupeStrings(quickBookings).slice(0, 4),
  };
}

function buildMockPackingChecklist(trip) {
  return buildDestinationPackingChecklist(trip);
}

function buildDestinationPackingChecklist(trip) {
  const normalizedTrip = normalizeGeminiTripPayload(trip || {});
  const location = normalizeBudgetLocationParts(normalizedTrip.destination, "the destination", "");
  const destinationLabel = String(normalizedTrip.destination || location.full || location.city || "the destination").trim();
  const countryText = normalizeBudgetToken(location.country || "");
  const destinationText = normalizeLookupText(destinationLabel);
  const weatherText = normalizeLookupText(normalizedTrip.weather || "");
  const interestsText = normalizeLookupText(normalizePayloadArray(normalizedTrip.themes).join(" "));
  const foodText = normalizeLookupText(normalizePayloadArray(normalizedTrip.food).join(" "));
  const passengersText = normalizeLookupText(normalizedTrip.passengers || "");
  const landmarkHints = getDestinationLandmarkHints(normalizedTrip.destination);
  const contextText = [destinationText, countryText, weatherText, interestsText, normalizeLookupText(landmarkHints.join(" "))].filter(Boolean).join(" ");
  const isPilgrimageTrip = /ayodhya|varanasi|vrindavan|mathura|tirupati|shirdi|haridwar|rishikesh|puri|dwarka|somnath|ujjain|pushkar|ajmer|amritsar|madurai|kedarnath|badrinath|kanchipuram|vaishno|sarnath|guruvayur|temple|pilgrim|sacred|holy/i.test(contextText);
  const items = [];

  const add = (...values) => {
    values.forEach((value) => {
      const text = String(value || "").trim();
      if (text) items.push(text);
    });
  };

  if (/(rain|monsoon|wet|storm|drizzle|waterfall|coast|coastal|island|beach|sea|ocean|tropical)/i.test(contextText)) {
    add(
      "Compact umbrella or rain jacket",
      "Waterproof phone pouch",
      `Quick-dry socks for ${destinationLabel}`,
      `Water-resistant shoes for ${destinationLabel}`
    );
  }

  if (/(cold|snow|winter|therm|frost|mountain|hill|hills|valley|trek|hike|highland|alps|canada|europe|uk|scandinavia|japan|korea|switzerland|ladakh|manali|shimla|darjeeling|ooty|kashmir|sikkim|leh|banff)/i.test(contextText)) {
    add(
      `Thermal layers for ${destinationLabel}`,
      `Warm gloves and beanie for ${destinationLabel}`,
      "Light fleece or sweater",
      "Lip balm and hand cream"
    );
  }

  if (/(hot|summer|sun|desert|safari|arid|dry|beach|coast|coastal|island|tropical|dubai|uae|rajasthan|jaipur|jaisalmer|goa|maldives|sri lanka)/i.test(contextText)) {
    add(
      `Sunscreen and a sun hat for ${destinationLabel}`,
      "Sunglasses with UV protection",
      "Breathable daytime clothing",
      "Electrolyte sachets or a reusable water bottle"
    );
  }

  if (/(beach|coast|coastal|island|ocean|sea|lagoon|resort|watersport)/i.test(contextText)) {
    add(
      `Swimwear for ${destinationLabel}`,
      "Quick-dry towel",
      "Flip-flops or sandals",
      "Dry bag for beach days"
    );
  }

  if (/(temple|heritage|mosque|church|sacred|religious|palace|fort|museum|old town|old city|historic|cultural)/i.test(contextText)) {
    add(
      `Modest outfit or shawl for ${destinationLabel}`,
      "Slip-on shoes for places with footwear checks",
      "Light scarf for indoor visits",
      "Small cash for donations or entry fees"
    );
  }

  if (isPilgrimageTrip) {
    add(
      `Respectful clothing for ${destinationLabel}`,
      `Extra scarf or dupatta for temple visits in ${destinationLabel}`,
      `Socks for shoe-removal spots in ${destinationLabel}`,
      `Printed or offline directions for ${destinationLabel} temples and ghats`
    );
  }

  if (/(market|shopping|city|urban|nightlife|food|street|bazaar|bazar)/i.test(contextText)) {
    add(
      `Comfortable walking shoes for ${destinationLabel}`,
      "Cross-body day bag",
      "Foldable tote for shopping",
      "Portable charger for long city days"
    );
  }

  if (/(forest|nature|wildlife|jungle|safari|trail|trek|hike|viewpoint|valley|waterfall|mountain|hill)/i.test(contextText)) {
    add(
      `Trail shoes or sturdy sneakers for ${destinationLabel}`,
      "Daypack with water bottle sleeve",
      "Quick-dry activewear",
      "Insect repellent"
    );
  }

  if (/(camera|photo|gram|instagram|content|drone)/i.test(contextText)) {
    add(
      "Camera batteries or extra memory card",
      "Phone tripod or selfie stick",
      "Lens cloth"
    );
  }

  if (landmarkHints.some((hint) => /temple|mosque|church|sacred|religious|heritage|palace|fort/i.test(hint))) {
    add("Socks for places with shoe removal rules");
  }

  if (landmarkHints.some((hint) => /beach|coast|waterfall|lake|river|valley|pass|hill|mountain/i.test(hint))) {
    add("Waterproof outer layer or light rain shell");
  }

  if (/vegetarian|vegan|jain|halal|kosher/i.test(foodText)) {
    add("Snack backups that match your food preference");
  }

  add(
    "Passport or ID",
    "Travel tickets and hotel confirmations",
    "Wallet, cards, and some cash",
    "Phone charger and cable",
    "Power bank",
    "Basic medicines and prescriptions",
    "Toiletries kit",
    "Universal travel adapter"
  );

  if (normalizedTrip.totalDays >= 7) {
    add(
      "Travel laundry bag for used clothes",
      "Extra footwear rotation for longer trips"
    );
  }

  if (/child/.test(passengersText)) {
    add("Child travel essentials and small snacks");
  }
  if (/infant/.test(passengersText)) {
    add("Infant care kit and compact wipes");
  }

  if (items.length < 12) {
    add(
      `Light layer for evenings in ${destinationLabel}`,
      `Small day bag for ${destinationLabel}`,
      `Local SIM/eSIM support for ${destinationLabel}`
    );
  }

  return dedupeStrings(items).slice(0, 18);
}

function buildMockGeminiSections(payload, options = {}) {
  const trip = normalizeGeminiTripPayload(payload || {});
  const landmarkHints = getDestinationLandmarkHints(trip.destination);
  const itinerary = [];
  for (let day = 1; day <= trip.totalDays; day += 1) {
    itinerary.push(buildMockItineraryDay(trip, day, trip.totalDays, landmarkHints));
  }

  const budgetRange = buildRealisticBudgetRange(trip, options && options.budgetGuidance ? options.budgetGuidance : null);

  return {
    parsed: {
      tripHighlights: buildMockTripHighlights(trip),
      weatherAnalysis: {
        expectedConditions: `For ${trip.destination || "the destination"}, expect a practical local weather pattern that matches your selected preference. Plan early starts, midday breaks, and lighter evening movement so the day stays comfortable across sightseeing and transfers.`,
        bestTimeToVisit: `The most comfortable part of this trip is usually the window that matches your selected dates and pace. Start early, keep one flexible midday slot, and use evenings for slower sightseeing or food stops if the weather turns warmer or wetter than expected.`,
      },
      itinerary,
      budgetRange: budgetRange,
      budgetRangeSource: "auto",
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
    keys: ["paris, france", "paris france", "france"],
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
    keys: ["ayodhya"],
    places: [
      "Ram Janmabhoomi Temple",
      "Hanuman Garhi",
      "Kanak Bhawan",
      "Sarayu Ghats",
      "Nageshwarnath Temple",
      "Guptar Ghat",
      "Treta Ke Thakur",
      "Dashrath Mahal",
    ],
  },
  {
    keys: ["vrindavan"],
    places: [
      "Banke Bihari Temple",
      "Prem Mandir",
      "ISKCON Vrindavan",
      "Seva Kunj",
      "Nidhivan",
      "Yamuna Ghats",
      "Radha Raman Temple",
      "Kesi Ghat",
    ],
  },
  {
    keys: ["varanasi", "kashi"],
    places: [
      "Dashashwamedh Ghat",
      "Assi Ghat",
      "Kashi Vishwanath Temple",
      "Manikarnika Ghat",
      "Sarnath",
      "Ramnagar Fort",
      "Banaras Hindu University",
      "Ganga Aarti",
    ],
  },
  {
    keys: ["prayagraj", "allahabad"],
    places: [
      "Triveni Sangam",
      "Anand Bhavan",
      "Allahabad Fort",
      "Khusro Bagh",
      "Hanuman Mandir",
      "Minto Park",
      "Patalpuri Temple",
      "Alfred Park",
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
  "explore the city",
  "sightseeing tour",
  "must see places",
  "local attractions",
  "nearby attractions",
  "discover the area",
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

function countNormalizedWords(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

function countParagraphBlocks(value) {
  const text = String(value || "").replace(/\r/g, "").trim();
  if (!text) return 0;
  return text
    .split(/\n\s*\n+/g)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean).length;
}

function countMarkdownBoldPlaceMentions(value) {
  const text = String(value || "");
  const matches = text.match(/\*\*(?=\S)([\s\S]*?\S)\*\*/g);
  return Array.isArray(matches) ? matches.length : 0;
}

function evaluateGeminiSectionsQuality(parsed, payload) {
  const trip = normalizeGeminiTripPayload(payload || {});
  const issues = [];
  const highlights = parsed && parsed.tripHighlights && typeof parsed.tripHighlights === "object"
    ? parsed.tripHighlights
    : {};
  const weather = parsed && parsed.weatherAnalysis && typeof parsed.weatherAnalysis === "object"
    ? parsed.weatherAnalysis
    : {};
  const tripSummaryWords = countNormalizedWords(highlights.summary);
  const tripSummaryParagraphs = countParagraphBlocks(highlights.summary);
  const tripSummaryBoldPlaceMentions = countMarkdownBoldPlaceMentions(highlights.summary);
  const weatherExpectedWords = countNormalizedWords(weather.expectedConditions);
  const weatherBestTimeWords = countNormalizedWords(weather.bestTimeToVisit);
  const minTripSummaryWords = 180;
  const maxTripSummaryWords = 300;
  const minWeatherExpectedWords = Math.min(160, Math.max(80, trip.totalDays * 16));
  const minWeatherBestTimeWords = Math.min(140, Math.max(70, trip.totalDays * 14));
  if (tripSummaryWords < minTripSummaryWords) {
    issues.push(`trip_highlights_too_short:${tripSummaryWords}_of_${minTripSummaryWords}`);
  }
  if (tripSummaryWords > maxTripSummaryWords) {
    issues.push(`trip_highlights_too_long:${tripSummaryWords}_over_${maxTripSummaryWords}`);
  }
  if (tripSummaryParagraphs < 2 || tripSummaryParagraphs > 3) {
    issues.push(`trip_highlights_paragraph_count_invalid:${tripSummaryParagraphs}`);
  }
  if (tripSummaryBoldPlaceMentions > 0) {
    issues.push(`trip_highlights_unwanted_markdown_bold:${tripSummaryBoldPlaceMentions}`);
  }
  if (weatherExpectedWords < minWeatherExpectedWords) {
    issues.push(`weather_expected_too_short:${weatherExpectedWords}_of_${minWeatherExpectedWords}`);
  }
  if (weatherBestTimeWords < minWeatherBestTimeWords) {
    issues.push(`weather_best_time_too_short:${weatherBestTimeWords}_of_${minWeatherBestTimeWords}`);
  }

  const itinerary = Array.isArray(parsed && parsed.itinerary) ? parsed.itinerary : [];
  if (itinerary.length !== trip.totalDays) {
    issues.push(`itinerary_days_mismatch:${itinerary.length}_of_${trip.totalDays}`);
  }

  const dayTitles = [];
  itinerary.forEach((day, index) => {
    if (!day || typeof day !== "object") return;
    const title = String(day.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (title) dayTitles.push(title);
    if (title && /day at leisure|local sightseeing|city tour|explore the city|free time|relax and explore/.test(title)) {
      issues.push(`generic_day_title:${index + 1}`);
    }
  });
  const uniqueDayTitles = dedupeStrings(dayTitles);
  if (dayTitles.length >= 2 && uniqueDayTitles.length < dayTitles.length) {
    issues.push(`repeated_day_titles:${uniqueDayTitles.length}_of_${dayTitles.length}`);
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
  if (genericPhraseHits >= 1) {
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

  const destinationText = String(trip.destination || "").toLowerCase().trim();
  if (destinationText && !flatText.includes(destinationText)) {
    issues.push("destination_not_mentioned");
  }

  const routeContextMatches = [
    String(trip.startCity || "").toLowerCase(),
    String(trip.destination || "").toLowerCase(),
  ].filter(Boolean).reduce((count, term) => {
    return count + (flatText.includes(term) ? 1 : 0);
  }, 0);
  if (routeContextMatches < 2) {
    issues.push(`route_context_low:${routeContextMatches}_of_2`);
  }

  const itinerarySpecificHints = landmarkHints.length ? landmarkHints.slice(0, Math.max(3, Math.min(6, trip.totalDays + 1))) : [];
  const itineraryHintMatches = countDestinationHintMatches(flatText, itinerarySpecificHints);
  if (itinerarySpecificHints.length && itineraryHintMatches < Math.max(2, Math.min(4, itinerarySpecificHints.length))) {
    issues.push(`itinerary_hint_coverage_low:${itineraryHintMatches}_of_${Math.max(2, Math.min(4, itinerarySpecificHints.length))}`);
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
  const destinationPackingSignals = uniquePacking.filter((item) => {
    const normalizedItem = String(item || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedItem) return false;
    return /(rain|umbrella|waterproof|thermal|layer|fleece|warm|cold|snow|beach|swim|sunscreen|trek|hike|trail|shawl|scarf|modest|desert|safari|gloves|beanie|daypack|dry bag|repellent|sandals|boots|camera|e-sim|esim|portable charger|city day bag|cross-body)/.test(normalizedItem);
  }).length;
  if (destinationPackingSignals < 4) {
    issues.push(`packing_not_destination_specific:${destinationPackingSignals}`);
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
      tripSummaryWords,
      tripSummaryParagraphs,
      tripSummaryBoldPlaceMentions,
      weatherExpectedWords,
      weatherBestTimeWords,
    },
  };
}

function buildGeminiSectionsPrompt(payload, options = {}) {
  const data = normalizeGeminiTripPayload(payload);
  const exactDestinationLabel = data.destination || "Not specified";
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
    "Return only valid JSON. Do not wrap output in markdown code fences.",
    "You are an expert local travel planner generating real-life, actionable trip content for a travel web app.",
    "Your output must be specific, practical, and destination-grounded.",
    "Write like a helpful local friend talking to another traveler. Be warm, direct, and practical.",
    "Avoid brochure-style language, marketing phrases, and overhyped adjectives. Prefer short, clear sentences with real local advice.",
    "Use the exact destination label verbatim throughout the response. Do not normalize it to a different city, country, or famous place with the same name.",
    "If the destination contains a comma or region qualifier, keep that full text intact and do not shorten it to the city name.",
    "If you are uncertain about named landmarks for this exact destination, stay anchored to the exact destination label rather than borrowing landmarks from a different place.",
    "",
    "Trip request:",
    `Start city: ${data.startCity || "Not specified"}`,
    `Exact destination label: ${exactDestinationLabel}`,
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
    `Budget guidance range: Not provided`,
    `Passengers: ${data.passengers || "Not specified"}`,
    `Extra preferences: ${data.preferences || "None"}`,
    `Destination landmark hints: ${
      landmarkHints.length ? landmarkHints.join(", ") : "Not available; keep the response tied to the exact destination label without substituting another place."
    }`,
    "",
    "Generate these sections: Trip Highlights, Weather Analysis, Itinerary, Budget Range, Packing Checklist.",
    "Use real popular attractions/landmarks and practical movement between spots.",
    "Do not write generic template text like 'explore local attractions' without naming places.",
    "In itinerary slot text, include concrete place names and practical transit/area context.",
    "",
    "QuickBookings rules:",
    "- quickBookings must be realistic booking actions (not generic advice). Examples: hotel bookings, attraction tickets, transport searches, guided tours, passes.",
    "- quickBookings must respect the selected Transport:",
    "  - If Transport does NOT include Flights, do NOT suggest flights/air tickets/airport transfers.",
    "  - If Transport includes Road or Buses, prefer driving directions, intercity cab, or bus ticket searches for the route.",
    "  - If Transport includes Trains, suggest train ticket searches for the route.",
    "  - If Transport includes Flights, use one clear flight chip per route direction and keep the label in a simple form like City A -> City B or City B -> City A. Do not add a second flight-provider style chip for the same leg.",
    "- Make quickBookings trip-specific and chip-like. Use short labels that match the day context, such as Hotels in City, City A -> City B, a landmark name, a trek name, or Check Landmark visiting hours when the route calls for it.",
    "- Only include hotel/accommodation chips on arrival days or when the overnight base changes. Do not repeat hotel chips on every itinerary day.",
    "- For trips longer than 1 day, use the outbound route on the arrival day and the reverse return route on the final day when relevant. Do not repeat the same route direction on multiple days.",
    "- For middle-day transport chips, use a proper nearby landmark, district, or activity location as the destination. When the day involves moving to another spot, include a middle-day transport chip and use full place names, not single-word fragments like 'Gardens', 'Temple', or 'Market' unless they are part of a full real place name.",
    "- For attraction-focused days, prefer the actual landmark or activity name as the chip label instead of a sentence.",
    "- For stay/overnight days, include hotel/accommodation search links for the destination city and trip dates.",
    "- For landmark or adventure days, use tour/activity labels that map to the existing activity booking flow (Viator / GetYourGuide).",
    "- Include 3-5 quickBookings per day. Keep labels short and clear (no markdown).",
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
    '      "tip": "string",',
    '      "quickBookings": ["string"]',
    "    }",
    "  ],",
    '  "budgetRange": {',
    '    "currency": "INR",',
    '    "essentials": [',
    '      { "id": "accommodation", "label": "Accommodation", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "food", "label": "Food", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "insurance", "label": "Insurance", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "contingency", "label": "Contingency", "pct": 0, "min": 0, "max": 0 }',
    "    ],",
    '    "activities": [',
    '      { "id": "activitiesIncluded", "label": "Activities Included", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "activitiesOptional", "label": "Activities Optional", "pct": 0, "min": 0, "max": 0 }',
    "    ],",
    '    "transport": [',
    '      { "id": "travelStartReturn", "label": "Travel Start/Return", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "intercityTransport", "label": "Intercity Transport", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "intracityTransport", "label": "Intracity Transport", "pct": 0, "min": 0, "max": 0 },',
    '      { "id": "visa", "label": "Visa", "pct": 0, "min": 0, "max": 0 }',
    "    ]",
    "  },",
    '  "packingChecklist": ["string"]',
    "}",
    "",
    "Rules:",
    `- Itinerary array must have exactly ${data.totalDays} items.`,
    "- Use realistic and concise text per field with useful details.",
    "- Keep the tone human and easy to read. Sound conversational, not promotional.",
    "- When a tip or warning matters, say it plainly instead of dressing it up.",
    "- Do not use reusable canned copy. Keep wording specific to this exact destination, date range, and preferences.",
    "- tripHighlights.summary must be 2-3 paragraphs and around 180-300 words with meaningful narrative details.",
    "- Make the opening paragraph vivid and route-specific, the middle paragraph focus on named places and the day-by-day rhythm, and the closing paragraph give practical expectations or pacing advice.",
    "- Give the reader a stronger sense of the destination's personality, not just a summary of the form inputs.",
    "- Write tripHighlights.summary in plain text only. Do not use markdown bold, italics, bullets, or asterisks.",
    "- Mention at least 3 named places naturally in tripHighlights.summary, but keep the whole summary easy to read and unformatted.",
    "- When shaping tripHighlights.summary, naturally focus on these emphasis categories in the wording: proper nouns (cities, towns, landmarks, natural features), action-oriented nouns (treks, trails, markets, points of interest), key logistics (airports, stations, hotels, transport hubs), and categorical keywords that match the user's filters.",
    "- Do not over-emphasize generic adjectives or filler words. Keep the important nouns clear and specific.",
    "- weatherAnalysis.expectedConditions must be around 90-150 words with practical weather expectations (temperature band, precipitation/wind, and day/night feel).",
    "- weatherAnalysis.bestTimeToVisit must be around 80-130 words with why this trip window works, trade-offs, and practical timing advice.",
    "- Every itinerary day must have a unique anchor. Do not reuse the same day structure, same landmark cluster, or same wording across days.",
    "- Each itinerary day title and schedule should include real place names for the destination.",
    "- Every morning, afternoon, evening, and night field must mention at least one named place, district, landmark, or transit node. Do not leave any slot generic.",
    "- Do not use markdown formatting (like **bold**, _italics_, or lists) inside itinerary schedule fields (morning/afternoon/evening/night). Return plain text only in those fields.",
    "- Each itinerary day must include a short tip field with one practical, trip-specific sentence tied to that day's route or activities. Avoid generic buffer advice unless the route truly needs it.",
    "- optionalActivities must contain 2-3 practical items for every itinerary day. If only one strong idea exists, add one or two related low-effort options so the section still feels complete.",
    "- stayOptions must contain 2-4 items for every itinerary day.",
    "- On arrival or overnight-base change days, suggest real, destination-appropriate stay names when you are confident they exist; otherwise use service-style recommendation labels that still feel helpful.",
    "- On sightseeing days that keep the same hotel/base, keep the wording tied to the current stay or base instead of inventing a new hotel.",
    "- Prefer well-known hotel names, resorts, hostels, or homestays that are actually known in the destination when you are confident they exist.",
    "- Do not invent hotel names or hotel-like names. If you are not confident a specific property exists, use neutral recommendation-style labels such as 'Curated stays in City' or 'Best-value stays in City' instead of telling the user to search.",
    "- Do not use generic area placeholders such as 'Old Town', 'Station Road', or 'Riverside area' unless they are real, well-known locations in that destination and you are confident they exist there.",
    "- Keep stayOptions practical and destination-specific. Avoid placeholders such as '5-star hotel', 'central stay', or made-up chain names.",
    "- foodRecommendations must contain 3-4 practical food suggestions per day. Aim for a mix of breakfast, lunch, dinner, snack, or local specialty ideas that actually fit the destination and day plan.",
    "- Avoid giving only two food items unless the day is extremely short. The list should feel complete enough for a traveler to use.",
    "- Give each day a distinct theme or anchor so Day 1, Day 2, Day 3, etc. feel like separate parts of the trip, not copies of each other.",
    "- Avoid rephrasing the same day with slightly different words. The route, activities, and places must change from day to day.",
    "- Across the full itinerary include at least 8 unique real place names (if destination supports it).",
    "- Mention practical route context: nearby areas, transfer hints, or timing windows.",
    "- Include realistic local anchors such as neighborhoods, viewpoints, ghats, beaches, markets, districts, temples, forts, museums, or monuments where relevant.",
    "- The trip summary should explicitly mention the origin and destination city and at least 3 named places from the destination hints when available.",
    "- Budget values must be integers, non-negative, and min <= max.",
    "- Use only allowed budget ids shown in schema.",
    "- Budget percentages must be realistic and trip-specific. Do not reuse a fixed template split across trips.",
    "- Use the category percentages to reflect this exact trip context (duration, hotel style, route distance, activities intensity, and transport mode).",
    "- The sum of all category pct values should be close to 100 (acceptable range: 96 to 104 due rounding).",
    "- Set visa pct and amounts above 0 only when cross-border travel is likely; otherwise keep visa at 0.",
    "- packingChecklist should contain 12-18 actionable items.",
    "- Packing checklist items must be specific and practical, not just category labels. Include must-have items such as documents, wallet/cards, medicines, chargers, power bank, weather protection, footwear, toiletries, clothing layers, and destination-specific gear.",
    "- Make the checklist destination-aware. Mix universal essentials with items tied to the destination's climate, terrain, activities, and local norms. Do not reuse the same generic packing list for every trip.",
    "- At least 4 packing items should be clearly destination-specific, such as beach gear, rain protection, warm layers, trekking gear, temple-friendly clothing, desert sun protection, or city-day essentials depending on the trip.",
    "- Avoid generic one-word checklist items unless they are truly essential, and do not repeat the same packing item in different words.",
    "- If uncertain about a specific place, prefer widely known landmarks and districts.",
    landmarkHints.length
      ? `- Use at least ${minimumHintUsage} names from 'Destination landmark hints' in the itinerary schedule/day titles.`
      : "- If no hints are provided, infer well-known landmarks from the destination and avoid generic wording.",
    isRevision ? "- This is a revision task: rewrite any itinerary day that repeats another day, uses generic wording, or lacks named places. If a day looks template-like, rebuild it from scratch with a fresh anchor and a different route." : "",
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
      temperature: 0.2,
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

app.post("/api/feasibility", express.json(), async (req, res) => {
  const payload = normalizeGeminiTripPayload(req.body || {});
  const startedAt = Date.now();
  const cacheKey = createCacheKey(["feasibility", payload]);
  const cached = getCachedGeminiValue(geminiFeasibilityCache, cacheKey);
  if (cached) {
    return res.json(cached);
  }
  if (isMockAiEnabled()) {
    const mock = buildMockFeasibilityResult(payload);
    const response = {
      ...mock,
      _meta: {
        source: "mock",
        model: "mock-ai",
        usedGoogleSearch: false,
        elapsedMs: 0,
      },
    };
    setCachedGeminiValue(geminiFeasibilityCache, cacheKey, response);
    return res.json(response);
  }

  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    const fallback = buildLocalFeasibilityResult(payload, "GEMINI_API_KEY not set");
    const response = {
      ...fallback,
      _meta: {
        source: "local-fallback",
        model: "local-estimator",
        usedGoogleSearch: false,
        elapsedMs: Date.now() - startedAt,
        fallbackReason: "GEMINI_API_KEY not set",
      },
    };
    setCachedGeminiValue(geminiFeasibilityCache, cacheKey, response);
    return res.json(response);
  }

  const modelCandidates = dedupeStrings([
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
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
      const anchored = anchorDestinationMentionsInValue(normalized, payload.destination);

      const response = {
        ...anchored,
        _meta: {
          source: "gemini",
          model,
          usedGoogleSearch: !!attempt.result.useGoogleSearch,
          elapsedMs: Date.now() - startedAt,
        },
      };
      setCachedGeminiValue(geminiFeasibilityCache, cacheKey, response);
      return res.json(response);
    }

    const fallback = buildLocalFeasibilityResult(payload, "Gemini response parsing failed");
    const response = {
      ...fallback,
      _meta: {
        source: "local-fallback",
        model: "local-estimator",
        usedGoogleSearch: false,
        elapsedMs: Date.now() - startedAt,
        fallbackReason: "Gemini response parsing failed",
      },
    };
    setCachedGeminiValue(geminiFeasibilityCache, cacheKey, response);
    return res.json(response);
  } catch (error) {
    const fallback = buildLocalFeasibilityResult(
      payload,
      error && error.message ? `Gemini feasibility request failed: ${error.message}` : "Gemini feasibility request failed"
    );
    const response = {
      ...fallback,
      _meta: {
        source: "local-fallback",
        model: "local-estimator",
        usedGoogleSearch: false,
        elapsedMs: Date.now() - startedAt,
        fallbackReason:
          error && error.message
            ? `Gemini feasibility request failed: ${error.message}`
            : "Gemini feasibility request failed",
      },
    };
    setCachedGeminiValue(geminiFeasibilityCache, cacheKey, response);
    return res.json(response);
  }
});

async function generateGeminiSections(payload, options = {}) {
  const normalized = normalizeGeminiTripPayload(payload || {});
  const settings = options && typeof options === "object" ? options : {};
  const seededBudgetRange = normalizeBudgetRangeSeed(settings.budgetRangeSeed, normalized.currency);
  const budgetGuidance =
    settings.budgetGuidance && typeof settings.budgetGuidance === "object"
      ? {
          currency: String(settings.budgetGuidance.currency || normalized.currency || "INR").trim().toUpperCase() || "INR",
          suggestedBudgetMin: toNonNegativeInteger(settings.budgetGuidance.suggestedBudgetMin),
          suggestedBudgetMax: Math.max(
            toNonNegativeInteger(settings.budgetGuidance.suggestedBudgetMin),
            toNonNegativeInteger(settings.budgetGuidance.suggestedBudgetMax)
          ),
      }
      : null;
  const buildLocalFallback = (reasonText) => {
    const fallback = buildMockGeminiSections(normalized, { budgetGuidance });
    if (fallback && fallback.parsed) {
      if (seededBudgetRange) {
        fallback.parsed.budgetRange = seededBudgetRange;
        fallback.parsed.budgetRangeSource = "manual";
      }
      const normalizedBudget = normalizeBudgetRangePercentages(
        fallback.parsed.budgetRange,
        normalized.currency
      );
      if (normalizedBudget) {
        fallback.parsed.budgetRange = normalizedBudget;
      }
      fallback.parsed.packingChecklist = buildDestinationPackingChecklist(normalized);
      fallback.parsed.packingChecklistSource = "auto";
    }
    if (fallback && fallback.meta) {
      fallback.meta.source = "local-fallback";
      fallback.meta.model = "local-estimator";
      fallback.meta.usedGoogleSearch = false;
      fallback.meta.elapsedMs = 0;
      fallback.meta.fallbackReason = String(reasonText || "").trim();
      fallback.meta.budgetSeeded = !!seededBudgetRange;
    }
    return fallback;
  };
  const cacheKey = createCacheKey([
    "plan-sections",
    normalized,
    seededBudgetRange,
    budgetGuidance,
    Boolean(isMockAiEnabled())
  ]);
  const cached = getCachedGeminiValue(geminiSectionCache, cacheKey);
  if (cached) return cached;
  if (isMockAiEnabled()) {
    const mockResult = buildMockGeminiSections(normalized, { budgetGuidance });
    if (seededBudgetRange && mockResult && mockResult.parsed) {
      mockResult.parsed.budgetRange = seededBudgetRange;
    }
    if (mockResult && mockResult.parsed) {
      const normalizedBudget = normalizeBudgetRangePercentages(
        mockResult.parsed.budgetRange,
        normalized.currency
      );
      if (normalizedBudget) {
        mockResult.parsed.budgetRange = normalizedBudget;
      }
    }
    if (mockResult && mockResult.meta) {
      mockResult.meta.budgetSeeded = !!seededBudgetRange;
    }
    setCachedGeminiValue(geminiSectionCache, cacheKey, mockResult);
    return mockResult;
  }

  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    const fallback = buildLocalFallback("GEMINI_API_KEY not set");
    setCachedGeminiValue(geminiSectionCache, cacheKey, fallback);
    return fallback;
  }

  const startedAt = Date.now();

  const modelName = "gemini-2.5-flash-lite";
  const basePrompt = buildGeminiSectionsPrompt(normalized, { budgetGuidance });
  const attempt = await requestGeminiSectionsOnce({
    apiKey,
    model: modelName,
    promptText: basePrompt,
    useGoogleSearch: false,
  });
  if (!attempt.ok || !attempt.parsed) {
    const detail = `${modelName}:without_google_search:${attempt.status}${attempt.errorText ? `:${attempt.errorText}` : ""}`.slice(0, 900);
    const fallback = buildLocalFallback(detail || "Gemini request failed");
    setCachedGeminiValue(geminiSectionCache, cacheKey, fallback);
    return fallback;
  }

  const baseQuality = evaluateGeminiSectionsQuality(attempt.parsed, normalized);
  let bestOutput = {
    parsed: attempt.parsed,
    quality: baseQuality,
    model: modelName,
    usedGoogleSearch: false,
  };

  if (seededBudgetRange) {
    bestOutput.parsed = Object.assign({}, bestOutput.parsed, {
      budgetRange: seededBudgetRange,
      budgetRangeSource: "manual",
    });
  } else {
    bestOutput.parsed = Object.assign({}, bestOutput.parsed, {
      budgetRange: buildRealisticBudgetRange(normalized, budgetGuidance),
      budgetRangeSource: "auto",
    });
  }

  const normalizedBudget = normalizeBudgetRangePercentages(
    bestOutput.parsed && bestOutput.parsed.budgetRange,
    normalized.currency
  );
  if (normalizedBudget) {
    bestOutput.parsed = Object.assign({}, bestOutput.parsed, {
      budgetRange: normalizedBudget,
      budgetRangeSource: bestOutput.parsed && bestOutput.parsed.budgetRangeSource ? bestOutput.parsed.budgetRangeSource : "auto",
    });
  }
  const generatedPacking = dedupeStrings(
    Array.isArray(bestOutput.parsed && bestOutput.parsed.packingChecklist)
      ? bestOutput.parsed.packingChecklist.map((item) => String(item || "").trim())
      : []
  );
  const packingIssues = Array.isArray(bestOutput.quality && bestOutput.quality.issues)
    ? bestOutput.quality.issues.filter((issue) => String(issue || "").indexOf("packing_") === 0)
    : [];
  if (!generatedPacking.length || packingIssues.length) {
    bestOutput.parsed = Object.assign({}, bestOutput.parsed, {
      packingChecklist: buildDestinationPackingChecklist(normalized),
      packingChecklistSource: "auto",
    });
  }

  bestOutput.parsed = anchorDestinationMentionsInValue(bestOutput.parsed, normalized.destination);

  const result = {
    parsed: bestOutput.parsed,
    meta: {
      source: "gemini",
      model: bestOutput.model,
      usedGoogleSearch: bestOutput.usedGoogleSearch,
      elapsedMs: Date.now() - startedAt,
      quality: bestOutput.quality,
      budgetSeeded: !!seededBudgetRange,
    },
  };
  setCachedGeminiValue(geminiSectionCache, cacheKey, result);
  return result;
}

app.post("/api/gemini/plan-sections", express.json(), async (req, res) => {
  try {
    const payload = req.body || {};
    const normalized = normalizeGeminiTripPayload(payload);
    const result = await generateGeminiSections(payload, {
      budgetRangeSeed: extractBudgetRangeSeedFromRequest(payload, normalized),
      budgetGuidance: extractBudgetGuidanceFromRequest(payload, normalized),
    });
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

function getTripDayLimitForPlanTier(planTier) {
  const normalizedPlanTier = normalizePlanTier(planTier);
  return normalizedPlanTier === "paid" || normalizedPlanTier === "business" ? 30 : 7;
}

function getCollaboratorLimitForPlanTier(planTier) {
  const normalizedPlanTier = normalizePlanTier(planTier);
  return normalizedPlanTier === "paid" || normalizedPlanTier === "business" ? 5 : 1;
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
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
      planTier: derivePlanTierFromUser(user),
    });
  } catch (error) {
    console.error("GET /api/users/me failed:", error);
    return res.status(500).json({ error: "Unable to fetch user" });
  }
});

app.post("/api/payments/credits/order", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const razorpayCredentials = getRazorpayCredentials();
    if (!razorpayCredentials) {
      return res.status(500).json({ error: "Razorpay is not configured" });
    }

    const creditPack = getCreditPackConfig();
    const receipt = `credits_${user.id}_${randomUUID().replace(/-/g, "").slice(0, 20)}`.slice(0, 40);
    const order = await razorpayApiRequest("POST", "/orders", {
      amount: creditPack.amountSubunits,
      currency: creditPack.currency,
      receipt,
      notes: {
        product: "credits",
        user_id: String(user.id),
        clerk_user_id: String(user.clerk_user_id || ""),
        credits: String(creditPack.credits),
      },
    });

    return res.json({
      key: razorpayCredentials.keyId,
      orderId: order.id,
      amount: Number(order.amount || creditPack.amountSubunits),
      currency: String(order.currency || creditPack.currency),
      credits: creditPack.credits,
      name: "Yatrify",
      description: `${creditPack.credits} credits pack`,
      email: user.email || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
    });
  } catch (error) {
    console.error("POST /api/payments/credits/order failed:", error);
    return res.status(error && error.status ? error.status : 500).json({
      error: error && error.detail ? error.detail : error.message || "Unable to create payment order",
    });
  }
});

app.post("/api/payments/credits/verify", requireAuth, requireDb, express.json(), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const razorpayPaymentId = String(body.razorpay_payment_id || "").trim();
    const razorpayOrderId = String(body.razorpay_order_id || "").trim();
    const razorpaySignature = String(body.razorpay_signature || "").trim();

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.status(400).json({ error: "Missing Razorpay payment details" });
    }

    const razorpayCredentials = getRazorpayCredentials();
    if (!razorpayCredentials) {
      return res.status(500).json({ error: "Razorpay is not configured" });
    }

    const generatedSignature = createHmac("sha256", razorpayCredentials.keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (!signaturesMatch(generatedSignature, razorpaySignature)) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const [order, payment] = await Promise.all([
      razorpayApiRequest("GET", `/orders/${encodeURIComponent(razorpayOrderId)}`),
      razorpayApiRequest("GET", `/payments/${encodeURIComponent(razorpayPaymentId)}`),
    ]);

    if (String(payment.order_id || "") !== razorpayOrderId) {
      return res.status(400).json({ error: "Payment does not belong to this order" });
    }

    const orderUserId = order && order.notes ? String(order.notes.user_id || "").trim() : "";
    if (!orderUserId || orderUserId !== String(user.id)) {
      return res.status(403).json({ error: "Payment does not belong to this user" });
    }

    const creditPack = getCreditPackConfig();
    const orderCredits = order && order.notes ? Number(order.notes.credits || creditPack.credits) : creditPack.credits;
    const paymentStatus = String(payment.status || "").trim().toLowerCase();
    if (paymentStatus !== "captured" && paymentStatus !== "authorized") {
      return res.status(400).json({ error: "Payment is not in a successful state yet" });
    }

    const grantResult = await store.grantCreditsFromPurchase(user.id, {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      amountSubunits: Number(payment.amount || order.amount || creditPack.amountSubunits || 0),
      currency: String(payment.currency || order.currency || creditPack.currency || "INR"),
      creditsAdded:
        Number.isFinite(orderCredits) && orderCredits > 0 ? orderCredits : creditPack.credits,
      status: paymentStatus,
      method: String(payment.method || "").trim(),
      payload: {
        order,
        payment,
      },
    });

    const updatedUser = await reconcileUserPlanTier(
      Object.assign({}, user, {
        credits: grantResult && Number.isFinite(Number(grantResult.credits))
          ? Number(grantResult.credits)
          : Number(user.credits || 0),
      })
    );

    return res.json({
      ok: true,
      duplicated: !!(grantResult && grantResult.duplicated),
      credits: grantResult ? Number(grantResult.credits || 0) : Number(user.credits || 0),
      packCredits:
        Number.isFinite(orderCredits) && orderCredits > 0 ? orderCredits : creditPack.credits,
      planTier: updatedUser ? derivePlanTierFromUser(updatedUser) : derivePlanTierFromUser(user),
      razorpayPaymentId,
    });
  } catch (error) {
    console.error("POST /api/payments/credits/verify failed:", error);
    return res.status(error && error.status ? error.status : 500).json({
      error: error && error.detail ? error.detail : error.message || "Unable to verify payment",
    });
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
    const rawInput = req.body || {};
    const payload = normalizeGeminiTripPayload(rawInput);
    const budgetRangeSeed = extractBudgetRangeSeedFromRequest(rawInput, payload);
    const budgetGuidance = extractBudgetGuidanceFromRequest(rawInput, payload);

    const totalDays = diffDaysInclusive(payload.startDate, payload.endDate);
    if (!totalDays) {
      return res.status(400).json({ error: "Invalid travel dates" });
    }
    const limit = getTripDayLimitForPlanTier(user.plan_tier);
    if (totalDays > limit) {
      return res.status(400).json({ error: "Trip length exceeds plan limit", limit });
    }
    if (Number(user.credits || 0) < 1) {
      return res.status(402).json({ error: "Insufficient credits" });
    }

    let generated;
    try {
      generated = await generateGeminiSections(payload, { budgetRangeSeed, budgetGuidance });
    } catch (generationError) {
      console.error("Gemini plan generation failed, falling back to local sections:", generationError);
      const localFallback = buildMockGeminiSections(payload, { budgetGuidance });
      if (localFallback && localFallback.parsed) {
        if (budgetRangeSeed) {
          localFallback.parsed.budgetRange = budgetRangeSeed;
          localFallback.parsed.budgetRangeSource = "manual";
        }
        localFallback.parsed = anchorDestinationMentionsInValue(localFallback.parsed, payload.destination);
      }
      if (localFallback && localFallback.meta) {
        localFallback.meta = Object.assign({}, localFallback.meta, {
          source: "local-fallback",
          model: "local-estimator",
          usedGoogleSearch: false,
          elapsedMs: 0,
          fallbackReason: generationError && generationError.message ? generationError.message : "Gemini plan generation failed",
        });
      }
      generated = localFallback;
    }

    if (!generated || !generated.parsed || typeof generated.parsed !== "object") {
      generated = buildMockGeminiSections(payload, { budgetGuidance });
      if (generated && generated.parsed) {
        if (budgetRangeSeed) {
          generated.parsed.budgetRange = budgetRangeSeed;
          generated.parsed.budgetRangeSource = "manual";
        }
        generated.parsed = anchorDestinationMentionsInValue(generated.parsed, payload.destination);
      }
    }

    const planSections = generated && generated.parsed && typeof generated.parsed === "object" ? generated.parsed : {};
    if (budgetGuidance) {
      planSections.feasibility = Object.assign({}, budgetGuidance);
    }
    const plan = await store.createPlan(user.id, payload, planSections, {});
    const creditsResult = await store.consumeCredits(user.id, 1, "generate", plan.id);
    if (!creditsResult) {
      await store.deletePlan(user.id, plan.id);
      return res.status(402).json({ error: "Insufficient credits" });
    }
    const creditsLeft = Number(creditsResult.credits || 0);

    return res.json({
      plan,
      planId: plan.id,
      credits: creditsLeft,
      _meta: generated.meta,
    });
  } catch (error) {
    console.error("POST /api/plans/generate failed:", error);
    return res.status(500).json({
      error: error && error.message ? error.message : "Plan generation failed",
    });
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
          await store.acceptInviteById(req.params.id, inviteId, user.id, user.email || req.auth.email || "");
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
    const collaboratorLimit =
      access.role === "owner" ? getCollaboratorLimitForPlanTier(user.plan_tier) : null;
    return res.json({
      collaborators,
      collaboratorLimit,
      collaboratorCount: collaborators.length,
      collaboratorLimitReached:
        Number.isFinite(collaboratorLimit) && collaboratorLimit > 0
          ? collaborators.length >= collaboratorLimit
          : false,
    });
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
    const collaboratorLimit = getCollaboratorLimitForPlanTier(user.plan_tier);
    const collaborators = await store.listCollaborators(req.params.id);
    const normalizedInviteEmail = normalizeEmailAddress(email);
    const inviteAlreadyExists = collaborators.some((item) => {
      return (
        normalizeEmailAddress(item && item.invitedEmail) === normalizedInviteEmail ||
        normalizeEmailAddress(item && item.email) === normalizedInviteEmail
      );
    });
    if (!inviteAlreadyExists && collaborators.length >= collaboratorLimit) {
      return res.status(403).json({
        error: "Collaborator limit reached",
        detail:
          collaboratorLimit === 1
            ? "Free plans can invite up to 1 collaborator."
            : `Paid plans can invite up to ${collaboratorLimit} collaborators.`,
        collaboratorLimit,
        collaboratorCount: collaborators.length,
      });
    }
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
        appBaseUrl: process.env.APP_BASE_URL || req.headers.origin || "http://localhost:4000",
      });
    } catch (mailError) {
      emailDelivery = { sent: false, skipped: false, reason: mailError.message || "send failed" };
      console.error("Collaborator invite email failed:", mailError);
    }

    return res.json({
      invite,
      emailDelivery,
      collaboratorLimit,
      collaboratorCount: inviteAlreadyExists ? collaborators.length : collaborators.length + 1,
    });
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
      invite = await store.acceptInviteById(req.params.id, inviteId, user.id, user.email || req.auth.email || "");
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
    const user = await getAuthedUser(req, { skipProfileSync: true });
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
    const user = await getAuthedUser(req, { skipProfileSync: true });
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

const CSC_JSON_CACHE_TTL_MS = 15 * 60 * 1000;
const cscJsonCache = new Map();
const cscJsonPromiseCache = new Map();

function getCachedCscJson(pathname) {
  const key = String(pathname || "").trim();
  if (!key) return null;
  const entry = cscJsonCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cscJsonCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedCscJson(pathname, value) {
  const key = String(pathname || "").trim();
  if (!key) return;
  cscJsonCache.set(key, {
    value,
    expiresAt: Date.now() + CSC_JSON_CACHE_TTL_MS,
  });
}

async function fetchCSCJson(pathname) {
  const key = String(pathname || "").trim();
  if (!key) return [];
  const cached = getCachedCscJson(key);
  if (cached) return cached;
  if (cscJsonPromiseCache.has(key)) {
    return cscJsonPromiseCache.get(key);
  }
  if (!process.env.CSC_API_KEY) {
    throw new Error("CSC_API_KEY missing");
  }
  const promise = (async () => {
    const response = await fetch(`https://api.countrystatecity.in/v1${key}`, {
      method: "GET",
      headers: {
        "X-CSCAPI-KEY": process.env.CSC_API_KEY,
      },
    });
    if (!response.ok) {
      throw new Error(`CSC request failed: ${response.status}`);
    }
    const payload = await response.json();
    setCachedCscJson(key, payload);
    return payload;
  })();
  cscJsonPromiseCache.set(key, promise);
  try {
    return await promise;
  } finally {
    cscJsonPromiseCache.delete(key);
  }
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

app.get("/api/csc/countries/:iso2/states", async (req, res) => {
  const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
  if (!iso2) {
    return res.status(400).json({ error: "Country code is required" });
  }
  try {
    const states = await fetchCSCJson(`/countries/${encodeURIComponent(iso2)}/states`);
    return res.json(states);
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch states from CSC API" });
  }
});

app.get("/api/csc/countries/:iso2/states/:stateIso2/cities", async (req, res) => {
  const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
  const stateIso2 = String(req.params.stateIso2 || "").trim().toUpperCase();
  if (!iso2 || !stateIso2) {
    return res.status(400).json({ error: "Country code and state code are required" });
  }
  try {
    const cities = await fetchCSCJson(
      `/countries/${encodeURIComponent(iso2)}/states/${encodeURIComponent(stateIso2)}/cities`
    );
    return res.json(cities);
  } catch (error) {
    return res.status(500).json({ error: "Unable to fetch state cities from CSC API" });
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

FRONTEND_ASSET_DIRS.forEach((dirName) => {
  const dirPath = path.join(FRONTEND_ROOT_DIR, dirName);
  if (fs.existsSync(dirPath)) {
    app.use(`/${dirName}`, express.static(dirPath, { fallthrough: true }));
  }
});

app.get("/", (_req, res) => {
  return res.sendFile(path.join(FRONTEND_ROOT_DIR, "index.html"));
});

app.get("/404.html", (req, res) => {
  return sendFrontendNotFoundPage(res, {
    scenario: req.query && req.query.scenario ? req.query.scenario : "MISTYPED_URL",
    resource: req.query && req.query.resource ? req.query.resource : "",
    requestPath: req.query && req.query.resource ? req.query.resource : req.path,
  });
});

app.get(/^\/([a-z0-9-]+)(?:\.html)?$/i, (req, res, next) => {
  const slug = String(req.params[0] || "").trim().toLowerCase();
  if (!slug) return next();
  if (slug === "api" || slug === "health" || slug === "webhooks") return next();

  const filePath = path.join(FRONTEND_ROOT_DIR, `${slug}.html`);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  return next();
});

app.use("/api", (_req, res) => {
  return res.status(404).json({
    error: "API endpoint not found",
    scenario: "API_ENDPOINT_NOT_FOUND",
  });
});

app.use((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(404).json({ error: "Not Found" });
  }

  const scenario = isLikelyAssetPath(req.path) ? "MISSING_ASSET" : "MISTYPED_URL";
  const resource = String(req.originalUrl || req.path || "").trim();
  return sendFrontendNotFoundPage(res, { scenario, resource, requestPath: req.path });
});

async function startServer() {
  try {
    await ensurePaymentTables();
    const server = app.listen(port, () => {
      console.log(`API listening on ${port}`);
    });
    server.on("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use. Stop the existing server and try again.`);
      } else {
        console.error("Unable to start API server:", error);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error("Unable to start API server:", error);
    process.exit(1);
  }
}

export { app };
export default app;

if (!isVercelRuntime) {
  startServer();
}
