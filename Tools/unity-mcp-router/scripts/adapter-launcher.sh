#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT \
  OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_MODULES OPENSSL_ENGINES \
  DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
  DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH \
  DYLD_VERSIONED_LIBRARY_PATH DYLD_VERSIONED_FRAMEWORK_PATH \
  DYLD_ROOT_PATH DYLD_IMAGE_SUFFIX DYLD_SHARED_REGION DYLD_SHARED_CACHE_DIR
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LANG=C
LC_ALL=C
TZ=UTC
COLUMNS=4096
export LANG LC_ALL TZ COLUMNS
UNITY_MCP_REQUIRE_PREPARED_CONFIG=1
export UNITY_MCP_REQUIRE_PREPARED_CONFIG

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PREFIX=$(CDPATH= cd -- "$SELF_DIR/../.." && pwd -P)
cd -- "$SELF_DIR"
NODE_SHA_EXPECTED=$(sed -n '1p' "$SELF_DIR/node-sha256.txt")
case "$NODE_SHA_EXPECTED" in ''|*[!a-f0-9]*) printf 'unity-mcp-adapter: invalid pinned node checksum\n' >&2; exit 78 ;; esac
[ "${#NODE_SHA_EXPECTED}" -eq 64 ] || { printf 'unity-mcp-adapter: invalid pinned node checksum\n' >&2; exit 78; }
NODE_BIN=$PREFIX/runtimes/$NODE_SHA_EXPECTED/node
[ "$(sed -n '1p' "$SELF_DIR/node-bin.txt")" = "$NODE_BIN" ] || {
  printf 'unity-mcp-adapter: managed node path metadata mismatch\n' >&2
  exit 78
}
fs_uid() { if stat -f '%u' "$1" >/dev/null 2>&1; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi; }
fs_mode() { if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi; }
fs_links() { if stat -f '%l' "$1" >/dev/null 2>&1; then stat -f '%l' "$1"; else stat -c '%h' "$1"; fi; }
RUNTIMES_ROOT=$PREFIX/runtimes
RUNTIME_ROOT=$RUNTIMES_ROOT/$NODE_SHA_EXPECTED
[ -d "$RUNTIMES_ROOT" ] && [ ! -L "$RUNTIMES_ROOT" ] && [ "$(CDPATH= cd -- "$RUNTIMES_ROOT" && pwd -P)" = "$RUNTIMES_ROOT" ] &&
  [ "$(fs_uid "$RUNTIMES_ROOT")" = "$(id -u)" ] && [ "$(fs_mode "$RUNTIMES_ROOT")" = 700 ] &&
  [ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] && [ "$(CDPATH= cd -- "$RUNTIME_ROOT" && pwd -P)" = "$RUNTIME_ROOT" ] &&
  [ "$(fs_uid "$RUNTIME_ROOT")" = "$(id -u)" ] && [ "$(fs_mode "$RUNTIME_ROOT")" = 500 ] || {
  printf 'unity-mcp-adapter: managed runtime directory verification failed\n' >&2
  exit 78
}
[ -f "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  printf 'unity-mcp-adapter: pinned node is unavailable or symlinked\n' >&2
  exit 78
}
[ "$(fs_uid "$NODE_BIN")" = "$(id -u)" ] && [ "$(fs_mode "$NODE_BIN")" = 500 ] && [ "$(fs_links "$NODE_BIN")" = 1 ] || {
  printf 'unity-mcp-adapter: managed node ownership, mode, or link count is unsafe\n' >&2
  exit 78
}
if command -v shasum >/dev/null 2>&1; then
  NODE_SHA_ACTUAL=$(shasum -a 256 "$NODE_BIN" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  NODE_SHA_ACTUAL=$(sha256sum "$NODE_BIN" | awk '{print $1}')
else
  printf 'unity-mcp-adapter: no SHA-256 utility is available\n' >&2
  exit 78
fi
[ "$NODE_SHA_ACTUAL" = "$NODE_SHA_EXPECTED" ] || {
  printf 'unity-mcp-adapter: pinned node verification failed\n' >&2
  exit 78
}

DEFAULT_PROJECT=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --default)
      [ "$#" -ge 2 ] && [ -z "$DEFAULT_PROJECT" ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || {
        printf 'unity-mcp-adapter: invalid or duplicate --default\n' >&2
        exit 64
      }
      DEFAULT_PROJECT=$2
      shift 2
      ;;
    *)
      printf 'unity-mcp-adapter: rejected untrusted argument: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done

RELEASE_ID=$(sed -n '1p' "$SELF_DIR/release-id.txt")
case "$RELEASE_ID" in ''|*/*|.|..) printf 'unity-mcp-adapter: invalid release identity\n' >&2; exit 78 ;; esac
DEPLOYMENT_ID=$(basename -- "$SELF_DIR")
case "$DEPLOYMENT_ID" in d-[A-Fa-f0-9]*) ;; *) printf 'unity-mcp-adapter: invalid deployment identity\n' >&2; exit 78 ;; esac
"$NODE_BIN" "$SELF_DIR/deployment-audit.mjs" --prefix "$PREFIX" --target "deployments/$DEPLOYMENT_ID" \
  --expected-label "$(sed -n '1p' "$SELF_DIR/label.txt")" >/dev/null || {
  printf 'unity-mcp-adapter: deployment identity audit failed\n' >&2
  exit 78
}
RELEASE_DIR=$PREFIX/releases/$RELEASE_ID
[ -d "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] || {
  printf 'unity-mcp-adapter: release directory failed containment validation\n' >&2
  exit 78
}
# Codex/Claude usually launch from the Unity checkout. Move off that inherited
# cwd before Node evaluates process.cwd(); a stalled removable volume must not
# prevent this connect-only adapter from reaching the local broker.
cd -- "$RELEASE_DIR"
if [ -n "$DEFAULT_PROJECT" ]; then
  exec "$NODE_BIN" "$RELEASE_DIR/unity-mcp-router.mjs" --config "$SELF_DIR/config.json" --broker-mode connect-only --default "$DEFAULT_PROJECT"
fi
exec "$NODE_BIN" "$RELEASE_DIR/unity-mcp-router.mjs" --config "$SELF_DIR/config.json" --broker-mode connect-only
