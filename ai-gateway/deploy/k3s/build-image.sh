#!/usr/bin/env bash
# 建 AI 閘道的映像檔、匯入 k3s，再把 Deployment 換成新版（沿用 ahp-match 的 deploy/k3s/build-image.sh）
# 用法：ai-gateway/deploy/k3s/build-image.sh
# tag 是 git commit，所以建置用到的檔案有還沒 commit 的改動就不建
set -euo pipefail
cd "$(dirname "$0")/../../.."

ns=sch001-ai
deploy=ai-gateway
dir=ai-gateway/deploy/k3s

# 同時跑兩個會互相把對方的版本解除釘選
exec 9>"$(git rev-parse --git-common-dir)/build-image-ai-gateway.lock"
flock -n 9 || { echo "另一個 build-image.sh 還在跑" >&2; exit 1; }

inputs=(ai-gateway/src ai-gateway/licenses "$dir/Containerfile" "$dir/.containerignore")
if [ -n "$(git status --porcelain -- "${inputs[@]}")" ]; then
  echo "這些檔案有還沒 commit 的改動，映像檔會對不到 commit：" >&2
  git status --short -- "${inputs[@]}" >&2
  exit 1
fi
# git status 看不到被 .gitignore 忽略的檔案。.containerignore 擋得住 .env、node_modules 與 log，其他被忽略
# 的檔案仍會跟著白名單 COPY 進映像檔，映像檔就對不到 commit
ignored=$(git ls-files -o -i --exclude-standard -- "${inputs[@]}")
if [ -n "$ignored" ]; then
  echo "這些檔案被 .gitignore 忽略、不在 commit 裡，卻會被 COPY 進映像檔（先刪掉或移走）：" >&2
  printf '%s\n' "$ignored" >&2
  exit 1
fi
# manifest 會整份套用，沒 commit 的設定會跟著上線
if [ -n "$(git status --porcelain -- "$dir/namespace.yaml" "$dir/app.yaml")" ]; then
  echo "$dir 的 manifest 有還沒 commit 的改動，先 commit（上次部署失敗的話用 git checkout 還原）" >&2
  exit 1
fi

# 舊 pod 還在收尾時不換版，理由見 ai-gateway/README.md 的「部署」
"$dir/terminating-pods.sh"

# key 的 Secret 不進 git；沒有的話 pod 會卡在 ContainerCreating，先擋下來並說明怎麼建
sudo k3s kubectl apply -f "$dir/namespace.yaml"
if ! sudo k3s kubectl -n "$ns" get secret ai-gateway-env >/dev/null 2>&1; then
  echo "還沒有 Secret ai-gateway-env。建立方式見 ai-gateway/README.md 的「部署」" >&2
  exit 1
fi

tag="localhost/sch001-ai-gateway:$(git rev-parse --short=12 HEAD)"
buildah build --pull=missing -f "$dir/Containerfile" --ignorefile "$dir/.containerignore" -t "$tag" .

# buildah 跟 k3s 各有自己的映像檔倉庫：先匯出成檔案，再匯入 k3s 的 containerd
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
buildah push "$tag" "docker-archive:$archive:$tag"
sudo k3s ctr images import "$archive"
# 釘選，免得磁碟吃緊時被 kubelet 清掉（Never 拉不回來）
sudo k3s ctr images label "$tag" io.cri-containerd.pinned=pinned

# 換版前在跑的那版也留著釘選，rollout undo 才退得回去
running=$(sudo k3s kubectl -n "$ns" get "deployment/$deploy" -o 'jsonpath={.spec.template.spec.containers[0].image}' 2>/dev/null || true)

# 建置期間才開始收尾的也要擋。擋下時映像檔已匯入、釘選，app.yaml 與 Deployment 還沒動
"$dir/terminating-pods.sh"

# manifest 記下這次部署的版本（之後要 commit），再照 manifest 套用
sed -i "s#image: localhost/sch001-ai-gateway:[0-9a-f]*\$#image: $tag#" "$dir/app.yaml"
# 寫法不一樣（加引號、多空白）時 sed 什麼都沒換，套用後還會以為上了新版
grep -qx " *image: $tag" "$dir/app.yaml" || { echo "app.yaml 的 image 沒換成 $tag，沒有套用" >&2; exit 1; }
sudo k3s kubectl apply -f "$dir/app.yaml"
sudo k3s kubectl -n "$ns" rollout status "deployment/$deploy" --timeout=180s

# 換版成功才放掉更舊版本的釘選，之後磁碟吃緊時 kubelet 就清得掉；ctr 失敗要讓腳本停下來
images=$(sudo k3s ctr images ls -q)
for old in $(printf '%s\n' "$images" | grep '^localhost/sch001-ai-gateway:'); do
  [ "$old" = "$tag" ] || [ "$old" = "$running" ] || sudo k3s ctr images label "$old" io.cri-containerd.pinned=
done
