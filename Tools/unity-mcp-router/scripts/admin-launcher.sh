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
case "$NODE_SHA_EXPECTED" in ''|*[!a-f0-9]*) printf 'unity-mcp-admin: invalid pinned node checksum\n' >&2; exit 78 ;; esac
[ "${#NODE_SHA_EXPECTED}" -eq 64 ] || { printf 'unity-mcp-admin: invalid pinned node checksum\n' >&2; exit 78; }
NODE_BIN=$PREFIX/runtimes/$NODE_SHA_EXPECTED/node
[ "$(sed -n '1p' "$SELF_DIR/node-bin.txt")" = "$NODE_BIN" ] || {
  printf 'unity-mcp-admin: managed node path metadata mismatch\n' >&2
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
  printf 'unity-mcp-admin: managed runtime directory verification failed\n' >&2
  exit 78
}
[ -f "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  printf 'unity-mcp-admin: pinned node is unavailable or symlinked\n' >&2
  exit 78
}
[ "$(fs_uid "$NODE_BIN")" = "$(id -u)" ] && [ "$(fs_mode "$NODE_BIN")" = 500 ] && [ "$(fs_links "$NODE_BIN")" = 1 ] || {
  printf 'unity-mcp-admin: managed node ownership, mode, or link count is unsafe\n' >&2
  exit 78
}
if command -v shasum >/dev/null 2>&1; then NODE_SHA_ACTUAL=$(shasum -a 256 "$NODE_BIN" | awk '{print $1}');
elif command -v sha256sum >/dev/null 2>&1; then NODE_SHA_ACTUAL=$(sha256sum "$NODE_BIN" | awk '{print $1}');
else printf 'unity-mcp-admin: no SHA-256 utility is available\n' >&2; exit 78; fi
[ "$NODE_SHA_ACTUAL" = "$NODE_SHA_EXPECTED" ] || {
  printf 'unity-mcp-admin: pinned node verification failed\n' >&2
  exit 78
}

[ "$#" -ge 1 ] || { printf 'unity-mcp-admin: command required\n' >&2; exit 64; }

is_hex_segment() {
  [ "${#1}" -eq "$2" ] || return 1
  case "$1" in ''|*[!0-9A-Fa-f]*) return 1 ;; esac
}

is_uuid() {
  ADMIN_UUID_A=${1%%-*}
  ADMIN_UUID_REST=${1#*-}
  [ "$ADMIN_UUID_REST" != "$1" ] || return 1
  ADMIN_UUID_B=${ADMIN_UUID_REST%%-*}
  ADMIN_UUID_NEXT=${ADMIN_UUID_REST#*-}
  [ "$ADMIN_UUID_NEXT" != "$ADMIN_UUID_REST" ] || return 1
  ADMIN_UUID_C=${ADMIN_UUID_NEXT%%-*}
  ADMIN_UUID_REST=${ADMIN_UUID_NEXT#*-}
  [ "$ADMIN_UUID_REST" != "$ADMIN_UUID_NEXT" ] || return 1
  ADMIN_UUID_D=${ADMIN_UUID_REST%%-*}
  ADMIN_UUID_E=${ADMIN_UUID_REST#*-}
  [ "$ADMIN_UUID_E" != "$ADMIN_UUID_REST" ] || return 1
  is_hex_segment "$ADMIN_UUID_A" 8 &&
    is_hex_segment "$ADMIN_UUID_B" 4 &&
    is_hex_segment "$ADMIN_UUID_C" 4 &&
    is_hex_segment "$ADMIN_UUID_D" 4 &&
    is_hex_segment "$ADMIN_UUID_E" 12
}

COMMAND=$1
TIMEOUT_ARGS=
OPERATION_ACTION=
OPERATION_ID=
OPERATION_CONFIRM_RUNNING=0
EDITOR_ACTION=
EDITOR_SUBJECT=
WORKSPACE_ACTION=
WORKSPACE_TOKEN=
case "$COMMAND" in
  status|doctor|drain|resume)
    shift
    if [ "$#" -gt 0 ]; then
      [ "$#" -eq 2 ] && [ "$1" = --timeout-sec ] || { printf 'unity-mcp-admin: rejected untrusted arguments\n' >&2; exit 64; }
      case "$2" in ''|*[!0-9]*) printf 'unity-mcp-admin: timeout must be an integer\n' >&2; exit 64 ;; esac
      [ "$2" -ge 1 ] && [ "$2" -le 600 ] || { printf 'unity-mcp-admin: timeout must be 1..600\n' >&2; exit 64; }
      TIMEOUT_ARGS=$2
    fi
    ;;
  operation)
    [ "$#" -ge 2 ] || { printf 'unity-mcp-admin: operation action required\n' >&2; exit 64; }
    OPERATION_ACTION=$2
    case "$OPERATION_ACTION" in
      status)
        [ "$#" -eq 3 ] || { printf 'unity-mcp-admin: operation status requires exactly one UUID\n' >&2; exit 64; }
        OPERATION_ID=$3
        ;;
      resolve)
        if [ "$#" -eq 4 ]; then
          OPERATION_CONFIRM_RUNNING=0
        elif [ "$#" -eq 5 ] && [ "$5" = --confirm-no-longer-running ]; then
          OPERATION_CONFIRM_RUNNING=1
        else
          printf 'unity-mcp-admin: operation resolve arguments are rejected\n' >&2
          exit 64
        fi
        OPERATION_ID=$3
        [ "$4" = confirmed_completed ] || {
          printf 'unity-mcp-admin: resolution must be confirmed_completed\n' >&2
          exit 64
        }
        ;;
      *)
        printf 'unity-mcp-admin: rejected operation action: %s\n' "$OPERATION_ACTION" >&2
        exit 64
        ;;
    esac
    is_uuid "$OPERATION_ID" || {
      printf 'unity-mcp-admin: operation id must be a canonical UUID\n' >&2
      exit 64
    }
    ;;
  editor)
    [ "$#" -eq 3 ] || { printf 'unity-mcp-admin: editor requires use PROJECT or status UUID\n' >&2; exit 64; }
    EDITOR_ACTION=$2
    EDITOR_SUBJECT=$3
    case "$EDITOR_ACTION" in
      use)
        case "$EDITOR_SUBJECT" in
          ''|-*|*/*|*[!A-Za-z0-9._-]*)
            printf 'unity-mcp-admin: project alias contains rejected characters\n' >&2
            exit 64
            ;;
        esac
        ;;
      status)
        is_uuid "$EDITOR_SUBJECT" || {
          printf 'unity-mcp-admin: editor operation id must be a canonical UUID\n' >&2
          exit 64
        }
        ;;
      *)
        printf 'unity-mcp-admin: rejected editor action: %s\n' "$EDITOR_ACTION" >&2
        exit 64
        ;;
    esac
    ;;
  workspace)
    [ "$#" -eq 4 ] || { printf 'unity-mcp-admin: workspace resolve requires UUID --confirm\n' >&2; exit 64; }
    WORKSPACE_ACTION=$2
    WORKSPACE_TOKEN=$3
    [ "$WORKSPACE_ACTION" = resolve ] && [ "$4" = --confirm ] || {
      printf 'unity-mcp-admin: workspace arguments are rejected\n' >&2
      exit 64
    }
    is_uuid "$WORKSPACE_TOKEN" || {
      printf 'unity-mcp-admin: workspace lease token must be a canonical UUID\n' >&2
      exit 64
    }
    ;;
  *)
    printf 'unity-mcp-admin: rejected command: %s\n' "$COMMAND" >&2
    exit 64
    ;;
esac

RELEASE_ID=$(sed -n '1p' "$SELF_DIR/release-id.txt")
case "$RELEASE_ID" in ''|*/*|.|..) printf 'unity-mcp-admin: invalid release identity\n' >&2; exit 78 ;; esac
DEPLOYMENT_ID=$(basename -- "$SELF_DIR")
case "$DEPLOYMENT_ID" in d-[A-Fa-f0-9]*) ;; *) printf 'unity-mcp-admin: invalid deployment identity\n' >&2; exit 78 ;; esac
"$NODE_BIN" "$SELF_DIR/deployment-audit.mjs" --prefix "$PREFIX" --target "deployments/$DEPLOYMENT_ID" \
  --expected-label "$(sed -n '1p' "$SELF_DIR/label.txt")" >/dev/null || {
  printf 'unity-mcp-admin: deployment identity audit failed\n' >&2
  exit 78
}
RELEASE_DIR=$PREFIX/releases/$RELEASE_ID
[ -d "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] || { printf 'unity-mcp-admin: release containment failed\n' >&2; exit 78; }
cd -- "$RELEASE_DIR"
if [ "$COMMAND" = editor ]; then
  exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" editor "$EDITOR_ACTION" "$EDITOR_SUBJECT" \
    --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json"
fi
if [ "$COMMAND" = operation ]; then
  if [ "$OPERATION_ACTION" = status ]; then
    exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" operation status "$OPERATION_ID" \
      --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json"
  fi
  if [ "$OPERATION_CONFIRM_RUNNING" -eq 1 ]; then
    exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" operation resolve "$OPERATION_ID" confirmed_completed \
      --confirm-no-longer-running --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json"
  fi
  exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" operation resolve "$OPERATION_ID" confirmed_completed \
    --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json"
fi
if [ "$COMMAND" = workspace ]; then
  exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" workspace "$WORKSPACE_ACTION" "$WORKSPACE_TOKEN" --confirm \
    --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json"
fi
if [ -n "$TIMEOUT_ARGS" ]; then
  exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" "$COMMAND" --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json" --timeout-sec "$TIMEOUT_ARGS"
fi
exec "$NODE_BIN" "$SELF_DIR/broker-admin.mjs" "$COMMAND" --runtime-root "$RELEASE_DIR" --config "$SELF_DIR/config.json"
