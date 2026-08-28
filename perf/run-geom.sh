#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# baseline 抓兩次：控制實驗。同一份產出跟自己比，差異必須是 0；
# 不是 0 就代表量測本身有競態，後面所有比較都不能採信。
node perf/layout-geom.mjs --root perf/roots/baseline --port 9801 --out perf/out/geom-baseline-1.json
node perf/layout-geom.mjs --root perf/roots/baseline --port 9802 --out perf/out/geom-baseline-2.json
node perf/layout-geom.mjs --root perf/roots/C  --port 9803 --out perf/out/geom-C.json
node perf/layout-geom.mjs --root perf/roots/A  --port 9804 --out perf/out/geom-A.json
node perf/layout-geom.mjs --root perf/roots/D2 --port 9805 --out perf/out/geom-D2.json
echo "GEOM DONE"
