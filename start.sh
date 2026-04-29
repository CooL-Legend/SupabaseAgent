#!/bin/sh
# Boot order:
#   1. Launch the Python embedder on 127.0.0.1:$EMBEDDER_INTERNAL_PORT (background)
#   2. Wait for it to report /health (≤ 2 min)
#   3. Launch Node on $PORT (foreground; PID 1)
#
# If the embedder fails to come up, Node still starts — auto-embedding will be
# silently skipped (the hook logs a warning) but CSV ingest keeps working.

set -e

INTERNAL_PORT="${EMBEDDER_INTERNAL_PORT:-8081}"

# Mirror DATABASE_URL → SUPABASE_DB_URL for the Python embedder if not set
# explicitly. SupabaseAgent uses DATABASE_URL; the embedder uses SUPABASE_DB_URL.
if [ -z "${SUPABASE_DB_URL}" ] && [ -n "${DATABASE_URL}" ]; then
    export SUPABASE_DB_URL="${DATABASE_URL}"
fi

echo "[start] launching Python embedder on 127.0.0.1:${INTERNAL_PORT}…"
uvicorn embedder.main:app \
    --host 127.0.0.1 \
    --port "${INTERNAL_PORT}" \
    --no-access-log \
    > /tmp/embedder.log 2>&1 &
EMBEDDER_PID=$!

echo "[start] embedder PID=${EMBEDDER_PID}, waiting for /health…"
HEALTHY=0
for i in $(seq 1 60); do
    # Embedder process died? bail with its log.
    if ! kill -0 "${EMBEDDER_PID}" 2>/dev/null; then
        echo "[start] embedder process exited unexpectedly. Log:" >&2
        tail -100 /tmp/embedder.log >&2 || true
        # Don't kill the container — Node should still come up so the friend
        # can ingest CSVs. Auto-embed just won't fire.
        break
    fi
    if curl -sf "http://127.0.0.1:${INTERNAL_PORT}/health" > /dev/null 2>&1; then
        HEALTHY=1
        echo "[start] embedder ready (after ${i} probes)"
        break
    fi
    sleep 2
done

if [ "${HEALTHY}" -ne 1 ]; then
    echo "[start] WARNING: embedder did not report /health in 120s. Continuing anyway." >&2
    echo "[start] last 50 lines of /tmp/embedder.log:" >&2
    tail -50 /tmp/embedder.log >&2 || true
fi

# Forward signals to embedder so Cloud Run shutdown is clean.
trap 'echo "[start] shutting down…"; kill ${EMBEDDER_PID} 2>/dev/null || true; exit 0' INT TERM

# Hand off to Node. tsx runs TypeScript directly — matches `npm start`.
echo "[start] launching Node on PORT=${PORT:-8080}…"
exec npx tsx app/server.ts
