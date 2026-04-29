# SupabaseAgent + FashionSigLIP embedder, single image.
#
# Two processes share this container:
#   1. Python (uvicorn) — embedder service on 127.0.0.1:8081 (internal only)
#   2. Node (tsx app/server.ts) — Express server on $PORT (Cloud Run public)
#
# After every successful upsert into `products`, app/server.ts fires a
# fire-and-forget POST to http://127.0.0.1:8081/run, which embeds NULL
# product_embedding rows.

FROM python:3.11-slim

# ── System deps + Node 20 ────────────────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python deps (CPU-only torch wheels) ──────────────────────────────────────
COPY embedder/requirements.txt embedder/requirements.txt
RUN pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r embedder/requirements.txt

# Pre-download FashionSigLIP weights so cold-start doesn't pull ~880MB from HF.
ENV HF_HOME=/root/.cache/huggingface
RUN python -c "import open_clip; open_clip.create_model_and_transforms('hf-hub:Marqo/marqo-fashionSigLIP')"

# ── Node deps ────────────────────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci

# ── App code ─────────────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY src ./src
COPY app ./app
COPY embedder ./embedder

# Boot script
COPY start.sh ./
RUN chmod +x start.sh

# ── Runtime config ───────────────────────────────────────────────────────────
# Cloud Run injects $PORT (default 8080). EMBEDDER_INTERNAL_PORT stays internal.
ENV PORT=8080 \
    EMBEDDER_INTERNAL_PORT=8081 \
    EMBEDDER_URL=http://127.0.0.1:8081 \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["./start.sh"]
