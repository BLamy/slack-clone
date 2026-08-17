#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
if [[ "$target" != "verify-E4-T08-real" ]]; then
  echo "usage: tools/verify/cold_clone.sh verify-E4-T08-real" >&2
  exit 64
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"
commit=""
if [[ -n "${E4_T08_IMPLEMENTATION_COMMIT-}" ]]; then
  commit="$E4_T08_IMPLEMENTATION_COMMIT"
else
  commit="$(git -C "$root" rev-parse HEAD)"
fi
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "E4-T08 requires a full 40-character implementation commit" >&2
  exit 64
fi
run_id=""
if [[ -n "${TEST_RUN_ID-}" ]]; then
  run_id="$TEST_RUN_ID"
else
  run_id="e4-t08-real-cold-$(date +%s)"
fi
artifact_dir=""
if [[ -n "${TEST_ARTIFACT_DIR-}" ]]; then
  artifact_dir="$TEST_ARTIFACT_DIR"
else
  artifact_dir="$root/.artifacts/e4-t08-real/$run_id"
fi
task="$root/.eforest/tasks/epic-4-the-cloudflare-os/E4-T08-cloudflare-os-conformance"
work="$task/work"
mkdir -p "$work" "$artifact_dir"
cold_parent="$(mktemp -d "$work/cold-clone.XXXXXX")"
checkout="$cold_parent/checkout"

cleanup() {
  if [[ -d "$checkout" ]]; then
    git -C "$root" worktree remove --force "$checkout" >/dev/null 2>&1 || true
  fi
  rm -rf "$cold_parent"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$checkout" "$commit" >/dev/null
(
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=submodule.emulate.url
  export GIT_CONFIG_VALUE_0=https://github.com/BLamy/emulate.git
  git -C "$checkout" submodule update --init --recursive
)
pnpm --dir "$checkout" install --frozen-lockfile
(
  export E4_T08_IMPLEMENTATION_COMMIT="$commit"
  export TEST_RUN_ID="$run_id"
  export TEST_ARTIFACT_DIR="$artifact_dir"
  node "$checkout/scripts/verify-e4-t08-real.mjs"
)
