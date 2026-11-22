// أحدث المهام + الإحصائيات — للوحة المهام في الواجهة
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt.slice(0, 120),
      result_urls: t.result_urls_json ? safeParse(t.result_urls_json) : [],
      error_message: t.error_message,
      attempts_count: (safeParse(t.attempts_json, []) as unknown[]).length,
      created_at: t.created_at,
      completed_at: t.completed_at,
      key_id: t.key_id,
      key_label: t.key_id ? maskKey(t.key_id) : null,
    })),
  });
}

function safeParse(json: string, fallback: unknown = []): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
