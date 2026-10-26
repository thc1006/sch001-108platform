#!/usr/bin/env bash
# 列出 AI 閘道還在收尾的 pod，有的話以 1 結束。build-image.sh 換版前會跑；rollout restart、rollout undo
# 不經過它，執行前自己跑。ALLOW_ROLLOUT_OVERLAP=1 時照樣列出，以 0 結束
set -euo pipefail

# 收尾中是有 deletionTimestamp、phase 不是 Succeeded 或 Failed，同 ReplicaSet 控制器用的 IsPodTerminating
pods=$(sudo k3s kubectl -n sch001-ai get pods -l app=ai-gateway -o jsonpath='{range .items[?(@.metadata.deletionTimestamp)]}{.metadata.name}|{.status.phase}|{.metadata.deletionTimestamp}|{.metadata.deletionGracePeriodSeconds}{"\n"}{end}')
now=$(date +%s)
rfc3339='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
found=()
# 算術錯誤只中止當下這一整個指令，不觸發 set -e，所以迴圈之後要看 parsed
parsed=0
{
  while IFS='|' read -r name phase deadline grace; do
    [ -n "$name" ] || continue
    case $phase in Succeeded | Failed) continue ;; esac
    if [[ ! $deadline =~ $rfc3339 || ! $grace =~ ^(0|[1-9][0-9]{0,9})$ ]]; then
      echo "讀不懂 $name 的 deletionTimestamp（$deadline）或 deletionGracePeriodSeconds（$grace）" >&2
      exit 1
    fi
    end=$(date -ud "$deadline" +%s)
    left=$((end - now))
    # apiserver 把期限設成要求刪除的時間加上寬限秒數。縮短寬限期時新期限已過，期限會改成當下、
    # 寬限改成 1（要求 0 時是 0），這時算不出收尾了多久
    if ((left > 0)); then
      found+=("$name：已收尾 $((grace - left)) 秒，最多再 $left 秒")
    elif ((left == 0)); then
      found+=("$name：刪除期限已到，還沒從 API 刪除")
    else
      found+=("$name：刪除期限已過 $((-left)) 秒，還沒從 API 刪除")
    fi
  done <<<"$pods"
  parsed=1
}
[ "$parsed" = 1 ] || exit 1
[ ${#found[@]} -gt 0 ] || exit 0

echo '這些 pod 已經要求刪除，還在收尾：' >&2
printf '  %s\n' "${found[@]}" >&2
if [ "${ALLOW_ROLLOUT_OVERLAP:-}" = 1 ]; then
  echo 'ALLOW_ROLLOUT_OVERLAP=1：不等它們結束就換版' >&2
  exit 0
fi
cat >&2 <<'MSG'
現在換版的話，它們會和目前的 pod、新 pod 同時呼叫 WinLab。等它們從 get pods 消失再執行；
過了期限還在的，用 sudo k3s kubectl -n sch001-ai describe pod <名稱> 查原因。
緊急時用 ALLOW_ROLLOUT_OVERLAP=1 照樣換版，代價見 ai-gateway/README.md 的「部署」。
MSG
exit 1
