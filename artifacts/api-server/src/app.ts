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
// In production, lock to known origins via ALLOWED_ORIGINS (comma-separated).
// In development (no env var), use * so the Replit preview iframe works freely.
// Credentials are only enabled when a specific origin allowlist is configured.
const rawOrigins = process.env.ALLOWED_ORIGINS?.trim();
const isProd = process.env.NODE_ENV === "production";
const corsOrigin: string | string[] | false =
  rawOrigins
    ? rawOrigins.split(",").map((o) => o.trim()).filter(Boolean)
    : isProd
      ? false   // fail-closed in production when not configured
      : "*";
app.use(
  cors({
    origin: corsOrigin,
    credentials: !!(rawOrigins && rawOrigins.length > 0),
  }),
);

// ── Global rate limits ────────────────────────────────────────────────────────
// Public read endpoints: 300 req/min per IP (generous for explorers/dashboards).
// Write/admin endpoints have their own stricter per-route limits applied later.
const readLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — try again in a minute." },
  skip: (req) =>
    req.path.startsWith("/api/blocks/submit") ||
    req.path.startsWith("/api/tx/broadcast") ||
    req.path.startsWith("/api/admin"),
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

app.use("/api", router);
app.use(metricsRouter);
app.use(stratumMetricsRouter);

export default app;
