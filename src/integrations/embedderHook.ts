/**
 * Post-upsert hook that pings an external embedder service.
 *
 * The embedder is a separate Cloud Run service (cloth_segmentation/embed_service)
 * that runs FashionSigLIP, finds rows with `product_embedding IS NULL` in the
 * Supabase `products` table, and writes the 768-dim vectors back.
 *
 * Fire-and-forget: never awaited, never throws — failures are logged but never
 * affect the upsert response.
 *
 * Env:
 *   EMBEDDER_URL    base URL of the embedder service (e.g. https://embedder-xxx.run.app)
 *                   if unset, this function is a no-op
 *   EMBEDDER_TOKEN  optional bearer token expected by the embedder
 *   EMBEDDER_TABLES comma-separated list of table names that should trigger
 *                   embedding (default: "products")
 */

function eligibleTables(): Set<string> {
  const raw = process.env.EMBEDDER_TABLES?.trim() || "products";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function tableMatches(tableName: string, allowed: Set<string>): boolean {
  // accept "products" or "public.products"
  const lc = tableName.toLowerCase();
  if (allowed.has(lc)) return true;
  const bare = lc.includes(".") ? lc.split(".").pop()! : lc;
  return allowed.has(bare);
}

export function triggerEmbedder(tableName: string, rowsUpserted: number): void {
  const url = process.env.EMBEDDER_URL?.trim();
  if (!url) return;
  if (rowsUpserted <= 0) return;
  if (!tableMatches(tableName, eligibleTables())) return;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.EMBEDDER_TOKEN?.trim();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Limit param tells the embedder how many rows to process this tick. We pass
  // rowsUpserted-with-headroom so a single batch will catch up to what we just
  // ingested. Cloud Scheduler / repeat calls cover any leftover.
  const limit = Math.min(Math.max(rowsUpserted * 2, 50), 1000);
  const fullUrl = `${url.replace(/\/$/, "")}/run?limit=${limit}`;

  fetch(fullUrl, { method: "POST", headers })
    .then(async (resp) => {
      if (!resp.ok) {
        console.warn(
          `[embedder] non-OK response from ${fullUrl}: ${resp.status} ${resp.statusText}`,
        );
        return;
      }
      const body = await resp.json().catch(() => ({}));
      console.log(`[embedder] triggered for ${tableName}:`, body);
    })
    .catch((err) => {
      console.warn(`[embedder] trigger failed:`, err?.message ?? err);
    });
}
