"""
Embedder Cloud Run service — runs the FashionSigLIP embedding pipeline against Supabase.

Endpoints:
  GET  /health   liveness + model-loaded flag
  POST /run      process up to `limit` rows where product_embedding IS NULL
                 (returns immediately with counts; idempotent — safe to call repeatedly)
  POST /embed    embed a single image (URL or base64) — used by tryown_backend
                 visual-search. Accepts an optional crop region; when set, the
                 returned vector is 0.7·crop + 0.3·full (renormalized) — the
                 cloth_segmentation combined-embedding scheme.

Trigger sources (any of):
  • SupabaseAgent post-upsert hook (fires after CSV ingest succeeds)
  • Cloud Scheduler (cron, e.g. every 5 min) as a safety net
  • Manual: curl https://<service>/run

Env:
  SUPABASE_DB_URL   required, write-capable Postgres DSN for Supabase
  EMBEDDER_TOKEN    optional, if set requires `Authorization: Bearer <token>`
  BATCH_SIZE        GPU/CPU encode batch (default 16)
  DL_WORKERS        parallel image downloads (default 8)
  MAX_LIMIT         max rows per /run call (default 200; clamps the ?limit= param)
"""
import base64
import io
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from typing import List, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import numpy as np
import psycopg2
import requests
from PIL import Image
from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("embedder")

SUPABASE_DB_URL = os.environ.get("SUPABASE_DB_URL", "").strip()
EMBEDDER_TOKEN  = os.environ.get("EMBEDDER_TOKEN", "").strip()
BATCH_SIZE      = int(os.environ.get("BATCH_SIZE", "16"))
DL_WORKERS      = int(os.environ.get("DL_WORKERS", "8"))
MAX_LIMIT       = int(os.environ.get("MAX_LIMIT", "200"))
HTTP_TIMEOUT    = 15

# Loaded once at startup
_model = None
_preprocess = None
_device: Optional[str] = None


def clean_dsn(url: str) -> str:
    p = urlparse(url)
    keep = [(k, v) for k, v in parse_qsl(p.query) if k == "sslmode"]
    if not any(k == "sslmode" for k, _ in keep):
        keep.append(("sslmode", "require"))
    return urlunparse((p.scheme, p.netloc, p.path, "", urlencode(keep), ""))


def vec_literal(arr) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in arr) + "]"


def load_model():
    global _model, _preprocess, _device
    import open_clip
    import torch

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("Loading FashionSigLIP on %s…", _device)
    _model, _, _preprocess = open_clip.create_model_and_transforms(
        "hf-hub:Marqo/marqo-fashionSigLIP"
    )
    _model = _model.to(_device).eval()
    log.info("Model loaded.")


def _fetch_and_preprocess(args):
    pid, url = args
    try:
        r = requests.get(url, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        return pid, _preprocess(img)
    except Exception as e:
        log.warning("download failed for %s: %s", pid, e)
        return pid, None


def fetch_pending(dsn: str, limit: int):
    sql = """
        SELECT id::text, image_url
        FROM products
        WHERE product_embedding IS NULL
          AND image_url IS NOT NULL
          AND image_url <> ''
        LIMIT %s
    """
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        return cur.fetchall()


def write_embeddings(dsn: str, rows):
    if not rows:
        return 0
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        execute_values(
            cur,
            """
            UPDATE products
            SET product_embedding = data.emb::vector
            FROM (VALUES %s) AS data(id, emb)
            WHERE products.id::text = data.id
            """,
            rows,
            page_size=100,
        )
        conn.commit()
    return len(rows)


def embed_pending(pending):
    import torch

    out = []
    batch_ids, batch_tensors = [], []

    def flush():
        nonlocal batch_ids, batch_tensors
        if not batch_tensors:
            return
        batch = torch.stack(batch_tensors).to(_device)
        with torch.no_grad():
            feats = _model.encode_image(batch)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        feats_np = feats.cpu().numpy()
        for j, pid in enumerate(batch_ids):
            out.append((pid, vec_literal(feats_np[j])))
        batch_ids, batch_tensors = [], []

    with ThreadPoolExecutor(max_workers=DL_WORKERS) as ex:
        futures = [ex.submit(_fetch_and_preprocess, item) for item in pending]
        for fut in as_completed(futures):
            pid, t = fut.result()
            if t is None:
                continue
            batch_ids.append(pid)
            batch_tensors.append(t)
            if len(batch_tensors) >= BATCH_SIZE:
                flush()
    flush()
    return out


def check_auth(authorization: Optional[str]):
    if not EMBEDDER_TOKEN:
        return  # no auth configured — open
    if authorization != f"Bearer {EMBEDDER_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid bearer token")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not SUPABASE_DB_URL:
        log.warning("SUPABASE_DB_URL not set — /run will 500 until configured")
    load_model()
    yield


app = FastAPI(title="FashionSigLIP embedder", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": True,
        "model_loaded": _model is not None,
        "device": _device,
    }


@app.post("/run")
def run(
    limit: int = Query(50, ge=1, le=10_000),
    authorization: Optional[str] = Header(None),
):
    check_auth(authorization)
    if not SUPABASE_DB_URL:
        raise HTTPException(500, "SUPABASE_DB_URL not configured")

    limit = min(limit, MAX_LIMIT)
    dsn = clean_dsn(SUPABASE_DB_URL)
    t0 = time.time()

    pending = fetch_pending(dsn, limit)
    if not pending:
        return {"pending": 0, "embedded": 0, "failed": 0, "elapsed_s": 0.0}

    log.info("processing %d pending rows…", len(pending))
    embedded = embed_pending(pending)
    n = write_embeddings(dsn, embedded)
    elapsed = round(time.time() - t0, 2)
    log.info("done: embedded=%d/%d in %.1fs", n, len(pending), elapsed)
    return {
        "pending": len(pending),
        "embedded": n,
        "failed": len(pending) - n,
        "elapsed_s": elapsed,
    }


# ── /embed (visual-search backend uses this) ────────────────────────────────

CROP_WEIGHT = 0.7   # combined query weights — must match cloth_segmentation
FULL_WEIGHT = 1.0 - CROP_WEIGHT


class CropBox(BaseModel):
    x: int = Field(..., ge=0, description="left in original image pixels")
    y: int = Field(..., ge=0, description="top in original image pixels")
    w: int = Field(..., gt=0, description="width in pixels")
    h: int = Field(..., gt=0, description="height in pixels")


class EmbedRequest(BaseModel):
    image_url: Optional[str] = Field(None, description="HTTP(S) URL of the full image")
    image_base64: Optional[str] = Field(None, description="data: URL or raw base64 of full image")
    crop: Optional[CropBox] = Field(None, description="if set, embed full + crop and return weighted combo")


class EmbedResponse(BaseModel):
    embedding: List[float]
    dim: int
    combined: bool
    elapsed_s: float


def _load_image(url: Optional[str], b64: Optional[str]) -> Image.Image:
    if not url and not b64:
        raise HTTPException(400, "provide image_url or image_base64")
    if url:
        try:
            r = requests.get(url, timeout=HTTP_TIMEOUT)
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception as e:
            raise HTTPException(400, f"failed to fetch image_url: {e}")
    # base64 path — accept "data:image/...;base64,XXX" or raw base64
    payload = b64
    if "," in payload and payload.startswith("data:"):
        payload = payload.split(",", 1)[1]
    try:
        raw = base64.b64decode(payload)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"invalid image_base64: {e}")


def _encode_pil(img: Image.Image) -> np.ndarray:
    """Run a single PIL image through FashionSigLIP. Returns L2-normalized 768-dim vec."""
    import torch

    tensor = _preprocess(img).unsqueeze(0).to(_device)
    with torch.no_grad():
        feat = _model.encode_image(tensor)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat.cpu().numpy().flatten().astype(np.float32)


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest, authorization: Optional[str] = Header(None)):
    """Embed a single user image. Optionally combine with a crop region.

    Mirrors cloth_segmentation/search_app.py:combined_query_vec — when `crop`
    is provided, returns 0.7·crop + 0.3·full (re-normalized). Without a crop,
    returns the full-image embedding alone.
    """
    check_auth(authorization)
    if _model is None:
        raise HTTPException(503, "model not loaded yet")

    t0 = time.time()
    full_img = _load_image(req.image_url, req.image_base64)
    full_vec = _encode_pil(full_img)

    if not req.crop:
        return EmbedResponse(
            embedding=full_vec.tolist(),
            dim=int(full_vec.shape[0]),
            combined=False,
            elapsed_s=round(time.time() - t0, 3),
        )

    # Clamp crop to image bounds defensively
    W, H = full_img.size
    x = max(0, min(req.crop.x, W - 1))
    y = max(0, min(req.crop.y, H - 1))
    w = max(1, min(req.crop.w, W - x))
    h = max(1, min(req.crop.h, H - y))
    if w < 10 or h < 10:
        raise HTTPException(400, f"crop too small after clamp: {w}×{h}")

    crop_img = full_img.crop((x, y, x + w, y + h))
    crop_vec = _encode_pil(crop_img)

    combined = CROP_WEIGHT * crop_vec + FULL_WEIGHT * full_vec
    norm = float(np.linalg.norm(combined))
    if norm > 0:
        combined = combined / norm

    return EmbedResponse(
        embedding=combined.tolist(),
        dim=int(combined.shape[0]),
        combined=True,
        elapsed_s=round(time.time() - t0, 3),
    )
