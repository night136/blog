#!/usr/bin/env bash
# 全量回归入口：语法检查 + 全部 verify-*.mjs + smoke-app。
# 用法：bash scripts/run-all.sh      （在 blog-site 目录下执行）
#
# 为什么要固化成一个脚本：
#   1) 以前是临时的内联命令，容易漏项、也看不到每个脚本的退出码；
#   2) 每个脚本都有超时保护，任何单个脚本挂住都不会再把整个回归拖成「跑一整天」。
#      （历史事故：smoke-app.mjs 因 app.js 的常驻 setInterval 事件循环不排空，
#        进程输出完结果后不退出，任务挂了 10h+。）
set -u

# 定位 node：优先用环境变量 NODE，其次用受管运行时，最后回退 PATH
NODE="${NODE:-}"
if [ -z "$NODE" ]; then
  for c in \
    "/c/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe" \
    "$HOME/.workbuddy/binaries/node/versions/22.12.0/node.exe"
  do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
[ -z "$NODE" ] && NODE="node"

cd "$(dirname "$0")/.." || exit 1

PER_SCRIPT_TIMEOUT="${PER_SCRIPT_TIMEOUT:-60}"   # 单个脚本最长秒数
failed=()
start=$(date +%s)

echo "=== 语法检查 ==="
if "$NODE" --check assets/app.js; then
  echo "OK app.js"
else
  echo "FAIL app.js --check"
  failed+=("app.js --check")
fi

for s in verify-no-tdz verify-seo-render verify-og-cover verify-xss verify-jwt-secret verify-manage-update verify-cover-persist verify-asset-versioning verify-frontend-guards verify-mobile-guards verify-share verify-lunar-boot smoke-app; do
  echo
  echo "===== $s ====="
  out=$(timeout "$PER_SCRIPT_TIMEOUT" "$NODE" "scripts/$s.mjs" 2>&1)
  code=$?
  echo "$out"
  if [ $code -eq 124 ]; then
    echo ">>> TIMEOUT（超过 ${PER_SCRIPT_TIMEOUT}s，脚本自身未退出）"
    failed+=("$s(timeout)")
  elif [ $code -ne 0 ]; then
    failed+=("$s(exit=$code)")
  fi
done

end=$(date +%s)
echo
echo "=== 全套耗时 $((end - start))s ==="
if [ ${#failed[@]} -gt 0 ]; then
  echo "❌ 失败项：${failed[*]}"
  exit 1
fi
echo "✅ 全部回归通过"
