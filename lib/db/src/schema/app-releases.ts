import { pgTable, text, integer, bigint } from "drizzle-orm/pg-core";

/**
 * Latest published build per platform, used by the in-app "check for
 * updates" screen (sideloaded APKs have no store auto-update mechanism).
 *
 * One row per platform — publishing a new version overwrites the previous
 * row for that platform (see routes/mobile.ts), so this table always holds
 * only the current latest release, not a full history.
 */
export const appReleasesTable = pgTable("app_releases", {
  platform:      text("platform").primaryKey(), // e.g. "android"
  versionCode:   integer("version_code").notNull(),
  versionName:   text("version_name").notNull(),
  downloadUrl:   text("download_url").notNull(),
  releaseNotes:  text("release_notes"),
  publishedAt:   bigint("published_at", { mode: "number" }).notNull(),
});

export type AppReleaseRow = typeof appReleasesTable.$inferSelect;
