#!/usr/bin/env bash
# Rebuilds and restarts the API container on the VPS. Run from the repo root after
# `git pull` (the GitHub Actions deploy key runs /usr/local/bin/muse-deploy, which
# pulls main and then execs this script).
set -euo pipefail

# Container names differ per host (compose project); override with env vars.
CONTAINER=${CONTAINER:-muse-api-server-api-1}
MONGO=${MONGO:-muse-api-server-mongo-1}
JOB_WAIT_SECONDS=${JOB_WAIT_SECONDS:-0}
HEALTH_WAIT_SECONDS=${HEALTH_WAIT_SECONDS:-180}

echo "Deploying $(git log --oneline -1)"

# Build while the old container keeps serving.
docker compose build api

# No waiting for jobs: on a busy server they never all finish, and the API shuts
# down gracefully on its own (stops claiming, gives running jobs
# SHUTDOWN_GRACE_MS, then re-queues the rest without consuming an attempt).
# JOB_WAIT_SECONDS > 0 restores a bounded wait for *running* jobs only.
running_jobs() {
  docker exec "$MONGO" mongosh muse_api --quiet --eval \
    'print(db.jobs.countDocuments({ status: "running" }))' 2>/dev/null || echo 0
}
waited=0
while [ "$waited" -lt "$JOB_WAIT_SECONDS" ] && [ "$(running_jobs)" -gt 0 ]; do
  echo "Waiting for $(running_jobs) running job(s) (${waited}s of ${JOB_WAIT_SECONDS}s)..."
  sleep 5
  waited=$((waited + 5))
done

docker compose up -d api

waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" = healthy ]; do
  if [ "$waited" -ge "$HEALTH_WAIT_SECONDS" ]; then
    echo "Container is not healthy after ${HEALTH_WAIT_SECONDS}s. Last logs:"
    docker logs --tail 80 "$CONTAINER" 2>&1 | sed -E 's#://[^@ /]*@#://***@#g'
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

echo "Deployed and healthy: $(git log --oneline -1)"
