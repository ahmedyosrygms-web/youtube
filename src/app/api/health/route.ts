// فحص الجهوزية الشامل — قاعدة البيانات، الموديلات، خدمة الدمج، المصادقة
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { modelsForHealth } from "@/lib/models";
import { mergerHealthy, MERGER_BASE } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [dbOk, mergerOk] = await Promise.all([dbHealthy(), mergerHealthy()]);

  return NextResponse.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: modelsForHealth(),
      merger: {
        base: MERGER_BASE,
        healthy: mergerOk,
      },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: dbOk ? 200 : 500 }
  );
}
