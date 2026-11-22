// خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفات MCP
// نستخدم McpServer + StreamableHTTPServerTransport الرسميين من @modelcontextprotocol/sdk
// لا نكتب JSON-RPC يدويًا — الـ SDK يتولى كل بروتوكول الاتصال
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
// ملاحظة: لا نعلّق مخططات zod بنوع من SDK (مثل ZodRawShapeCompat) — فحص التوافق
// بين zod v3 و zod/v4/core يستنتج بعمق لا نهائي (TS2589 / نفاد الذاكرة).
// التسجيل يتم عبر توقيع مبسّط يقبل unknown ويسلك نفس سلوك SDK وقت التشغيل تمامًا.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runGeneration, refreshTask, type GenParams } from "@/lib/generation";
import { runMerge } from "@/lib/merge";
import { listRecentTasks } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تصل 240 ثانية — أقصى مدة دالة على Vercel
export const maxDuration = 300;

// معلومات السيرفر — كما تحددها المواصفة
const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

// التعليمات المُرسلة مع initialize — نص جاهز للعميل
const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ===== مخططات zod للأدوات الخمس — مطابقة للمواصفة حرفيًا =====
// أنواع مستنتجة (v3 خالص) — بلا أي خلط مع أنواع SDK
const IMAGE_SHAPE = {
  prompt: z
    .string()
    .min(1)
    .describe("What to draw. Detailed prompts give better results."),
  model: z
    .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
    .default("gpt-image-2-6/flare-text-to-image"),
  aspect_ratio: z
    .enum([
      "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
      "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3",
    ])
    .default("auto"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  background: z
    .enum(["auto", "transparent", "opaque"])
    .default("auto")
    .describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
  wait_seconds: z.number().int().min(0).max(240).default(90),
};

const VIDEO_SHAPE = {
  prompt: z
    .string()
    .max(4096)
    .describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z
    .string()
    .optional()
    .describe("Optional public image URL as the first frame (image-to-video)."),
  model: z
    .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
    .default("grok-imagine-video-1-5-preview"),
  aspect_ratio: z
    .enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"])
    .default("auto"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  enable_audio: z.boolean().default(true),
  duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25),
};

const MERGE_SHAPE = {
  urls: z
    .array(z.string())
    .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
    .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
    .optional()
    .describe(
      "Public direct video URLs (http/https) in merge order — the first clip starts the final video."
    ),
  task_ids: z
    .array(z.string())
    .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
    .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
    .optional()
    .describe(
      "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
    ),
  wait_seconds: z.number().int().min(0).max(240).default(60),
};

const TASK_SHAPE = {
  task_id: z.string(),
};

const LIST_SHAPE = {
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
};

// ===== بناء خادم MCP (مثيل جديد لكل طلب — وضع Stateless مناسب للـ serverless) =====
// تسجيل الأدوات عبر توقيع مبسّط مطابق تمامًا لسلوك registerTool في وقت التشغيل،
// لكنه يمنع TypeScript من استنتاج أنواع MCP SDK العميقة (TS2589 / استهلاك ذاكرة هائل)
interface LooseMcpServer {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
    },
    cb: (args: unknown, extra: unknown) => Promise<unknown> | unknown
  ): void;
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });
  const reg = server as unknown as LooseMcpServer;

  // ===== 1) generate_image =====
  reg.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns a ready image URL if finished within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: IMAGE_SHAPE,
    },
    async (args, extra) => {
      const params = args as unknown as GenParams;
      const notify = makeNotify(extra);
      const result = await runGeneration("image", params, notify);
      return toolResponse(result.message, result.isError);
    }
  );

  // ===== 2) generate_video =====
  reg.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synced audio, optional image-to-video). Videos take minutes: short wait with live progress streaming, then a task_id — track with get_task every ~10 seconds.",
      inputSchema: VIDEO_SHAPE,
    },
    async (args, extra) => {
      const params = args as unknown as GenParams;
      const notify = makeNotify(extra);
      const result = await runGeneration("video", params, notify);
      return toolResponse(result.message, result.isError);
    }
  );

  // ===== 3) merge_videos =====
  reg.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge multiple clips into ONE final video in the given order. Pass 'urls' (public direct video links — e.g. links returned by generate_video) or 'task_ids' (completed video tasks, resolved from the database in this order — ideal after generating several clips). Merging is usually fast: short wait with live progress streaming, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: MERGE_SHAPE,
    },
    async (args, extra) => {
      const { urls, task_ids, wait_seconds } = args as unknown as {
        urls?: string[];
        task_ids?: string[];
        wait_seconds?: number;
      };
      // نفس دالة البث الموحدة — تتحقق من progressToken قبل الإرسال
      const notify = makeNotify(extra);
      const result = await runMerge({ urls, task_ids, wait_seconds }, notify);
      return toolResponse(result.message, result.isError);
    }
  );

  // ===== 4) get_task =====
  reg.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID — image/video generation AND merging (reads the database and live-updates from the provider/merging service while in progress). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: TASK_SHAPE,
    },
    async (args) => {
      const { task_id } = args as unknown as { task_id: string };
      const result = await refreshTask(task_id);
      return toolResponse(result.message, result.isError);
    }
  );

  // ===== 5) list_media =====
  reg.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the latest stored images/videos/merges with their URLs from the database (no regeneration) — recall previous results.",
      inputSchema: LIST_SHAPE,
    },
    async (args) => {
      const { type, status, limit } = args as unknown as {
        type?: "image" | "video" | "merge";
        status?: "completed" | "failed" | "processing";
        limit?: number;
      };
      const tasks = await listRecentTasks(limit ?? 10, { type, status });
      if (!tasks.length) {
        return toolResponse("لا توجد وسائط مخزنة بعد. ابدأ بتوليد صورة أو فيديو.", false);
      }
      const lines = tasks.map((t, i) => {
        const typeLabel =
          t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
        const statusLabel =
          t.status === "completed"
            ? "✅ مكتملة"
            : t.status === "failed"
              ? "❌ فاشلة"
              : "⏳ جارية";
        let line = `${i + 1}. [${typeLabel}] ${statusLabel} — ${t.model}\n   task_id: ${t.id} — أنشئت: ${t.created_at}`;
        if (t.result_urls_json) {
          try {
            const urls = JSON.parse(t.result_urls_json) as string[];
            for (const u of urls) line += `\n   الرابط: ${u}`;
          } catch {
            /* تجاهل */
          }
        }
        return line;
      });
      return toolResponse(
        `📋 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`,
        false
      );
    }
  );

  return server;
}

function toolResponse(text: string, isError: boolean) {
  return { content: [{ type: "text" as const, text }], isError };
}

// دالة بث إشعارات التقدم أثناء نافذة الانتظار — كل ~3 ثوانٍ
type NotifyExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: Record<string, unknown>;
  }) => Promise<void>;
};

function makeNotify(extra: unknown) {
  return async (progress: number, message: string): Promise<void> => {
    try {
      const ex = extra as NotifyExtra | undefined;
      const progressToken = ex?._meta?.progressToken;
      if (progressToken === undefined || progressToken === null) return;
      await ex!.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total: 100, message },
      });
    } catch {
      /* إشعارات التقدم غير حرجة */
    }
  };
}

// ===== جسر بين Request القياسي في Next.js وبيئة Node الأصلية =====
// الحل المُختبر: خادم HTTP داخلي حقيقي على 127.0.0.1 يستقبل النداءات ويشغّل
// StreamableHTTPServerTransport الرسمي على مكدس Node الأصلي (req/res حقيقيان)،
// ونمُرّ الاستجابة (بما فيها SSE streaming) كما هي إلى Response القياسي.
let internalOrigin: string | null = null;

async function getInternalOrigin(): Promise<string> {
  if (internalOrigin) return internalOrigin;
  const httpServer = http.createServer(async (nodeReq, nodeRes) => {
    // مثيل جديد لكل طلب — وضع بلا جلسات (مناسب لبيئات الـ serverless)
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // بلا جلسات: كل طلب مستقل
    });
    nodeRes.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // اجمع الجسم كاملًا ثم مرره كمُحلَّل جاهز (يتجنب قراءة مجرى req)
      const chunks: Buffer[] = [];
      for await (const c of nodeReq) chunks.push(c as Buffer);
      let parsedBody: unknown = undefined;
      if (chunks.length) {
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsedBody = undefined;
        }
      }
      await transport.handleRequest(nodeReq, nodeRes, parsedBody);
    } catch (e) {
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { "Content-Type": "application/json" });
        nodeRes.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
      }
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as AddressInfo;
  internalOrigin = `http://127.0.0.1:${addr.port}`;
  return internalOrigin;
}

// ترويسات نمررها إلى الخادم الداخلي (بروتوكول MCP يعتمد عليها)
function forwardHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
  ]) {
    const v = req.headers.get(name);
    if (v) headers[name] = v;
  }
  return headers;
}

// تحويل استجابة الـ fetch الداخلي إلى Response قياسي مع دعم SSE streaming
async function proxyResponse(upstream: Response): Promise<Response> {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (["transfer-encoding", "connection", "keep-alive", "content-encoding", "content-length"].includes(k))
      return;
    headers.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

// مصادقة اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
function checkAuth(req: Request): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return null;
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: valid Bearer token required" },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      }
    );
  }
  return null;
}

export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const origin = await getInternalOrigin();
  const body = await req.text();
  const upstream = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: forwardHeaders(req),
    body: body.length ? body : undefined,
  });
  return proxyResponse(upstream);
}

export async function GET(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const origin = await getInternalOrigin();
  const upstream = await fetch(`${origin}/mcp`, {
    method: "GET",
    headers: forwardHeaders(req),
  });
  return proxyResponse(upstream);
}

export async function DELETE(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const origin = await getInternalOrigin();
  const upstream = await fetch(`${origin}/mcp`, {
    method: "DELETE",
    headers: forwardHeaders(req),
  });
  return proxyResponse(upstream);
}
