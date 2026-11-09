// POST /api/read-invoice  { data: base64, media_type }  ->  { draft } or { error }
// A Vercel Function. Needs ANTHROPIC_API_KEY in the Vercel project's
// environment. Stores nothing: the file goes to Claude and the draft comes back.

import Anthropic from "@anthropic-ai/sdk";
import { MAX_BASE64, MEDIA_TYPES, readInvoice, type MediaType } from "./_invoice.js";

// Best effort per running instance: 10 invoices per visitor per hour.
const LIMIT = 10;
const WINDOW_MS = 3_600_000;
const seen = new Map<string, number[]>();

function allowed(ip: string): boolean {
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return false;
  recent.push(now);
  seen.set(ip, recent);
  return true;
}

const fail = (status: number, error: string) => Response.json({ error }, { status });

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return fail(405, "Use POST.");
    // Only Keel's own pages may call this.
    // Browsers always send Origin on a cross-origin or POST fetch; plain curl calls without it are
    // refused, so nobody can run up the deployment's Claude bill from a script.
    const origin = request.headers.get("origin");
    if (!origin) return fail(403, "Upload invoices from Keel's app.");
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      return fail(403, "Not allowed from another site.");
    }
    if (host !== new URL(request.url).host) return fail(403, "Not allowed from another site.");
    if (!process.env.ANTHROPIC_API_KEY) return fail(503, "Invoice reading is not set up on this deployment (no ANTHROPIC_API_KEY).");
    const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    if (!allowed(ip)) return fail(429, "Too many invoices this hour. Try again later or fill in the bill by hand.");

    let body: { data?: unknown; media_type?: unknown };
    try {
      body = await request.json();
    } catch {
      return fail(400, "Send JSON with data and media_type.");
    }
    const data = typeof body.data === "string" ? body.data : "";
    const mediaType = body.media_type as MediaType;
    if (!MEDIA_TYPES.includes(mediaType)) return fail(415, "Send a PDF, PNG, JPEG or WebP file.");
    if (!data || data.length > MAX_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return fail(413, "The file is empty or over 3 MB.");

    try {
      const client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
      return Response.json({ draft: await readInvoice(client, data, mediaType) });
    } catch (e) {
      if (e instanceof Anthropic.APIError) return fail(502, `Claude could not read the invoice (${e.status ?? "error"}).`);
      return fail(500, e instanceof Error ? e.message.slice(0, 160) : "Could not read the invoice.");
    }
  },
};
