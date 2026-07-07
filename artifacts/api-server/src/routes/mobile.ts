import { Router } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { appReleasesTable, type AppReleaseRow } from "@workspace/db/schema";
import { requireAdminKey } from "../lib/auth.js";

const router = Router();

type Db = ReturnType<typeof drizzle>;

let _db: Db | null = null;
function getDb(): Db | null {
  if (_db) return _db;
  const url = process.env["DATABASE_URL"];
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url });
  _db = drizzle(pool, { schema: { appReleasesTable } });
  return _db;
}

/**
 * GET /mobile/version?platform=android
 *
 * Polled by the sideloaded mobile app's "check for updates" screen. Returns
 * the latest published build metadata for the requested platform, or 404 if
 * nothing has been published yet. No auth required — this is public release
 * metadata, same as a store listing.
 */
router.get("/mobile/version", async (req, res) => {
  const platform = (req.query["platform"] as string | undefined)?.trim().toLowerCase();
  if (!platform) {
    res.status(400).json({ error: "platform query parameter is required (e.g. ?platform=android)" });
    return;
  }

  const db = getDb();
  if (!db) {
    res.status(503).json({ error: "Database unavailable" });
    return;
  }

  let row: AppReleaseRow | undefined;
  try {
    const rows = await db
      .select()
      .from(appReleasesTable)
      .where(eq(appReleasesTable.platform, platform));
    row = rows[0];
  } catch (err) {
    res.status(500).json({ error: "Failed to query latest release", detail: String(err) });
    return;
  }

  if (!row) {
    res.status(404).json({ error: `No published release found for platform "${platform}"` });
    return;
  }

  res.json({
    platform: row.platform,
    versionCode: row.versionCode,
    versionName: row.versionName,
    downloadUrl: row.downloadUrl,
    releaseNotes: row.releaseNotes ?? null,
    publishedAt: row.publishedAt,
  });
});

/**
 * POST /mobile/version
 *
 * Publishes (upserts) the latest build metadata for a platform. Called by
 * the Android APK CI workflow right after a signed release is attached to a
 * GitHub Release — see android-apk-ci.yml. Protected by the same ADMIN_KEY /
 * ADMIN_API_KEY + X-Admin-Key header convention used for validator slashing.
 */
router.post("/mobile/version", requireAdminKey, async (req, res) => {

  const { platform, versionCode, versionName, downloadUrl, releaseNotes } = req.body as {
    platform?: string;
    versionCode?: number;
    versionName?: string;
    downloadUrl?: string;
    releaseNotes?: string | null;
  };

  if (!platform || typeof platform !== "string") {
    res.status(400).json({ error: "platform is required" });
    return;
  }
  if (!Number.isInteger(versionCode) || (versionCode as number) < 1) {
    res.status(400).json({ error: "versionCode must be a positive integer" });
    return;
  }
  if (!versionName || typeof versionName !== "string") {
    res.status(400).json({ error: "versionName is required" });
    return;
  }
  if (!downloadUrl || typeof downloadUrl !== "string") {
    res.status(400).json({ error: "downloadUrl is required" });
    return;
  }

  const db = getDb();
  if (!db) {
    res.status(503).json({ error: "Database unavailable" });
    return;
  }

  const normalizedPlatform = platform.trim().toLowerCase();
  const publishedAt = Math.floor(Date.now() / 1000);

  try {
    await db
      .insert(appReleasesTable)
      .values({
        platform: normalizedPlatform,
        versionCode: versionCode as number,
        versionName,
        downloadUrl,
        releaseNotes: releaseNotes ?? null,
        publishedAt,
      })
      .onConflictDoUpdate({
        target: appReleasesTable.platform,
        set: { versionCode, versionName, downloadUrl, releaseNotes: releaseNotes ?? null, publishedAt },
      });
  } catch (err) {
    res.status(500).json({ error: "Failed to publish release", detail: String(err) });
    return;
  }

  res.json({
    success: true,
    platform: normalizedPlatform,
    versionCode,
    versionName,
    downloadUrl,
    releaseNotes: releaseNotes ?? null,
    publishedAt,
  });
});

export default router;
