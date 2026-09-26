#!/usr/bin/env bash
# SECURITY section 8: run the hostile-repo suite inside the worker image, hardened like deploy/compose.yaml, under
# strace, and fail if anything executes, connects or writes outside the sandbox. Needs Docker and the worker image
# (docker compose -f deploy/compose.yaml --profile worker build worker).
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q -t afterglow-worker-audit -f deploy/audit/Dockerfile.worker-audit deploy >/dev/null
docker run --rm \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 1g --cpus 1 \
  --network none \
  --tmpfs /scratch:size=1100m,uid=10002,gid=10002,mode=0700 \
  -v "$PWD/backend/tests:/srv/tests:ro" -v "$PWD/deploy/audit/trace_check.py:/srv/trace_check.py:ro" \
  -e HOME=/scratch/home -e TMPDIR=/scratch/tmp -e PYTHONDONTWRITEBYTECODE=1 \
  afterglow-worker-audit sh -c '
    set -e
    mkdir -p /scratch/home /scratch/tmp
    strace -f -qq -s 256 -e trace=execve,connect,openat -o /scratch/trace.log \
      python -m pytest -q -p no:cacheprovider --noconftest --basetemp=/scratch/pytest tests/test_hostile.py
    python /srv/trace_check.py /scratch/trace.log /scratch'
