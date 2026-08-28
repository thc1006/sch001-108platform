#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS=${RUNS:-12}
P=9601
for v in "$@"; do
  echo "═════ 量測 $v （runs=$RUNS）═════"
  node perf/measure.mjs --variant "$v" --root "perf/roots/$v" --port $P --runs "$RUNS" --out "perf/out/$v.json"
  P=$((P+1))
done
echo "ALL DONE"
