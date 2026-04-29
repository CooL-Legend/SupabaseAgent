# Deployment — SupabaseAgent + auto-embedder (single Cloud Run service)

This image runs **two processes side by side** in one container:

| Process | Listens on | Public? | What it does |
|---|---|---|---|
| Node (`tsx app/server.ts`) | `$PORT` (8080) | yes (Cloud Run) | CSV → Supabase ingest UI/API |
| Python (`uvicorn embedder.main:app`) | `127.0.0.1:8081` | **internal only** | After every successful upsert into `products`, embeds NULL `product_embedding` rows with FashionSigLIP and writes them back |

`app/server.ts` calls `triggerEmbedder()` after `batchUpsert` completes.
That's a fire-and-forget POST to `http://127.0.0.1:8081/run` — the upsert
HTTP response returns immediately; embedding happens in the background process.

## Required env vars

These must be set on the Cloud Run service:

```
DATABASE_URL                   Supabase Postgres DSN with UPDATE on products
NEXT_PUBLIC_SUPABASE_URL       https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY      service role JWT (already used by SupabaseAgent)
GOOGLE_PROJECT_ID              for Gemini
GOOGLE_SERVICE_ACCOUNT_JSON    or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
GEMINI_MODEL                   e.g. gemini-3-flash-preview
```

The Dockerfile sets these automatically — don't override:

```
PORT=8080                       Cloud Run serves Node here
EMBEDDER_INTERNAL_PORT=8081     Python embedder (loopback only)
EMBEDDER_URL=http://127.0.0.1:8081   triggerEmbedder() target
```

`SUPABASE_DB_URL` is auto-mirrored from `DATABASE_URL` by `start.sh`, so the
Python embedder uses the same DSN as Node — no separate config.

## Deploy

```bash
cd /Users/varuntyagi/Downloads/SupabaseAgent

gcloud run deploy supabase-agent \
  --source . \
  --region us-central1 \
  --memory 4Gi \
  --cpu 2 \
  --timeout 600 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --allow-unauthenticated
```

Why these settings:

- **`--memory 4Gi`** — torch + FashionSigLIP weights + Node + Express ≈ 1.7 GB at rest, 2-2.5 GB under load. 4 GiB is comfortable headroom.
- **`--cpu 2`** — embedding is CPU-bound (no GPU on default Cloud Run). 2 vCPU keeps a single embed under ~1 s per image.
- **`--min-instances 1`** — the FashionSigLIP model takes 30-60 s to load. Without this, every cold start delays the first embed call.
- **`--max-instances 3`** — embedding workloads scale poorly past a few instances; this caps cost.
- **`--timeout 600`** — embedding 200 rows takes ~3 min on CPU. The default 60 s would cut off larger batches.

The image is large (~2 GB) because the FashionSigLIP weights are pre-baked
into it — that trades image size for one-time download cost on each cold start.

## Verify after deploy

```bash
SERVICE_URL="$(gcloud run services describe supabase-agent --region us-central1 --format='value(status.url)')"

# 1. UI works
curl -sf "${SERVICE_URL}/api/tables" | head

# 2. Embedder is alive (internal port — only via SSH/Cloud Shell into the
#    container, OR add a debug endpoint. Easier: trigger a small ingest
#    and watch logs:)
gcloud run services logs read supabase-agent --region us-central1 --limit 50 \
    | grep -E "embedder|embed_pending"
```

## Optional: safety-net cron

Cloud Run shuts down idle instances if min-instances=0. Even with min=1, a
crashed embedder process won't auto-recover. A cron tick every 5 minutes is
cheap insurance:

```bash
gcloud scheduler jobs create http embedder-tick \
  --schedule="*/5 * * * *" \
  --uri="${SERVICE_URL}/api/embed/run?limit=200" \
  --http-method=POST
```

Note: the `/api/embed/run` route doesn't exist yet on the Node side — the
embedder is internal. If you want this safety net, also add a thin Node
proxy handler that forwards to `http://127.0.0.1:8081/run`. (Not strictly
needed; the SupabaseAgent post-upsert hook covers the normal path.)

## Local dev

```bash
# Two-terminal setup, mirroring what the container does:

# Terminal 1 — Python embedder
cd embedder
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
SUPABASE_DB_URL='postgres://...' uvicorn main:app --host 127.0.0.1 --port 8081

# Terminal 2 — SupabaseAgent
EMBEDDER_URL=http://127.0.0.1:8081 npm start
```

Or build the Docker image and run it:

```bash
docker build -t supabase-agent-bundle .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL='postgres://...' \
  -e NEXT_PUBLIC_SUPABASE_URL='https://...' \
  -e SUPABASE_SERVICE_ROLE_KEY='...' \
  -e GOOGLE_PROJECT_ID='...' \
  -e GOOGLE_CLIENT_EMAIL='...' \
  -e GOOGLE_PRIVATE_KEY='...' \
  supabase-agent-bundle
```

## Trigger flow (end-to-end)

```
[friend uploads CSV via web UI]
        ↓
POST /api/analyze              → Gemini maps columns
POST /api/feedback (optional)  → friend reviews mapping
POST /api/ingest               → batchUpsert(products, rows) ──┐
        │                                                       │
        │ ←─── HTTP 200 returned ─── friend sees "done"         │
        │                                                       │
        ▼                                                       │
triggerEmbedder("products", 50) ──→ POST 127.0.0.1:8081/run ←──┘
                                            │
                                            ▼
                                    Python embedder:
                                      • SELECT id, image_url FROM products
                                          WHERE product_embedding IS NULL LIMIT 100
                                      • download images (16-way)
                                      • FashionSigLIP encode (batch 16)
                                      • UPDATE products SET product_embedding = …
```

## Files added in this revision

```
SupabaseAgent/
├── Dockerfile                       (new)
├── start.sh                         (new — process orchestrator)
├── .dockerignore                    (new)
├── DEPLOY.md                        (this file)
├── embedder/                        (new — Python service)
│   ├── __init__.py
│   ├── main.py                      (FastAPI: /health, /run)
│   └── requirements.txt
├── src/integrations/
│   └── embedderHook.ts              (TS hook used by app/server.ts)
└── app/server.ts                    (edited — calls triggerEmbedder after batchUpsert)
```
