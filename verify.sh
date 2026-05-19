#!/usr/bin/env sh
# verify.sh —— 建置驗證腳本。
# 供 .claude 的 TaskCompleted 品質閘 hook、本機與 CI 共用。
# 非互動 shell 的 PATH 通常缺 node,這裡補上 fnm 安裝的 node。
set -e

for d in "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

if ! command -v npm >/dev/null 2>&1; then
  echo "verify.sh: 找不到 npm —— 請安裝 node 或修正 PATH。" >&2
  exit 1
fi

npm run build
