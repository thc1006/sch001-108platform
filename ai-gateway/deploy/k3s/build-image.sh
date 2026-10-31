#!/usr/bin/env bash
# 建 AI 閘道的映像檔、匯入 k3s，再把 Deployment 換成新版（沿用 ahp-match 的 deploy/k3s/build-image.sh）
# 用法：ai-gateway/deploy/k3s/build-image.sh
# tag 是 git commit，所以建置用到的檔案有還沒 commit 的改動就不建
set -euo pipefail
cd "$(dirname "$0")/../../.."

ns=sch001-ai
deploy=ai-gateway
dir=ai-gateway/deploy/k3s

# 同時跑兩個會互相刪掉對方的版本
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
  echo "$dir 的 manifest 有還沒 commit 的改動：上次換版改的 image 用 git checkout 還原，其他的先 commit" >&2
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

repo=localhost/sch001-ai-gateway
tag="$repo:$(git rev-parse --short=12 HEAD)"
# 同一個 commit 重建時，舊的那份會失去 tag，換版成功後一起刪
old_id=$(buildah images --format '{{.ID}} {{.Name}}:{{.Tag}}' | awk -v t="$tag" '$2 == t { print $1 }')
buildah build --pull=missing -f "$dir/Containerfile" --ignorefile "$dir/.containerignore" -t "$tag" .

# buildah 跟 k3s 各有自己的映像檔倉庫：先匯出成檔案，再匯入 k3s 的 containerd
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
buildah push "$tag" "docker-archive:$archive:$tag"
# 同樣地，重新匯入時舊的那份只剩 sha256 參照
old_digest=$(sudo k3s ctr images ls "name==$tag" | awk 'NR > 1 { print $3 }')
sudo k3s ctr images import "$archive"
# 釘選，免得磁碟吃緊時被 kubelet 清掉（Never 拉不回來）
sudo k3s ctr images label "$tag" io.cri-containerd.pinned=pinned

# 建置期間才開始收尾的也要擋。擋下時映像檔已匯入、釘選，app.yaml 與 Deployment 還沒動
"$dir/terminating-pods.sh"

# 把 manifest 的 image 換成這次的 tag 再套用。不 commit，換版後用 git checkout 還原
sed -i "s#image: localhost/sch001-ai-gateway:[0-9a-f]*\$#image: $tag#" "$dir/app.yaml"
# 寫法不一樣（加引號、多空白）時 sed 什麼都沒換，套用後還會以為上了新版
grep -qx " *image: $tag" "$dir/app.yaml" || { echo "app.yaml 的 image 沒換成 $tag，沒有套用" >&2; exit 1; }
sudo k3s kubectl apply -f "$dir/app.yaml"
sudo k3s kubectl -n "$ns" rollout status "deployment/$deploy" --timeout=180s
echo "換版成功：$tag。接著刪掉其他版本，這之後失敗不影響已經上線的版本" >&2

# 只放掉釘選的話，kubelet 要到磁碟用了 85% 才清。留下這次的、各 ReplicaSet 的（rollout undo
# 退得回去）和還有 pod 在用的。kubectl、ctr、buildah 失敗都要讓腳本停下來
rs=$(sudo k3s kubectl -n "$ns" get rs -l app=ai-gateway -o 'jsonpath={range .items[*].spec.template.spec.containers[*]}{.image}{"\n"}{end}')
pods=$(sudo k3s kubectl -n "$ns" get pods -o 'jsonpath={range .items[*].spec.containers[*]}{.image}{"\n"}{end}')
keep=$(printf '%s\n' "$tag" "$rs" "$pods")

# 匯入時 containerd 另外建一個以 config digest 命名的參照（sha256:…），指向同一個 manifest。
# 只刪 tag 的話它以 <none> 留著，所以記下刪掉的與被取代的 manifest，再刪指向它們、又不是保留版本
# 指著的 sha256 參照
refs=$(sudo k3s ctr images ls | awk 'NR > 1 { print $1, $3 }')
kept=" " gone=" $old_digest "
while read -r ref digest; do
  [[ $ref == "$repo":* ]] || continue
  if grep -qxF "$ref" <<<"$keep"; then
    kept+="$digest "
  else
    gone+="$digest "
    sudo k3s ctr images rm "$ref"
  fi
done <<<"$refs"
while read -r ref digest; do
  if [[ $ref == sha256:* && $gone == *" $digest "* && $kept != *" $digest "* ]]; then
    sudo k3s ctr images rm "$ref"
  fi
done <<<"$refs"

images=$(buildah images --format '{{.ID}} {{.Name}}:{{.Tag}}')
while read -r id name; do
  if [[ $name == "$repo":* ]] && ! grep -qxF "$name" <<<"$keep"; then
    buildah rmi "$name"
  elif [[ -n $old_id && $id == "$old_id" && $name == '<none>:<none>' ]]; then
    buildah rmi "$id"
  fi
done <<<"$images"
