#!/usr/bin/env bash
# 依序建置每個候選變體，把產物放到 perf/roots/<variant>/sch001-108platform/。
# 每個變體建完就還原 src/ 與 public/，確保變體之間不互相污染。
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

restore() {
  git checkout -- src/ >/dev/null 2>&1 || true
  rm -rf public/fonts
}

for v in "$@"; do
  echo "───────── 建置變體 $v ─────────"
  restore
  node perf/apply-variant.mjs "$v" || { restore; exit 1; }
  npm run build:deployable >"perf/out/build-$v.log" 2>&1 || { echo "建置失敗，見 perf/out/build-$v.log"; tail -20 "perf/out/build-$v.log"; restore; exit 1; }
  rm -rf "perf/roots/$v"
  mkdir -p "perf/roots/$v/sch001-108platform"
  cp -a dist/. "perf/roots/$v/sch001-108platform/"
  echo "  → perf/roots/$v  ($(du -sh dist | cut -f1))"
done
restore
echo "全部完成，src/ 已還原："
git status --porcelain src/ public/ || true
