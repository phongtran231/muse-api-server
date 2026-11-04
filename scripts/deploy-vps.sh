#!/usr/bin/env bash
# Rebuilds and restarts the API container on the VPS. Run from the repo root after
# `git pull` (the GitHub Actions deploy key runs /usr/local/bin/muse-deploy, which
# pulls main and then execs this script).
set -euo pipefail

CONTAINER=muse-api-server-api-1
MONGO=muse-api-server-mongo-1
JOB_WAIT_SECONDS=${JOB_WAIT_SECONDS:-600}
HEALTH_WAIT_SECONDS=${HEALTH_WAIT_SECONDS:-180}

echo "Deploying $(git log --oneline -1)"

# A restart re-queues running jobs and loses their progress: give them time to finish.
active_jobs() {
  docker exec "$MONGO" mongosh muse_api --quiet --eval \
    'print(db.jobs.countDocuments({ status: { $in: ["running", "queued"] } }))' 2>/dev/null || echo 0
}
waited=0
while [ "$(active_jobs)" -gt 0 ] && [ "$waited" -lt "$JOB_WAIT_SECONDS" ]; do
  echo "Waiting for $(active_jobs) running/queued job(s) to finish (${waited}s)..."
  sleep 15
  waited=$((waited + 15))
done
if [ "$(active_jobs)" -gt 0 ]; then
  echo "Jobs still active after ${JOB_WAIT_SECONDS}s; restarting anyway (they are re-queued)."
fi

docker compose build api
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
