import express, { type Express } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import router from "./routes/index.js";
import metricsRouter from "./routes/metrics.js";
import stratumMetricsRouter from "./routes/stratum-metrics.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

// Trust the reverse proxy sitting in front of us (Replit's edge, nginx, etc.)
// so express-rate-limit can read X-Forwarded-For reliably.
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Restrict CORS to a validated ALLOWED_ORIGINS allowlist (comma-separated).
// If not configured, fail closed for browser-originated requests.
const rawOrigins = process.env.ALLOWED_ORIGINS?.trim() ?? "";
const allowedOrigins = new Set(
  rawOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .filter((o) => {
      try {
        const parsed = new URL(o);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        // Allow non-browser/server-to-server requests with no Origin header.
        return callback(null, true);
      }
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS origin denied"));
    },
    credentials: allowedOrigins.size > 0,
  }),
);

// ── Global rate limits ────────────────────────────────────────────────────────
// Rate limiting is bypassed entirely in the test environment so integration
// tests (which issue many requests from a single IP) are not throttled.
const isTestEnv = process.env.NODE_ENV === "test";

// Public read endpoints: 300 req/min per IP (generous for explorers/dashboards).
const readLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — try again in a minute." },
  skip: () => isTestEnv,
});

// Write endpoints: tighter budget applied to all state-mutating methods.
// Skips GET / HEAD / OPTIONS so read traffic is unaffected.
// Both limiters run independently; 20/min fires before the 300/min read limit.
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many write requests — try again in a minute." },
  skip: (req) =>
    isTestEnv ||
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS",
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(readLimiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply the write limiter globally — the skip function above handles GET/HEAD/OPTIONS.
app.use(writeLimiter);

app.use("/api", router);
app.use(metricsRouter);
app.use(stratumMetricsRouter);

export default app;
