#!/usr/bin/env bash
# Copies shots/ onto the `shots` branch under shots/<branch>/<job>/ so screenshots can be looked at without
# downloading artifacts. Runs in CI; commits as the repo's owner.
set -euo pipefail
job="${1:-web}"
[ -d shots ] || { echo "no shots"; exit 0; }
branch="${GITHUB_REF_NAME//\//-}"
work="$(mktemp -d)"
git config --global user.name "Dragongamer9"
git config --global user.email "Dragongamer9@users.noreply.github.com"
url="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git config --global --unset-all http.https://github.com/.extraheader || true
if git ls-remote --exit-code "$url" refs/heads/shots >/dev/null 2>&1; then
  git clone -q --depth 1 --branch shots "$url" "$work"
else
  git init -q "$work" && git -C "$work" checkout -q --orphan shots
fi
dest="$work/$branch/$job"
rm -rf "$dest" && mkdir -p "$dest"
cp -r shots/. "$dest/"
git -C "$work" add -A
git -C "$work" commit -q -m "Screenshots: $branch $job ${GITHUB_SHA:0:7}" || { echo "nothing new"; exit 0; }
for i in 1 2 3; do
  git -C "$work" push -q "$url" HEAD:shots && exit 0
  git -C "$work" pull -q --rebase "$url" shots || true
done
echo "::warning title=Screenshots::couldn't push the shots branch"
