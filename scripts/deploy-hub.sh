#!/usr/bin/env bash
# Deploy the hub with the cf CLI. The admin token is read from ~/.config/pi-swarm/admin-token (created if missing)
# and uploaded as the ADMIN_TOKEN Worker secret through a temporary 0600 file that is removed afterwards.
# Cloudflare credentials come from your cf login (`cf auth login`) or from CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID in the environment.
set -euo pipefail
cd "$(dirname "$0")/../hub"
umask 077
dir="$HOME/.config/pi-swarm"; mkdir -p "$dir"
if [ -L "$dir/admin-token" ] || { [ -e "$dir/admin-token" ] && [ ! -O "$dir/admin-token" ]; }; then
  echo "refusing: $dir/admin-token is a symlink or not owned by you" >&2; exit 1
fi
[ -e "$dir/admin-token" ] && chmod 600 "$dir/admin-token"
[ -s "$dir/admin-token" ] || node -e 'process.stdout.write("psa_"+require("crypto").randomBytes(32).toString("base64url"))' > "$dir/admin-token"
secrets="$(mktemp "$dir/deploy-secrets.XXXXXX.json")"
trap 'rm -f "$secrets"' EXIT
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({ADMIN_TOKEN:fs.readFileSync(process.argv[2],"utf8").trim()}))' "$secrets" "$dir/admin-token"
cf deploy --secrets-file "$secrets" --message "${1:-pi-swarm hub}"
