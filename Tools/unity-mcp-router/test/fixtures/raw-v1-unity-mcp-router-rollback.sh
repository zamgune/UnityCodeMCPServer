#!/bin/sh
set -eu
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PREFIX=$(dirname -- "$SELF_DIR")
exec /bin/sh "$PREFIX/current/rollback-launcher.sh" "$@"
