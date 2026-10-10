#!/usr/bin/env bash
# 一鍵部署 Warmup 記憶庫：bash deploy.sh（可重複執行，不會清掉記憶）
set -euo pipefail
cd "$(dirname "$0")"

WRANGLER="npx --yes wrangler"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1/4 安裝套件"
npm install --silent

step "2/4 Cloudflare 登入"
if ! $WRANGLER whoami 2>/dev/null | grep -qi "associated with"; then
  $WRANGLER login
fi

step "3/4 部署"
DEPLOY_OUT=$($WRANGLER deploy 2>&1 | tee /dev/stderr)
URL=$(printf '%s' "$DEPLOY_OUT" | grep -o 'https://[^ ]*workers\.dev' | head -1)

step "4/4 設定密碼"
SECRET=""
if $WRANGLER secret list 2>/dev/null | grep -q '"MEMORY_SECRET"'; then
  echo "之前已設定過密碼（只在第一次部署時顯示）。忘記的話：npx wrangler secret delete MEMORY_SECRET，再跑一次本腳本"
else
  SECRET=$(openssl rand -hex 24)
  printf '%s' "$SECRET" | $WRANGLER secret put MEMORY_SECRET
fi

URL=${URL:-https://<你的網址>.workers.dev}
SHOW=${SECRET:-<你的密碼>}

printf '\n\033[1m完成！以下資料只顯示這一次，請存好，不要給別人\033[0m\n\n'
echo "MCP 網址：$URL/mcp/$SHOW"
echo
echo "  claude.ai：設定 → 連接器 → 新增自訂連接器，貼上 MCP 網址"
echo "  Claude Code：claude mcp add --transport http warmup $URL/mcp/$SHOW"
echo "  Codex（~/.codex/config.toml）："
echo "    [mcp_servers.warmup]"
echo "    url = \"$URL/mcp/$SHOW\""
echo
echo "接好後跟你的 AI 說：「先呼叫 memory_warmup」"
