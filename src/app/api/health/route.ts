import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Probed by the CD workflow after each deploy. Returns 200 + {"ok":true} only
// when the app can reach Postgres, so a bad release fails the health gate and
// triggers rollback.
export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return NextResponse.json(
    {
      ok: dbOk,
      sha: process.env.GIT_SHA ?? null,
      db: dbOk ? "ok" : "fail",
    },
    { status: dbOk ? 200 : 503 },
  );
}
