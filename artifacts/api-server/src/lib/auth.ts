import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

/**
 * Express middleware that enforces admin key authentication.
 *
 * Behaviour:
 *  - Key configured: requires a matching `X-Admin-Key` header; 403 otherwise.
 *  - No key configured + production (NODE_ENV=production): fails CLOSED — 503
 *    so a misconfigured deployment never accidentally exposes admin endpoints.
 *  - No key configured + development: logs a warning and passes through so
 *    local dev doesn't need secrets wired up.
 *
 * Usage:
 *   router.post("/some/admin/route", requireAdminKey, handler);
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env["ADMIN_KEY"] || process.env["ADMIN_API_KEY"];

  if (!adminKey) {
    if (process.env["NODE_ENV"] === "production") {
      res.status(503).json({
        error: "Server misconfiguration: neither ADMIN_KEY nor ADMIN_API_KEY is set",
      });
      return;
    }
    // Development convenience: warn loudly but allow through.
    logger.warn(
      { path: req.path },
      "requireAdminKey: no admin key configured — auth bypassed in dev mode",
    );
    next();
    return;
  }

  const provided = req.headers["x-admin-key"];
  if (provided !== adminKey) {
    res.status(403).json({ error: "Forbidden: valid X-Admin-Key header required" });
    return;
  }

  next();
}
