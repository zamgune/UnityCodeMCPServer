#!/bin/sh
set -eu
umask 077
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

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
CONFIG_FILE=
PREFIX=${HOME}/.unity-mcp-router
NODE_BIN=
NODE_SHA_EXPECTED=
LAUNCH_AGENTS_DIR=${HOME}/Library/LaunchAgents
LABEL=com.zamgune.unity-mcp-router
LAUNCHCTL_BIN=/bin/launchctl
CLIENT_CONFIGS=
DRY_RUN=0
STAGING=0
DRAIN_TIMEOUT_SEC=60
VERIFY_TIMEOUT_SEC=30
BOOTOUT_WAIT_SEC=10

usage() {
  cat >&2 <<'EOF'
usage: install-router.sh --config FILE --node-bin FILE --node-sha256 SHA256 [options]

Options:
  --source DIR                 Runtime source tree (default: repository root)
  --prefix DIR                 Install root (default: ~/.unity-mcp-router)
  --launch-agents-dir DIR      LaunchAgent destination
  --launchctl-bin FILE         launchctl binary (test injection only)
  --label LABEL                LaunchAgent label
  --client-config FILE         Back up a Codex/Claude config (repeatable)
  --drain-timeout-sec N        Existing broker drain deadline (1..600)
  --verify-timeout-sec N       New broker startup verification deadline
  --dry-run                    Validate and print the candidate; write nothing to PREFIX
  --staging                    Exercise the full file transaction under /private/tmp only;
                               do not contact launchd or a live broker
EOF
  exit 64
}

fail() {
  printf 'install-router: ERROR: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || usage; SOURCE_ROOT=$2; shift 2 ;;
    --config) [ "$#" -ge 2 ] || usage; CONFIG_FILE=$2; shift 2 ;;
    --prefix) [ "$#" -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --node-bin) [ "$#" -ge 2 ] || usage; NODE_BIN=$2; shift 2 ;;
    --node-sha256) [ "$#" -ge 2 ] || usage; NODE_SHA_EXPECTED=$2; shift 2 ;;
    --launch-agents-dir) [ "$#" -ge 2 ] || usage; LAUNCH_AGENTS_DIR=$2; shift 2 ;;
    --launchctl-bin) [ "$#" -ge 2 ] || usage; LAUNCHCTL_BIN=$2; shift 2 ;;
    --label) [ "$#" -ge 2 ] || usage; LABEL=$2; shift 2 ;;
    --client-config)
      [ "$#" -ge 2 ] || usage
      CLIENT_CONFIGS=${CLIENT_CONFIGS}${CLIENT_CONFIGS:+"
"}$2
      shift 2
      ;;
    --drain-timeout-sec) [ "$#" -ge 2 ] || usage; DRAIN_TIMEOUT_SEC=$2; shift 2 ;;
    --verify-timeout-sec) [ "$#" -ge 2 ] || usage; VERIFY_TIMEOUT_SEC=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --staging) STAGING=1; shift ;;
    -h|--help) usage ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ -n "$CONFIG_FILE" ] || usage
[ -n "$NODE_BIN" ] || usage
[ -n "$NODE_SHA_EXPECTED" ] || usage
case "$PREFIX" in /*) ;; *) fail '--prefix must be absolute' ;; esac
case "$SOURCE_ROOT" in /*) ;; *) fail '--source must be absolute' ;; esac
case "$CONFIG_FILE" in /*) ;; *) fail '--config must be absolute' ;; esac
case "$NODE_BIN" in /*) ;; *) fail '--node-bin must be absolute' ;; esac
case "$LAUNCH_AGENTS_DIR" in /*) ;; *) fail '--launch-agents-dir must be absolute' ;; esac
case "$PREFIX" in /|'') fail 'refusing a broad install prefix' ;; esac
case "$LABEL" in *[!A-Za-z0-9._-]*|'') fail 'invalid LaunchAgent label' ;; esac
case "$DRAIN_TIMEOUT_SEC:$VERIFY_TIMEOUT_SEC" in *[!0-9:]*|:*) fail 'timeouts must be integers' ;; esac
[ "$DRAIN_TIMEOUT_SEC" -ge 1 ] && [ "$DRAIN_TIMEOUT_SEC" -le 600 ] || fail 'drain timeout must be 1..600 seconds'
[ "$VERIFY_TIMEOUT_SEC" -ge 1 ] && [ "$VERIFY_TIMEOUT_SEC" -le 300 ] || fail 'verify timeout must be 1..300 seconds'

canonical_destination() {
  destination=$1
  parent=$(CDPATH= cd -- "$(dirname -- "$destination")" && pwd -P) || fail "destination parent does not exist: $destination"
  printf '%s/%s\n' "$parent" "$(basename -- "$destination")"
}
PREFIX=$(canonical_destination "$PREFIX")
LAUNCH_AGENTS_DIR=$(canonical_destination "$LAUNCH_AGENTS_DIR")

if [ "$STAGING" -eq 1 ]; then
  case "$PREFIX" in /private/tmp/*|/tmp/*) ;; *) fail '--staging requires a prefix under /private/tmp or /tmp' ;; esac
  case "$LAUNCH_AGENTS_DIR" in /private/tmp/*|/tmp/*) ;; *) fail '--staging requires a LaunchAgent directory under /private/tmp or /tmp' ;; esac
elif [ "$(uname -s)" != Darwin ]; then
  fail 'live activation is supported only on macOS; use --staging for fixture tests'
fi

[ -d "$SOURCE_ROOT" ] || fail "source directory not found: $SOURCE_ROOT"
[ -f "$CONFIG_FILE" ] && [ ! -L "$CONFIG_FILE" ] || fail 'config must be a regular, non-symlink file'
[ -x "$NODE_BIN" ] || fail "node binary is not executable: $NODE_BIN"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail 'shasum or sha256sum is required'
  fi
}

case "$NODE_SHA_EXPECTED" in *[!A-Fa-f0-9]*|'') fail '--node-sha256 must be a 64-character hex digest' ;; esac
[ "${#NODE_SHA_EXPECTED}" -eq 64 ] || fail '--node-sha256 must be a 64-character hex digest'
NODE_SHA_EXPECTED=$(printf '%s' "$NODE_SHA_EXPECTED" | tr 'A-F' 'a-f')

canonical_file() {
  candidate=$1
  hops=0
  while [ -L "$candidate" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || fail "too many symlinks while resolving: $1"
    target=$(readlink "$candidate")
    case "$target" in /*) candidate=$target ;; *) candidate=$(dirname -- "$candidate")/$target ;; esac
  done
  directory=$(CDPATH= cd -- "$(dirname -- "$candidate")" && pwd -P) || fail "cannot resolve node directory: $candidate"
  printf '%s/%s\n' "$directory" "$(basename -- "$candidate")"
}

# Do not execute the candidate runtime until its caller-supplied SHA has been
# checked using the host hashing utility. The caller path itself must be a real
# file; accepting a symlink would leave the copy source mutable between path
# resolution and the snapshot.
[ ! -L "$NODE_BIN" ] || fail 'node input must not be a symlink'
INPUT_NODE=$(canonical_file "$NODE_BIN")
[ -f "$INPUT_NODE" ] && [ ! -L "$INPUT_NODE" ] && [ -x "$INPUT_NODE" ] || fail 'resolved node runtime is unsafe or not executable'
node_link_count() {
  if stat -f '%l' "$1" >/dev/null 2>&1; then stat -f '%l' "$1"; else stat -c '%h' "$1"; fi
}
[ "$(node_link_count "$INPUT_NODE")" -eq 1 ] || fail 'node input must not be hard-linked'
NODE_SHA=$(sha256_file "$INPUT_NODE")
[ "$NODE_SHA" = "$NODE_SHA_EXPECTED" ] || fail "pinned node checksum mismatch for $INPUT_NODE"

WORK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/unity-mcp-install.XXXXXX")
WORK_TMP=$(CDPATH= cd -- "$WORK_TMP" && pwd -P)
LOCK_HELD=0
LOCK_FILE=
LOCK_GUARD_FILE=
LOCK_ID=
LOCK_SHA=
cleanup() {
  if [ "$LOCK_HELD" -eq 1 ] && [ -n "$LOCK_FILE" ] && [ -n "$LOCK_GUARD_FILE" ] && [ -n "$LOCK_ID" ] && [ -n "$LOCK_SHA" ]; then
    if "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" lock-release --file "$LOCK_FILE" \
      --expected-lock-id "$LOCK_ID" --expected-sha256 "$LOCK_SHA" >/dev/null 2>&1; then
      LOCK_HELD=0
    else
      printf 'install-router: ERROR: install lock ownership changed; foreign lock preserved at %s\n' "$LOCK_FILE" >&2
    fi
  fi
  rm -rf -- "$WORK_TMP"
}
trap cleanup EXIT HUP INT TERM

# Keep the v2 lock's script identity tied to private, immutable bytes for this
# installer process. A concurrent source-tree edit must not change owner
# evidence while the whole-operation guard is held.
INSTALL_SOURCE=$SCRIPT_DIR/install-router.sh
[ -f "$INSTALL_SOURCE" ] && [ ! -L "$INSTALL_SOURCE" ] || fail 'installer source must be a regular, non-symlink file'
INSTALL_SOURCE_SHA=$(sha256_file "$INSTALL_SOURCE")
INSTALL_LOCK_OWNER=$WORK_TMP/install-lock-owner.sh
cp -- "$INSTALL_SOURCE" "$INSTALL_LOCK_OWNER" || fail 'could not snapshot installer lock identity'
[ -f "$INSTALL_LOCK_OWNER" ] && [ ! -L "$INSTALL_LOCK_OWNER" ] || fail 'installer lock snapshot is not a regular file'
[ "$(node_link_count "$INSTALL_LOCK_OWNER")" -eq 1 ] || fail 'installer lock snapshot is unexpectedly hard-linked'
chmod 500 "$INSTALL_LOCK_OWNER"
INSTALL_LOCK_OWNER_SHA=$(sha256_file "$INSTALL_LOCK_OWNER")
[ "$INSTALL_LOCK_OWNER_SHA" = "$INSTALL_SOURCE_SHA" ] || fail 'installer changed while lock identity was snapshotted'
[ "$(sha256_file "$INSTALL_LOCK_OWNER")" = "$INSTALL_LOCK_OWNER_SHA" ] || fail 'installer lock snapshot checksum changed'

# Execute only this private, newly allocated snapshot. Re-hashing the copy
# closes the source TOCTOU window without trusting the external volume again.
NODE_RESOLVED=$WORK_TMP/verified-node
cp -- "$INPUT_NODE" "$NODE_RESOLVED" || fail 'could not snapshot the verified node input'
[ -f "$NODE_RESOLVED" ] && [ ! -L "$NODE_RESOLVED" ] || fail 'verified node snapshot is not a regular file'
[ "$(node_link_count "$NODE_RESOLVED")" -eq 1 ] || fail 'verified node snapshot is unexpectedly hard-linked'
chmod 500 "$NODE_RESOLVED"
[ "$(sha256_file "$NODE_RESOLVED")" = "$NODE_SHA" ] || fail 'verified node snapshot checksum mismatch'
if [ "$(uname -s)" = Darwin ]; then
  [ -x /usr/bin/otool ] || fail 'Darwin Node dependency audit requires /usr/bin/otool'
  OTOOL_OUTPUT=$(/usr/bin/otool -L "$NODE_RESOLVED") || fail 'node input Mach-O dependency audit failed'
  UNSAFE_NODE_DEPENDENCIES=$(printf '%s\n' "$OTOOL_OUTPUT" | /usr/bin/sed '1d' | /usr/bin/awk '{print $1}' | while IFS= read -r dependency; do
    if [ "${dependency#/usr/lib/}" = "$dependency" ] && [ "${dependency#/System/Library/}" = "$dependency" ]; then
      printf '%s\n' "$dependency"
    fi
  done)
  [ -z "$UNSAFE_NODE_DEPENDENCIES" ] || fail "node input has non-system dynamic dependencies and is not self-contained: $UNSAFE_NODE_DEPENDENCIES"
fi
NODE_EXEC_PATH=$($NODE_RESOLVED -p 'process.execPath') || fail 'verified node runtime probe failed'
[ "$NODE_EXEC_PATH" = "$NODE_RESOLVED" ] || fail "verified node snapshot reported a different process.execPath: $NODE_EXEC_PATH"
NODE_VERSION=$($NODE_RESOLVED -p 'process.versions.node') || fail 'node version probe failed'
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | awk -F. '{print $1}')
case "$NODE_MAJOR" in ''|*[!0-9]*) fail "invalid node version: $NODE_VERSION" ;; esac
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required (found $NODE_VERSION)"

if [ "$(uname -s)" = Darwin ]; then
  NODE_PLATFORM=$($NODE_RESOLVED -p 'process.platform')
  NODE_ARCH=$($NODE_RESOLVED -p 'process.arch')
  MACHINE_ARCH=$(uname -m)
  [ "$NODE_PLATFORM" = darwin ] || fail "node runtime platform is $NODE_PLATFORM, expected darwin"
  case "$MACHINE_ARCH:$NODE_ARCH" in arm64:arm64|x86_64:x64) ;; *) fail "node architecture $NODE_ARCH does not match $MACHINE_ARCH" ;; esac
fi

RUNTIME_NODE=$PREFIX/runtimes/$NODE_SHA/node

RUNTIME_FILES='broker-daemon.mjs
router-cli.mjs
unity-mcp-router.mjs
release.json
lib/async-operation-policy.mjs
lib/admin-token.mjs
lib/auth-manager.mjs
lib/broker-core.mjs
lib/build-info.mjs
lib/cli-version.mjs
lib/config.mjs
lib/editor-registry.mjs
lib/failure-classifier.mjs
lib/lease-manager.mjs
lib/logger.mjs
lib/macos-process-audit.mjs
lib/mcp-framing.mjs
lib/mcp-protocol.mjs
lib/operation-journal.mjs
lib/project-access-audit.mjs
lib/project-scheduler.mjs
lib/recovery-policy.mjs
lib/tool-registry.mjs
lib/unity-child.mjs
lib/workspace-lease-store.mjs'

SOURCE_MANIFEST=$WORK_TMP/source.SHA256SUMS
: > "$SOURCE_MANIFEST"
printf '%s\n' "$RUNTIME_FILES" | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  file=$SOURCE_ROOT/$rel
  [ -f "$file" ] && [ ! -L "$file" ] || fail "allowlisted source file missing or symlinked: $rel"
  printf '%s  %s\n' "$(sha256_file "$file")" "$rel"
done > "$SOURCE_MANIFEST"
SOURCE_HASH=$(sha256_file "$SOURCE_MANIFEST")

VERSION=$($NODE_RESOLVED -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(typeof r.version!=="string")process.exit(2); process.stdout.write(r.version)' "$SOURCE_ROOT/release.json") || fail 'invalid release.json version'
JOURNAL_FORMAT=$($NODE_RESOLVED -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Number.isInteger(r.journalFormat))process.exit(2); process.stdout.write(String(r.journalFormat))' "$SOURCE_ROOT/release.json") || fail 'invalid release.json journalFormat'
case "$VERSION" in *[!A-Za-z0-9._-]*|'') fail "unsafe release version: $VERSION" ;; esac
[ "$JOURNAL_FORMAT" -eq 2 ] || fail "installer accepts only journalFormat 2 releases (found $JOURNAL_FORMAT)"

PACKAGED_RELEASE=$WORK_TMP/release.json
$NODE_RESOLVED -e '
  const fs=require("fs");
  const [source,out,hash]=process.argv.slice(1);
  const value=JSON.parse(fs.readFileSync(source,"utf8"));
  value.buildId=`sha256:${hash}`;
  fs.writeFileSync(out,JSON.stringify(value,null,2)+"\n",{mode:0o600});
' "$SOURCE_ROOT/release.json" "$PACKAGED_RELEASE" "$SOURCE_HASH"
PACKAGE_MANIFEST=$WORK_TMP/package.SHA256SUMS
printf '%s\n' "$RUNTIME_FILES" | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if [ "$rel" = release.json ]; then file=$PACKAGED_RELEASE; else file=$SOURCE_ROOT/$rel; fi
  printf '%s  %s\n' "$(sha256_file "$file")" "$rel"
done > "$PACKAGE_MANIFEST"
printf '%s  %s\n' "$(sha256_file "$SOURCE_MANIFEST")" SOURCE_SHA256SUMS >> "$PACKAGE_MANIFEST"

PREPARED_CONFIG=$WORK_TMP/config.json
$NODE_RESOLVED "$SCRIPT_DIR/prepare-config.mjs" prepare \
  --runtime-root "$SOURCE_ROOT" --input "$CONFIG_FILE" --output "$PREPARED_CONFIG" \
  > "$WORK_TMP/config-meta.json" || fail 'config validation/normalization failed'
CONFIG_HASH=$(sha256_file "$PREPARED_CONFIG")
CONFIG_FINGERPRINT=$($NODE_RESOLVED -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.configHash)' "$WORK_TMP/config-meta.json")
JOURNAL_FILE=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.broker.journalFile)' "$PREPARED_CONFIG")
WORKSPACE_FILE=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.broker.workspaceLeaseFile)' "$PREPARED_CONFIG")

$NODE_RESOLVED "$SCRIPT_DIR/inspect-journal.mjs" "$JOURNAL_FILE" > "$WORK_TMP/journal.json" || fail 'operation journal is malformed or unsupported'
JOURNAL_VERSIONS=$($NODE_RESOLVED -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(j.versions.some(v=>v!==1&&v!==2))process.exit(3); process.stdout.write(j.versions.join(","))' "$WORK_TMP/journal.json") \
  || fail 'journal contains a format newer than this release'

RELEASE_ID=$VERSION-$(printf '%.12s' "$SOURCE_HASH")
CONFIG_ID=$RELEASE_ID-$(printf '%.12s' "$CONFIG_HASH")

xml_render() {
  $NODE_RESOLVED -e '
    const fs=require("fs");
    const esc=(s)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\"","&quot;").replaceAll("\x27","&apos;");
    let s=fs.readFileSync(process.argv[1],"utf8");
    for (const [token,value] of [["__LABEL_XML__",process.argv[3]],["__PREFIX_XML__",process.argv[4]]]) s=s.replaceAll(token,esc(value));
    fs.writeFileSync(process.argv[2],s,{mode:0o600});
  ' "$SCRIPT_DIR/../launchd/com.zamgune.unity-mcp-router.plist.template" "$1" "$LABEL" "$PREFIX"
}

DEPLOYMENT_SCRIPT_FILES='broker-admin.mjs
broker-launcher.sh
adapter-launcher.sh
admin-launcher.sh
rollback-launcher.sh
rollback-router.sh
inspect-journal.mjs
install-state.mjs
deployment-audit.mjs'
DEPLOYMENT_PAYLOAD=$WORK_TMP/deployment
mkdir -m 700 "$DEPLOYMENT_PAYLOAD"
cp -p -- "$PREPARED_CONFIG" "$DEPLOYMENT_PAYLOAD/config.json"
printf '%s\n' "$DEPLOYMENT_SCRIPT_FILES" | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  [ -f "$SCRIPT_DIR/$rel" ] && [ ! -L "$SCRIPT_DIR/$rel" ] || fail "deployment script missing or symlinked: $rel"
  cp -p -- "$SCRIPT_DIR/$rel" "$DEPLOYMENT_PAYLOAD/$rel"
done
xml_render "$DEPLOYMENT_PAYLOAD/launch-agent.plist"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$DEPLOYMENT_PAYLOAD/launch-agent.plist" >/dev/null || fail 'rendered LaunchAgent plist is invalid'
fi
printf '%s\n' "$RUNTIME_NODE" > "$DEPLOYMENT_PAYLOAD/node-bin.txt"
printf '%s\n' "$NODE_SHA" > "$DEPLOYMENT_PAYLOAD/node-sha256.txt"
printf '%s\n' "$JOURNAL_FORMAT" > "$DEPLOYMENT_PAYLOAD/journal-format.txt"
printf '%s\n' "$RELEASE_ID" > "$DEPLOYMENT_PAYLOAD/release-id.txt"
printf '%s\n' "$CONFIG_ID" > "$DEPLOYMENT_PAYLOAD/config-id.txt"
printf '%s\n' "$LABEL" > "$DEPLOYMENT_PAYLOAD/label.txt"
printf '%s\n' "$LAUNCH_AGENTS_DIR" > "$DEPLOYMENT_PAYLOAD/launch-agents-dir.txt"
printf '%s\n' "$LAUNCHCTL_BIN" > "$DEPLOYMENT_PAYLOAD/launchctl-bin.txt"
if [ "$STAGING" -eq 1 ]; then printf 'staging\n' > "$DEPLOYMENT_PAYLOAD/install-mode.txt"; else printf 'live\n' > "$DEPLOYMENT_PAYLOAD/install-mode.txt"; fi
PACKAGE_MANIFEST_SHA=$(sha256_file "$PACKAGE_MANIFEST")
PLIST_SHA=$(sha256_file "$DEPLOYMENT_PAYLOAD/launch-agent.plist")
$NODE_RESOLVED -e '
  const fs=require("fs"),crypto=require("crypto");
  const [root,out,releaseId,releaseVersion,sourceSha,releaseManifestSha,configId,configSha,configFingerprint,nodeBin,nodeSha,label,prefix,launchAgentsDir,launchctlBin,mode,journalFormat]=process.argv.slice(1);
  const names=["config.json","launch-agent.plist","broker-admin.mjs","broker-launcher.sh","adapter-launcher.sh","admin-launcher.sh","rollback-launcher.sh","rollback-router.sh","inspect-journal.mjs","install-state.mjs","deployment-audit.mjs"];
  const sha=(file)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const payloads=Object.fromEntries(names.sort().map(name=>[name,sha(`${root}/${name}`)]));
  const identity={version:1,nodeStorage:"managed-content-addressed-v1",releaseId,releaseVersion,buildId:`sha256:${sourceSha}`,sourceSha256:sourceSha,releaseManifestSha256:releaseManifestSha,configId,configSha256:configSha,configFingerprint,nodeBin,nodeSha256:nodeSha,label,prefix,launchAgentsDir,launchctlBin,installMode:mode,journalFormat:Number(journalFormat),plistSha256:payloads["launch-agent.plist"],payloads};
  fs.writeFileSync(out,JSON.stringify(identity,null,2)+"\n",{mode:0o600});
' "$DEPLOYMENT_PAYLOAD" "$DEPLOYMENT_PAYLOAD/identity.json" "$RELEASE_ID" "$VERSION" "$SOURCE_HASH" "$PACKAGE_MANIFEST_SHA" "$CONFIG_ID" "$CONFIG_HASH" "$CONFIG_FINGERPRINT" "$RUNTIME_NODE" "$NODE_SHA" "$LABEL" "$PREFIX" "$LAUNCH_AGENTS_DIR" "$LAUNCHCTL_BIN" "$([ "$STAGING" -eq 1 ] && printf staging || printf live)" "$JOURNAL_FORMAT"
IDENTITY_SHA=$(sha256_file "$DEPLOYMENT_PAYLOAD/identity.json")
DEPLOYMENT_ID=d-$(printf '%.32s' "$IDENTITY_SHA")
$NODE_RESOLVED -e '
  const fs=require("fs");const [identityFile,out,id,sha]=process.argv.slice(1);const identity=JSON.parse(fs.readFileSync(identityFile,"utf8"));
  fs.writeFileSync(out,JSON.stringify({deploymentId:id,identitySha256:sha,identity},null,2)+"\n",{mode:0o600});
' "$DEPLOYMENT_PAYLOAD/identity.json" "$DEPLOYMENT_PAYLOAD/deployment.json" "$DEPLOYMENT_ID" "$IDENTITY_SHA"
: > "$DEPLOYMENT_PAYLOAD/SHA256SUMS"
for rel in adapter-launcher.sh admin-launcher.sh broker-admin.mjs broker-launcher.sh config-id.txt config.json deployment-audit.mjs deployment.json identity.json inspect-journal.mjs install-mode.txt install-state.mjs journal-format.txt label.txt launch-agent.plist launch-agents-dir.txt launchctl-bin.txt node-bin.txt node-sha256.txt release-id.txt rollback-launcher.sh rollback-router.sh; do
  printf '%s  %s\n' "$(sha256_file "$DEPLOYMENT_PAYLOAD/$rel")" "$rel" >> "$DEPLOYMENT_PAYLOAD/SHA256SUMS"
done

while IFS= read -r client_config; do
  [ -n "$client_config" ] || continue
  case "$client_config" in /*) ;; *) fail "client config path must be absolute: $client_config" ;; esac
  [ -f "$client_config" ] && [ ! -L "$client_config" ] || fail "client config must be a regular, non-symlink file: $client_config"
done <<EOF
$CLIENT_CONFIGS
EOF

printf 'release=%s\nsource_sha256=%s\nconfig_sha256=%s\nnode=%s\nnode_version=%s\nnode_sha256=%s\njournal_format=%s\ndeployment=%s\nmode=%s\n' \
  "$VERSION" "$SOURCE_HASH" "$CONFIG_HASH" "$RUNTIME_NODE" "$NODE_VERSION" "$NODE_SHA" "$JOURNAL_FORMAT" "$DEPLOYMENT_ID" \
  "$([ "$DRY_RUN" -eq 1 ] && printf dry-run || { [ "$STAGING" -eq 1 ] && printf staging || printf live; })"

if [ "$DRY_RUN" -eq 1 ]; then
  exit 0
fi

owner_uid() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi
}
ensure_private_dir() {
  directory=$1
  [ ! -L "$directory" ] || fail "managed directory must not be a symlink: $directory"
  if [ -e "$directory" ]; then [ -d "$directory" ] || fail "managed path is not a directory: $directory"; else mkdir -p -- "$directory"; fi
  [ "$(owner_uid "$directory")" = "$(id -u)" ] || fail "managed directory is owned by another user: $directory"
  chmod 700 "$directory"
}
ensure_private_dir "$PREFIX"
ensure_private_dir "$PREFIX/run"
LOCK_FILE=$PREFIX/run/install.lock
LOCK_GUARD_FILE=$PREFIX/run/install-lock-cas.guard
[ -x /usr/bin/lockf ] || fail 'macOS /usr/bin/lockf is required for install-lock CAS serialization'
if [ ! -e "$LOCK_GUARD_FILE" ]; then
  (umask 077; set -C; : > "$LOCK_GUARD_FILE") 2>/dev/null || true
fi
[ -f "$LOCK_GUARD_FILE" ] && [ ! -L "$LOCK_GUARD_FILE" ] || fail "unsafe install lock guard path: $LOCK_GUARD_FILE"
[ "$(owner_uid "$LOCK_GUARD_FILE")" = "$(id -u)" ] || fail 'install lock guard owner mismatch'
[ "$(node_link_count "$LOCK_GUARD_FILE")" -eq 1 ] || fail 'install lock guard must not be hard-linked'
if stat -f '%Lp' "$LOCK_GUARD_FILE" >/dev/null 2>&1; then
  LOCK_GUARD_MODE=$(stat -f '%Lp' "$LOCK_GUARD_FILE")
else
  LOCK_GUARD_MODE=$(stat -c '%a' "$LOCK_GUARD_FILE")
fi
[ "$LOCK_GUARD_MODE" = 600 ] || fail 'install lock guard mode must be 0600'
exec 9>>"$LOCK_GUARD_FILE"
verify_operation_guard_fd() {
  "$NODE_RESOLVED" -e '
    const fs = require("fs");
    const file = process.argv[1];
    const pathStat = fs.lstatSync(file);
    const fdStat = fs.fstatSync(9);
    const uid = process.getuid?.();
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !fdStat.isFile() ||
        pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino ||
        (uid != null && (pathStat.uid !== uid || fdStat.uid !== uid)) ||
        (pathStat.mode & 0o777) !== 0o600 || (fdStat.mode & 0o777) !== 0o600 ||
        pathStat.nlink !== 1 || fdStat.nlink !== 1) process.exit(73);
  ' "$LOCK_GUARD_FILE" || fail 'install lock guard changed or became unsafe while opening'
}
verify_operation_guard_fd
/usr/bin/lockf -s -t 5 9 || fail 'install/rollback operation guard is busy'
verify_operation_guard_fd
SCRIPT_SHA=$INSTALL_LOCK_OWNER_SHA
LOCK_PAYLOAD=$WORK_TMP/install-lock.json
$NODE_RESOLVED "$SCRIPT_DIR/install-state.mjs" lock-payload --pid "$$" \
  --command-identity "install:$SCRIPT_SHA" --script-path "$INSTALL_LOCK_OWNER" --script-sha256 "$SCRIPT_SHA" > "$LOCK_PAYLOAD"
LOCK_ID=$($NODE_RESOLVED -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(v.lockId)' "$LOCK_PAYLOAD")
LOCK_SHA=$(sha256_file "$LOCK_PAYLOAD")
acquire_install_lock() {
  STALE_LOCK=$PREFIX/run/stale-install-lock-$(date -u +%Y%m%dT%H%M%SZ)-$$.json
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" lock-acquire \
    --file "$LOCK_FILE" --payload "$LOCK_PAYLOAD" --payload-sha256 "$LOCK_SHA" \
    --destination "$STALE_LOCK" >/dev/null \
    || fail 'could not acquire the guarded install/rollback lock'
  LOCK_HELD=1
}
acquire_install_lock

ensure_private_dir "$PREFIX/releases"
ensure_private_dir "$PREFIX/configs"
ensure_private_dir "$PREFIX/deployments"
ensure_private_dir "$PREFIX/runtimes"
ensure_private_dir "$PREFIX/backups"
ensure_private_dir "$PREFIX/bin"
ensure_private_dir "$PREFIX/logs"
ensure_private_dir "$LAUNCH_AGENTS_DIR"

RUNTIME_DIR=$PREFIX/runtimes/$NODE_SHA
if [ -e "$RUNTIME_DIR" ]; then
  [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] || fail "managed Node runtime target is not a real directory: $RUNTIME_DIR"
else
  RUNTIME_TMP=$PREFIX/runtimes/.install-$NODE_SHA-$$
  [ ! -e "$RUNTIME_TMP" ] || fail "managed Node runtime temporary path already exists: $RUNTIME_TMP"
  mkdir -m 700 "$RUNTIME_TMP"
  cp -- "$NODE_RESOLVED" "$RUNTIME_TMP/node" || fail 'could not copy the verified Node snapshot into the managed runtime'
  [ -f "$RUNTIME_TMP/node" ] && [ ! -L "$RUNTIME_TMP/node" ] || fail 'managed Node runtime copy is not a regular file'
  [ "$(node_link_count "$RUNTIME_TMP/node")" -eq 1 ] || fail 'managed Node runtime copy is unexpectedly hard-linked'
  chmod 500 "$RUNTIME_TMP/node"
  [ "$(sha256_file "$RUNTIME_TMP/node")" = "$NODE_SHA" ] || fail 'managed Node runtime copy failed SHA verification'
  [ "$("$RUNTIME_TMP/node" -p 'process.execPath')" = "$RUNTIME_TMP/node" ] || fail 'managed Node runtime copy is not self-contained or reported a different process.execPath'
  [ "$("$RUNTIME_TMP/node" -p 'process.versions.node')" = "$NODE_VERSION" ] || fail 'managed Node runtime copy changed Node version'
  if [ "$(uname -s)" = Darwin ]; then
    [ "$("$RUNTIME_TMP/node" -p 'process.platform')" = darwin ] || fail 'managed Node runtime copy changed platform'
    [ "$("$RUNTIME_TMP/node" -p 'process.arch')" = "$NODE_ARCH" ] || fail 'managed Node runtime copy changed architecture'
  fi
  chmod 500 "$RUNTIME_TMP"
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-tree --path "$RUNTIME_TMP" || fail 'could not durably sync managed Node runtime copy'
  mv -- "$RUNTIME_TMP" "$RUNTIME_DIR" || fail 'could not atomically publish managed Node runtime copy'
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-parent --path "$RUNTIME_DIR" || fail 'could not durably publish managed Node runtime copy'
fi
"$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" runtime-audit --prefix "$PREFIX" --node-sha256 "$NODE_SHA" \
  > "$WORK_TMP/runtime-audit.json" || fail 'managed Node runtime failed exact containment/ownership/mode/hash verification'

# All state mutation and recovery from this point uses only the immutable local
# runtime, never the input binary or the temporary snapshot.
NODE_RESOLVED=$RUNTIME_NODE

RELEASE_DIR=$PREFIX/releases/$RELEASE_ID
if [ -e "$RELEASE_DIR" ]; then
  [ -d "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] || fail "release target is not a directory: $RELEASE_DIR"
  cmp -s "$PACKAGE_MANIFEST" "$RELEASE_DIR/SHA256SUMS" || fail "immutable release manifest mismatch: $RELEASE_ID"
  (cd "$RELEASE_DIR" && while read -r expected rel; do [ "$(sha256_file "$rel")" = "$expected" ] || exit 1; done < SHA256SUMS) \
    || fail "immutable release content failed SHA verification: $RELEASE_ID"
else
  RELEASE_TMP=$PREFIX/releases/.install-$DEPLOYMENT_ID-$$
  mkdir -m 700 "$RELEASE_TMP"
  printf '%s\n' "$RUNTIME_FILES" | while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    mkdir -p -- "$RELEASE_TMP/$(dirname -- "$rel")"
    if [ "$rel" = release.json ]; then
      cp -p -- "$PACKAGED_RELEASE" "$RELEASE_TMP/$rel"
    else
      cp -p -- "$SOURCE_ROOT/$rel" "$RELEASE_TMP/$rel"
    fi
  done
  cp -p -- "$SOURCE_MANIFEST" "$RELEASE_TMP/SOURCE_SHA256SUMS"
  cp -p -- "$PACKAGE_MANIFEST" "$RELEASE_TMP/SHA256SUMS"
  (cd "$RELEASE_TMP" && while read -r expected rel; do [ "$(sha256_file "$rel")" = "$expected" ] || exit 1; done < SHA256SUMS) \
    || fail 'copied release failed SHA verification'
  chmod -R a-w "$RELEASE_TMP"
  mv -- "$RELEASE_TMP" "$RELEASE_DIR"
fi

verify_release_dir() {
  directory=$1
  [ -f "$directory/SHA256SUMS" ] || return 1
  (cd "$directory" && while read -r expected rel; do [ "$(sha256_file "$rel")" = "$expected" ] || exit 1; done < SHA256SUMS)
}
verify_release_dir "$RELEASE_DIR" || fail "release failed final SHA verification: $RELEASE_ID"

CONFIG_TARGET=$PREFIX/configs/$CONFIG_ID.json
if [ -e "$CONFIG_TARGET" ]; then
  [ -f "$CONFIG_TARGET" ] && [ ! -L "$CONFIG_TARGET" ] || fail 'immutable config target is not a regular file'
  [ "$(sha256_file "$CONFIG_TARGET")" = "$CONFIG_HASH" ] || fail "immutable config checksum mismatch: $CONFIG_ID"
else
  CONFIG_TMP=$PREFIX/configs/.install-$CONFIG_ID-$$
  cp -p -- "$PREPARED_CONFIG" "$CONFIG_TMP"
  chmod 400 "$CONFIG_TMP"
  mv -- "$CONFIG_TMP" "$CONFIG_TARGET"
fi

DEPLOYMENT_DIR=$PREFIX/deployments/$DEPLOYMENT_ID
if [ -e "$DEPLOYMENT_DIR" ]; then
  [ -d "$DEPLOYMENT_DIR" ] && [ ! -L "$DEPLOYMENT_DIR" ] || fail "deployment target is not a real directory: $DEPLOYMENT_DIR"
else
  DEPLOY_TMP=$PREFIX/deployments/.install-$DEPLOYMENT_ID-$$
  mkdir -m 700 "$DEPLOY_TMP"
  cp -p -- "$DEPLOYMENT_PAYLOAD/SHA256SUMS" "$DEPLOY_TMP/SHA256SUMS"
  while read -r expected rel; do
    [ -n "$rel" ] || continue
    cp -p -- "$DEPLOYMENT_PAYLOAD/$rel" "$DEPLOY_TMP/$rel"
  done < "$DEPLOYMENT_PAYLOAD/SHA256SUMS"
  chmod 500 "$DEPLOY_TMP/broker-launcher.sh" "$DEPLOY_TMP/adapter-launcher.sh" "$DEPLOY_TMP/admin-launcher.sh" "$DEPLOY_TMP/rollback-launcher.sh"
  chmod -R a-w "$DEPLOY_TMP"
  mv -- "$DEPLOY_TMP" "$DEPLOYMENT_DIR"
fi
$NODE_RESOLVED "$SCRIPT_DIR/deployment-audit.mjs" --prefix "$PREFIX" --target "deployments/$DEPLOYMENT_ID" --expected-label "$LABEL" \
  > "$WORK_TMP/candidate-audit.json" || fail "deployment failed identity/containment verification: $DEPLOYMENT_ID"
"$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-tree --path "$RELEASE_DIR" || fail 'could not durably sync immutable release'
"$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-file --file "$CONFIG_TARGET" || fail 'could not durably sync immutable config'
"$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-tree --path "$DEPLOYMENT_DIR" || fail 'could not durably sync immutable deployment'

atomic_link() {
  target=$1
  link=$2
  temp=$PREFIX/.link-$(basename -- "$link")-$$
  rm -f -- "$temp"
  ln -s "$target" "$temp" || return 1
  "$NODE_RESOLVED" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$temp" "$link" || return 1
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-parent --path "$link"
}

atomic_file_from() {
  source=$1
  destination=$2
  mode=${3:-600}
  temp=$(dirname -- "$destination")/.file-$(basename -- "$destination")-$$
  rm -f -- "$temp"
  cp -p -- "$source" "$temp" || return 1
  chmod "$mode" "$temp" || return 1
  "$NODE_RESOLVED" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$temp" "$destination" || return 1
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-file --file "$destination"
}

write_wrapper() {
  name=$1
  body=$2
  temp=$PREFIX/bin/.$name.$$
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_MODULES OPENSSL_ENGINES DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH DYLD_VERSIONED_FRAMEWORK_PATH DYLD_ROOT_PATH DYLD_IMAGE_SUFFIX DYLD_SHARED_REGION DYLD_SHARED_CACHE_DIR' \
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin' \
    'export PATH' \
    'LANG=C' \
    'LC_ALL=C' \
    'TZ=UTC' \
    'COLUMNS=4096' \
    'export LANG LC_ALL TZ COLUMNS' \
    'case "$0" in */*) SELF_PARENT=${0%/*} ;; *) SELF_PARENT=. ;; esac' \
    'SELF_DIR=$(CDPATH= cd -- "$SELF_PARENT" && pwd -P)' \
    'PREFIX=${SELF_DIR%/*}' \
    "$body" > "$temp"
  chmod 700 "$temp"
  "$NODE_RESOLVED" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$temp" "$PREFIX/bin/$name" || return 1
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-file --file "$PREFIX/bin/$name"
}

install_wrappers() {
  write_wrapper unity-mcp-adapter 'exec /bin/sh "$PREFIX/current/adapter-launcher.sh" "$@"' &&
  write_wrapper unity-mcp-router-admin 'exec /bin/sh "$PREFIX/current/admin-launcher.sh" "$@"' &&
  write_wrapper unity-mcp-router-rollback '
LOCK_GUARD_FILE=$PREFIX/run/install-lock-cas.guard
GUARD_NODE_SHA='"$NODE_SHA"'
GUARD_RUNTIME_ROOT=$PREFIX/runtimes/$GUARD_NODE_SHA
GUARD_NODE=$GUARD_RUNTIME_ROOT/node
[ -x /usr/bin/lockf ] || { printf "%s\n" "unity-mcp-router-rollback: macOS /usr/bin/lockf is required" >&2; exit 1; }
[ -d "$PREFIX/runtimes" ] && [ ! -L "$PREFIX/runtimes" ] && [ -d "$GUARD_RUNTIME_ROOT" ] && [ ! -L "$GUARD_RUNTIME_ROOT" ] || { printf "%s\n" "unity-mcp-router-rollback: managed guard runtime directory is unsafe" >&2; exit 1; }
GUARD_RUNTIMES_UID=$(stat -f "%u" "$PREFIX/runtimes")
GUARD_RUNTIMES_MODE=$(stat -f "%Lp" "$PREFIX/runtimes")
GUARD_RUNTIME_UID=$(stat -f "%u" "$GUARD_RUNTIME_ROOT")
GUARD_RUNTIME_MODE=$(stat -f "%Lp" "$GUARD_RUNTIME_ROOT")
[ "$GUARD_RUNTIMES_UID" = "$(id -u)" ] && [ "$GUARD_RUNTIMES_MODE" = 700 ] && [ "$GUARD_RUNTIME_UID" = "$(id -u)" ] && [ "$GUARD_RUNTIME_MODE" = 500 ] || { printf "%s\n" "unity-mcp-router-rollback: managed guard runtime ownership or mode is unsafe" >&2; exit 1; }
[ -f "$GUARD_NODE" ] && [ ! -L "$GUARD_NODE" ] && [ -x "$GUARD_NODE" ] || { printf "%s\n" "unity-mcp-router-rollback: managed guard Node is unavailable or unsafe" >&2; exit 1; }
GUARD_NODE_UID=$(stat -f "%u" "$GUARD_NODE")
GUARD_NODE_MODE=$(stat -f "%Lp" "$GUARD_NODE")
GUARD_NODE_LINKS=$(stat -f "%l" "$GUARD_NODE")
[ "$GUARD_NODE_UID" = "$(id -u)" ] && [ "$GUARD_NODE_MODE" = 500 ] && [ "$GUARD_NODE_LINKS" = 1 ] || { printf "%s\n" "unity-mcp-router-rollback: managed guard Node ownership, mode, or link count is unsafe" >&2; exit 1; }
GUARD_NODE_ACTUAL_SHA=$(/usr/bin/shasum -a 256 "$GUARD_NODE" | /usr/bin/cut -c 1-64)
[ "$GUARD_NODE_ACTUAL_SHA" = "$GUARD_NODE_SHA" ] || { printf "%s\n" "unity-mcp-router-rollback: managed guard Node checksum changed" >&2; exit 1; }
[ "$("$GUARD_NODE" -p "process.execPath")" = "$GUARD_NODE" ] || { printf "%s\n" "unity-mcp-router-rollback: managed guard Node reported a different process.execPath" >&2; exit 1; }
[ -f "$LOCK_GUARD_FILE" ] && [ ! -L "$LOCK_GUARD_FILE" ] || { printf "%s\n" "unity-mcp-router-rollback: unsafe operation guard path" >&2; exit 1; }
GUARD_UID=$(stat -f "%u" "$LOCK_GUARD_FILE")
GUARD_MODE=$(stat -f "%Lp" "$LOCK_GUARD_FILE")
GUARD_LINKS=$(stat -f "%l" "$LOCK_GUARD_FILE")
[ "$GUARD_UID" = "$(id -u)" ] && [ "$GUARD_MODE" = 600 ] && [ "$GUARD_LINKS" = 1 ] || { printf "%s\n" "unity-mcp-router-rollback: unsafe operation guard ownership, mode, or link count" >&2; exit 1; }
exec 9>>"$LOCK_GUARD_FILE"
verify_operation_guard_fd() {
  "$GUARD_NODE" -e "const fs=require(\"fs\");const p=fs.lstatSync(process.argv[1]);const f=fs.fstatSync(9);const uid=process.getuid?.();if(p.isSymbolicLink()||!p.isFile()||!f.isFile()||p.dev!==f.dev||p.ino!==f.ino||(uid!=null&&(p.uid!==uid||f.uid!==uid))||(p.mode&0o777)!==0o600||(f.mode&0o777)!==0o600||p.nlink!==1||f.nlink!==1)process.exit(73)" "$LOCK_GUARD_FILE" || { printf "%s\n" "unity-mcp-router-rollback: operation guard changed or became unsafe" >&2; exit 1; }
}
verify_operation_guard_fd
/usr/bin/lockf -s -t 5 9 || { printf "%s\n" "unity-mcp-router-rollback: install/rollback operation guard is busy" >&2; exit 1; }
verify_operation_guard_fd
exec /bin/sh "$PREFIX/current/rollback-launcher.sh" "$@"'
}

restore_wrappers() {
  backup=$1
  for name in unity-mcp-adapter unity-mcp-router-admin unity-mcp-router-rollback; do
    if [ -f "$backup/wrapper-$name" ] && [ ! -L "$backup/wrapper-$name" ]; then
      atomic_file_from "$backup/wrapper-$name" "$PREFIX/bin/$name" 700 || return 1
    else
      rm -f -- "$PREFIX/bin/$name" || return 1
      "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-parent --path "$PREFIX/bin/$name" || return 1
    fi
  done
}

audit_target() {
  target=$1
  output=$2
  case "$target" in deployments/d-[A-Fa-f0-9][A-Fa-f0-9]*) ;; *) return 1 ;; esac
  case "${target#deployments/}" in */*|*..*) return 1 ;; esac
  "$NODE_RESOLVED" "$SCRIPT_DIR/deployment-audit.mjs" --prefix "$PREFIX" --target "$target" --expected-label "$LABEL" > "$output"
}

job_snapshot() {
  if "$LAUNCHCTL_BIN" print "$DOMAIN/$LABEL" > "$WORK_TMP/job-print.txt" 2>/dev/null; then
    return 0
  else
    snapshot_rc=$?
  fi
  if [ "$snapshot_rc" -eq 113 ]; then return 1; fi
  return 2
}

pid_is_gone() {
  candidate_pid=$1
  [ -n "$candidate_pid" ] || return 0
  "$NODE_RESOLVED" -e '
    const pid = Number(process.argv[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(2);
    try { process.kill(pid, 0); process.exit(1); }
    catch (error) { process.exit(error?.code === "ESRCH" ? 0 : 2); }
  ' "$candidate_pid"
}

wait_for_job_unloaded() {
  unload_old_pid=${1:-}
  unload_bootout_pid=${2:-}
  unload_deadline=$3
  while :; do
    job_loaded=0
    if job_snapshot; then
      job_loaded=1
    else
      snapshot_rc=$?
      [ "$snapshot_rc" -eq 1 ] || job_loaded=1
    fi
    old_pid_gone=0
    bootout_pid_gone=0
    if pid_is_gone "$unload_old_pid"; then old_pid_gone=1; fi
    if pid_is_gone "$unload_bootout_pid"; then bootout_pid_gone=1; fi
    if [ "$job_loaded" -eq 0 ] && [ "$old_pid_gone" -eq 1 ] && [ "$bootout_pid_gone" -eq 1 ]; then return 0; fi
    [ "$(date +%s)" -lt "$unload_deadline" ] || return 1
    sleep 1
  done
}

ensure_job_unloaded() {
  unload_old_pid=${1:-}
  unload_bootout_pid=
  unload_state=unknown
  unload_deadline=$(( $(date +%s) + BOOTOUT_WAIT_SEC ))
  while [ "$unload_state" = unknown ]; do
    if job_snapshot; then
      unload_state=loaded
      unload_bootout_pid=$(job_pid)
    else
      snapshot_rc=$?
      if [ "$snapshot_rc" -eq 1 ]; then unload_state=absent; else
        [ "$(date +%s)" -lt "$unload_deadline" ] || return 1
        sleep 1
      fi
    fi
  done
  if [ "$unload_state" = loaded ]; then
    "$LAUNCHCTL_BIN" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi
  wait_for_job_unloaded "$unload_old_pid" "$unload_bootout_pid" "$unload_deadline"
}

job_pid() {
  $NODE_RESOLVED -e '
    const s=require("fs").readFileSync(process.argv[1],"utf8");
    const m=s.match(/\bpid\s*=\s*(\d+)/);if(m&&Number(m[1])>0)process.stdout.write(m[1]);
  ' "$WORK_TMP/job-print.txt"
}

verify_target_job() {
  target=$1
  timeout=$2
  access_mode=${3:-auto}
  audit=$WORK_TMP/verify-target.json
  access_error=$WORK_TMP/verify-project-access-error.txt
  : > "$access_error"
  audit_target "$target" "$audit" || return 1
  if ! job_snapshot; then return 1; fi
  expected_pid=$(job_pid)
  [ -n "$expected_pid" ] || return 1
  directory=$PREFIX/$target
  if ! /bin/sh "$directory/admin-launcher.sh" status --timeout-sec "$timeout" > "$WORK_TMP/verify-status.json" 2>/dev/null; then return 1; fi
  identity_doctor_supported=$($NODE_RESOLVED -e '
    const fs=require("fs"),path=require("path");
    const [auditFile,prefix,configFile]=process.argv.slice(1);
    const identity=JSON.parse(fs.readFileSync(auditFile,"utf8")).identity;
    const config=JSON.parse(fs.readFileSync(configFile,"utf8"));
    const decimal=(value)=>typeof value==="string"&&/^\d+$/.test(value);
    const canonical=(project)=>project&&typeof project==="object"&&!Array.isArray(project)&&
      typeof project.path==="string"&&path.isAbsolute(project.path)&&path.normalize(project.path)===project.path&&
      decimal(project.identity?.dev)&&decimal(project.identity?.ino)&&
      project.key===`dev:${project.identity.dev}:ino:${project.identity.ino}`;
    const supported=fs.existsSync(path.join(prefix,"releases",identity.releaseId,"lib","project-access-audit.mjs"))&&
      config.projectIdentityFormat==="canonical-devino-v1"&&Array.isArray(config.projects)&&config.projects.length>0&&config.projects.every(canonical);
    process.stdout.write(supported?"1":"0");
  ' "$audit" "$PREFIX" "$directory/config.json") || return 1
  if [ "$access_mode" = required ] && [ "$identity_doctor_supported" -ne 1 ]; then
    printf '%s\n' "Deployment $target lacks canonical-devino-v1 project identity metadata; strict project-access verification is required." > "$access_error"
    return 1
  fi
  if [ "$identity_doctor_supported" -ne 1 ]; then
    legacy_warning=$WORK_TMP/legacy-status-only-${target#deployments/}.warned
    if [ ! -e "$legacy_warning" ]; then
      printf 'install-router: WARNING: legacy deployment %s has no canonical-devino-v1 project identity metadata; migration/recovery verification is status-only, not strict project-access verification.\n' "$target" >&2
      : > "$legacy_warning"
    fi
  fi
  if [ "$identity_doctor_supported" -eq 1 ]; then
    set +e
    /bin/sh "$directory/admin-launcher.sh" doctor --timeout-sec "$timeout" > "$WORK_TMP/verify-doctor.json" 2>/dev/null
    doctor_rc=$?
    set -e
    case "$doctor_rc" in 0|3) ;; *) return 1 ;; esac
  fi
  process_audit_required=1
  if [ "${UNITY_MCP_INSTALLER_TEST_MODE:-0}" = 1 ] && [ "${UNITY_MCP_INSTALLER_SKIP_EXTERNAL_PROCESS_AUDIT:-0}" = 1 ]; then
    case "$PREFIX" in /private/tmp/*|/tmp/*) process_audit_required=0 ;; esac
  fi
  $NODE_RESOLVED -e '
    const fs=require("fs");const [statusFile,auditFile,pid,auditRequired,identityDoctorSupported,doctorFile,configFile,errorFile]=process.argv.slice(1);
    const status=JSON.parse(fs.readFileSync(statusFile,"utf8")).result;
    const identity=JSON.parse(fs.readFileSync(auditFile,"utf8")).identity;
    const broker=status?.broker;
    const fail=(message)=>{fs.writeFileSync(errorFile,`${message}\n`);process.exit(2);};
    if(!broker||broker.pid!==Number(pid)||broker.version!==identity.releaseVersion||broker.buildId!==identity.buildId||broker.configHash!==identity.configFingerprint||(identityDoctorSupported==="1"&&broker.executable!==identity.nodeBin)||status.unity?.supported!==true||(auditRequired==="1"&&status.processAudit?.ok!==true))process.exit(2);
    if(identityDoctorSupported==="1"){
      const doctorEnvelope=JSON.parse(fs.readFileSync(doctorFile,"utf8"));
      const doctor=doctorEnvelope.result;
      const config=JSON.parse(fs.readFileSync(configFile,"utf8"));
      const actual=doctor?.projectAccess?.projects;
      const decimal=(value)=>typeof value==="string"&&/^\d+$/.test(value);
      const identityKey=(value)=>decimal(value?.dev)&&decimal(value?.ino)?`dev:${value.dev}:ino:${value.ino}`:null;
      const sameIdentity=(left,right)=>identityKey(left)!==null&&left.dev===right.dev&&left.ino===right.ino;
      const problems=[];
      const expectedByKey=new Map();
      if(config.projectIdentityFormat!=="canonical-devino-v1"||!Array.isArray(config.projects))problems.push("prepared config identity format is invalid");
      if(Array.isArray(config.projects)&&config.projects.length===0)problems.push("prepared config has no projects");
      for(const project of Array.isArray(config.projects)?config.projects:[]){
        const canonicalKey=identityKey(project?.identity);
        if(typeof project?.path!=="string"||canonicalKey===null||project.key!==canonicalKey){
          problems.push(`invalid prepared project ${project?.path??project?.key??"<unknown>"}`);
          continue;
        }
        if(expectedByKey.has(project.key))problems.push(`duplicate configured key ${project.key}`);
        else expectedByKey.set(project.key,project);
      }
      const actualByKey=new Map();
      if(!Array.isArray(actual))problems.push("project audit result is missing");
      for(const project of Array.isArray(actual)?actual:[]){
        if(typeof project?.projectKey!=="string"){
          problems.push(`audit result without project key ${project?.projectPath??"<unknown>"}`);
          continue;
        }
        if(actualByKey.has(project.projectKey))problems.push(`duplicate audited key ${project.projectKey}`);
        else actualByKey.set(project.projectKey,project);
      }
      for(const [projectKey,expectedProject] of expectedByKey){
        const observed=actualByKey.get(projectKey);
        if(!observed){problems.push(`${expectedProject.path}: missing audit result`);continue;}
        if(observed.schemaVersion!==2)problems.push(`${expectedProject.path}: project audit schema mismatch`);
        if(observed.projectPath!==expectedProject.path)problems.push(`${expectedProject.path}: path mismatch`);
        if(!sameIdentity(observed.expectedIdentity,expectedProject.identity))problems.push(`${expectedProject.path}: expected identity mismatch`);
        if(!sameIdentity(observed.observedIdentity,expectedProject.identity))problems.push(`${expectedProject.path}: observed identity mismatch`);
        if(observed.responsibleExecutable!==identity.nodeBin)problems.push(`${expectedProject.path}: audit executable mismatch`);
        if(observed.ok!==true)problems.push(`${expectedProject.path}: ${observed.code??"access audit failed"}`);
      }
      for(const [projectKey,observed] of actualByKey){
        if(!expectedByKey.has(projectKey))problems.push(`${observed.projectPath??projectKey}: unexpected audit result`);
      }
      if(doctor?.responsibleExecutable!==identity.nodeBin)problems.push("doctor executable mismatch");
      if(doctor?.projectAccess?.responsibleExecutable!==identity.nodeBin)problems.push("project auditor executable mismatch");
      if(doctor?.projectAccess?.ok!==true)problems.push("project access aggregate failed");
      if(actualByKey.size!==expectedByKey.size)problems.push(`project count mismatch ${actualByKey.size}/${expectedByKey.size}`);
      if(problems.length>0){
        const summary=[...new Set(problems)].slice(0,8).join(", ")||"project audit result was incomplete";
        fail(`Managed Node ${identity.nodeBin} cannot access every configured Unity project with exact dev/ino identity (${summary}). In System Settings > Privacy & Security > Files and Folders, allow Removable Volumes, verify the mounted checkout, then retry.`);
      }
      if(auditRequired==="1"&&doctor?.processAudit?.ok!==true)process.exit(2);
    }
  ' "$WORK_TMP/verify-status.json" "$audit" "$expected_pid" "$process_audit_required" "$identity_doctor_supported" "$WORK_TMP/verify-doctor.json" "$directory/config.json" "$access_error" || return 1
  if ! job_snapshot; then
    printf 'LaunchAgent disappeared after broker status/doctor verification (expected PID %s).\n' "$expected_pid" > "$access_error"
    return 1
  fi
  verified_pid=$(job_pid)
  if [ -z "$verified_pid" ] || [ "$verified_pid" != "$expected_pid" ]; then
    printf 'LaunchAgent broker PID changed during status/doctor verification (expected %s, observed %s).\n' "$expected_pid" "${verified_pid:-none}" > "$access_error"
    return 1
  fi
  return 0
}

workspace_lease_count() {
  file=$1
  if [ ! -e "$file" ]; then printf '0\n'; return 0; fi
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  $NODE_RESOLVED -e '
    const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(p.version!==1||!Array.isArray(p.leases))process.exit(2);process.stdout.write(String(p.leases.length));
  ' "$file"
}

state_is_quiescent() {
  deployment_dir=$1
  journal=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.journalFile)' "$deployment_dir/config.json") || return 1
  workspace=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.workspaceLeaseFile)' "$deployment_dir/config.json") || return 1
  "$NODE_RESOLVED" "$deployment_dir/inspect-journal.mjs" "$journal" > "$WORK_TMP/quiescent-journal.json" || return 1
  active=$($NODE_RESOLVED -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.nonTerminal.length))' "$WORK_TMP/quiescent-journal.json") || return 1
  leases=$(workspace_lease_count "$workspace") || return 1
  [ "$active" -eq 0 ] && [ "$leases" -eq 0 ]
}

TRANSACTION_FILE=$PREFIX/run/transaction.json
set_transaction_phase() {
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-phase --file "$TRANSACTION_FILE" --phase "$1"
}

recover_pending_transaction() {
  [ -e "$TRANSACTION_FILE" ] || return 0
  [ -f "$TRANSACTION_FILE" ] && [ ! -L "$TRANSACTION_FILE" ] || return 1
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-read --file "$TRANSACTION_FILE" > "$WORK_TMP/recovery.json" || return 1
  tx_value() { $NODE_RESOLVED -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=v[process.argv[2]];if(x!==null&&x!==undefined)process.stdout.write(String(x))' "$WORK_TMP/recovery.json" "$1"; }
  TX_PREFIX=$(tx_value prefix)
  TX_LABEL=$(tx_value label)
  TX_PLIST=$(tx_value plistPath)
  TX_BACKUP=$(tx_value backupDir)
  TX_PHASE=$(tx_value phase)
  TX_OLD_CURRENT=$(tx_value oldCurrentTarget)
  TX_OLD_PREVIOUS=$(tx_value oldPreviousTarget)
  TX_CANDIDATE=$(tx_value candidateTarget)
  TX_OLD_LOADED=$(tx_value oldJobLoaded)
  TX_OLD_PID=$(tx_value oldJobPid)
  TX_STAGING=$(tx_value staging)
  TX_LAUNCHCTL=$(tx_value launchctlBin)
  [ "$TX_PREFIX" = "$PREFIX" ] && [ "$TX_LABEL" = "$LABEL" ] && [ "$TX_PLIST" = "$LAUNCH_AGENTS_DIR/$LABEL.plist" ] && [ "$TX_LAUNCHCTL" = "$LAUNCHCTL_BIN" ] || return 1
  case "$TX_BACKUP" in "$PREFIX"/backups/*) ;; *) return 1 ;; esac
  [ -d "$TX_BACKUP" ] && [ ! -L "$TX_BACKUP" ] || return 1
  if [ -n "$TX_OLD_CURRENT" ]; then audit_target "$TX_OLD_CURRENT" "$WORK_TMP/recovery-old.json" || return 1; fi
  if [ -n "$TX_OLD_PREVIOUS" ]; then audit_target "$TX_OLD_PREVIOUS" "$WORK_TMP/recovery-previous.json" || return 1; fi
  audit_target "$TX_CANDIDATE" "$WORK_TMP/recovery-candidate.json" || return 1

  if [ "$TX_PHASE" = VERIFIED ]; then
    install_wrappers || return 1
    if [ "$TX_STAGING" = true ]; then
      [ -L "$PREFIX/current" ] && [ "$(readlink "$PREFIX/current")" = "$TX_CANDIDATE" ] || return 1
      [ "$(sha256_file "$TX_PLIST")" = "$(sha256_file "$PREFIX/$TX_CANDIDATE/launch-agent.plist")" ] || return 1
    else
      verify_target_job "$TX_CANDIDATE" 10 required || return 1
    fi
    "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
    return 0
  fi

  if [ "$TX_PHASE" = PREPARED ]; then
    "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
    return 0
  fi

  if [ "$TX_STAGING" = false ] && { [ "$TX_PHASE" = DRAIN_INTENT ] || [ "$TX_PHASE" = DRAINED ]; } && \
     [ "$TX_OLD_LOADED" = true ] && [ -n "$TX_OLD_CURRENT" ] && [ -n "$TX_OLD_PID" ]; then
    if job_snapshot && [ "$(job_pid)" = "$TX_OLD_PID" ] && /bin/sh "$PREFIX/$TX_OLD_CURRENT/admin-launcher.sh" resume --timeout-sec 10 >/dev/null 2>&1 && verify_target_job "$TX_OLD_CURRENT" 10; then
      "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
      return 0
    fi
    return 1
  fi

  if [ "$TX_STAGING" = false ]; then
    ensure_job_unloaded "$TX_OLD_PID" || return 1
  fi
  if [ -n "$TX_OLD_CURRENT" ]; then atomic_link "$TX_OLD_CURRENT" "$PREFIX/current" || return 1; else
    rm -f -- "$PREFIX/current" || return 1
    "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-parent --path "$PREFIX/current" || return 1
  fi
  if [ -n "$TX_OLD_PREVIOUS" ]; then atomic_link "$TX_OLD_PREVIOUS" "$PREFIX/previous" || return 1; else
    rm -f -- "$PREFIX/previous" || return 1
    "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-parent --path "$PREFIX/previous" || return 1
  fi
  if [ "$(tx_value plistExisted)" = true ]; then
    atomic_file_from "$TX_BACKUP/launch-agent-before.plist" "$TX_PLIST" || return 1
  else
    rm -f -- "$TX_PLIST" || return 1
    "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-parent --path "$TX_PLIST" || return 1
  fi
  restore_wrappers "$TX_BACKUP" || return 1
  if [ "$TX_STAGING" = false ] && [ "$TX_OLD_LOADED" = true ]; then
    "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$TX_PLIST" || return 1
    "$LAUNCHCTL_BIN" kickstart -k "$DOMAIN/$LABEL" || return 1
    recovered=0
    recovery_deadline=$(( $(date +%s) + 30 ))
    while [ "$(date +%s)" -lt "$recovery_deadline" ]; do
      if verify_target_job "$TX_OLD_CURRENT" 5; then recovered=1; break; fi
      sleep 1
    done
    [ "$recovered" -eq 1 ] || return 1
  elif [ "$TX_STAGING" = false ]; then
    if job_snapshot; then return 1; else snapshot_rc=$?; [ "$snapshot_rc" -eq 1 ] || return 1; fi
  fi
  "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
}

UID_VALUE=$(id -u)
DOMAIN=gui/$UID_VALUE
if ! recover_pending_transaction; then
  if [ -f "$TRANSACTION_FILE" ] && [ ! -L "$TRANSACTION_FILE" ]; then
    "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-phase --file "$TRANSACTION_FILE" --phase RESTORE_FAILED >/dev/null 2>&1 || true
  fi
  fail "unfinished deployment transaction could not be safely recovered: $TRANSACTION_FILE"
fi

TXN=$(date -u +%Y%m%dT%H%M%SZ)-$$
BACKUP_DIR=$PREFIX/backups/$TXN
mkdir -m 700 "$BACKUP_DIR"
cp -p -- "$CONFIG_FILE" "$BACKUP_DIR/source-config.json"
chmod 600 "$BACKUP_DIR/source-config.json"
cp -p -- "$SOURCE_MANIFEST" "$BACKUP_DIR/source.SHA256SUMS"
cp -p -- "$PACKAGE_MANIFEST" "$BACKUP_DIR/package.SHA256SUMS"
if [ -L "$PREFIX/current" ]; then readlink "$PREFIX/current" > "$BACKUP_DIR/current-before.txt"; fi
if [ -L "$PREFIX/previous" ]; then readlink "$PREFIX/previous" > "$BACKUP_DIR/previous-before.txt"; fi
PLIST_PATH=$LAUNCH_AGENTS_DIR/$LABEL.plist
PLIST_EXISTED=0
if [ -L "$PLIST_PATH" ]; then fail "refusing to replace a symlinked LaunchAgent plist: $PLIST_PATH"; fi
if [ -e "$PLIST_PATH" ]; then
  [ -f "$PLIST_PATH" ] || fail "LaunchAgent path is not a regular file: $PLIST_PATH"
  cp -p -- "$PLIST_PATH" "$BACKUP_DIR/launch-agent-before.plist"
  PLIST_EXISTED=1
fi
client_index=0
: > "$BACKUP_DIR/client-configs.tsv"
while IFS= read -r client_config; do
  [ -n "$client_config" ] || continue
  client_index=$((client_index + 1))
  backup_name=client-$client_index.config
  cp -p -- "$client_config" "$BACKUP_DIR/$backup_name"
  chmod 600 "$BACKUP_DIR/$backup_name"
  printf '%s\t%s\t%s\n' "$backup_name" "$client_config" "$(sha256_file "$client_config")" >> "$BACKUP_DIR/client-configs.tsv"
done <<EOF
$CLIENT_CONFIGS
EOF
for wrapper_name in unity-mcp-adapter unity-mcp-router-admin unity-mcp-router-rollback; do
  wrapper_path=$PREFIX/bin/$wrapper_name
  if [ -L "$wrapper_path" ]; then fail "stable wrapper must not be a symlink: $wrapper_path"; fi
  if [ -e "$wrapper_path" ]; then
    [ -f "$wrapper_path" ] || fail "stable wrapper is not a regular file: $wrapper_path"
    cp -p -- "$wrapper_path" "$BACKUP_DIR/wrapper-$wrapper_name"
  fi
done
chmod -R go-rwx "$BACKUP_DIR"
"$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" sync-tree --path "$BACKUP_DIR" || fail 'could not durably sync transaction backup'

CURRENT_TARGET=
PREVIOUS_TARGET=
if [ -e "$PREFIX/current" ] && [ ! -L "$PREFIX/current" ]; then fail 'current must be a managed symlink'; fi
if [ -e "$PREFIX/previous" ] && [ ! -L "$PREFIX/previous" ]; then fail 'previous must be a managed symlink'; fi
if [ -L "$PREFIX/current" ]; then CURRENT_TARGET=$(readlink "$PREFIX/current"); fi
if [ -L "$PREFIX/previous" ]; then PREVIOUS_TARGET=$(readlink "$PREFIX/previous"); fi
if [ -n "$CURRENT_TARGET" ]; then audit_target "$CURRENT_TARGET" "$WORK_TMP/current-audit.json" || fail "current target failed exact containment/identity audit: $CURRENT_TARGET"; fi
if [ -n "$PREVIOUS_TARGET" ]; then audit_target "$PREVIOUS_TARGET" "$WORK_TMP/previous-audit.json" || fail "previous target failed exact containment/identity audit: $PREVIOUS_TARGET"; fi

if [ -n "$CURRENT_TARGET" ]; then
  CURRENT_DIR=$PREFIX/$CURRENT_TARGET
  CURRENT_RELEASE_ID=$(sed -n '1p' "$CURRENT_DIR/release-id.txt")
  CURRENT_RELEASE_DIR=$PREFIX/releases/$CURRENT_RELEASE_ID
  CURRENT_FORMAT=$(cat "$CURRENT_DIR/journal-format.txt")
  case "$CURRENT_FORMAT" in 1|2) ;; *) fail "unsupported current journal format: $CURRENT_FORMAT" ;; esac
  CURRENT_RELEASE_FORMAT=$($NODE_RESOLVED -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.journalFormat))' "$CURRENT_RELEASE_DIR/release.json")
  [ "$CURRENT_RELEASE_FORMAT" = "$CURRENT_FORMAT" ] || fail 'current deployment journal format metadata does not match its release'
  CURRENT_JOURNAL=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.journalFile)' "$CURRENT_DIR/config.json")
  CURRENT_WORKSPACE=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.workspaceLeaseFile)' "$CURRENT_DIR/config.json")
  if [ "$CURRENT_JOURNAL" != "$JOURNAL_FILE" ] && { [ -s "$CURRENT_JOURNAL" ] || [ -s "$JOURNAL_FILE" ]; }; then
    fail 'refusing to switch a non-empty operation journal to a different path'
  fi
  if [ "$CURRENT_WORKSPACE" != "$WORKSPACE_FILE" ] && { [ -s "$CURRENT_WORKSPACE" ] || [ -s "$WORKSPACE_FILE" ]; }; then
    fail 'refusing to switch a non-empty workspace lease store to a different path'
  fi
fi

DRAINED=0
OLD_WAS_LOADED=0
OLD_JOB_PID=
OLD_JOB_DEAD=0
if [ "$STAGING" -eq 0 ]; then
  [ -x "$LAUNCHCTL_BIN" ] || fail "launchctl is not executable: $LAUNCHCTL_BIN"
  SKIP_EXTERNAL_AUDIT=0
  if [ "${UNITY_MCP_INSTALLER_SKIP_EXTERNAL_PROCESS_AUDIT:-0}" = 1 ]; then
    if [ "${UNITY_MCP_INSTALLER_TEST_MODE:-0}" = 1 ]; then
      case "$PREFIX" in /private/tmp/*|/tmp/*) SKIP_EXTERNAL_AUDIT=1 ;; *) fail 'test-only process-audit bypass requires a /tmp prefix' ;; esac
    else
      fail 'process-audit bypass is available only in explicit installer test mode'
    fi
  fi
  if [ "$SKIP_EXTERNAL_AUDIT" -eq 0 ]; then
    if [ -n "${CURRENT_RELEASE_DIR:-}" ]; then
      "$NODE_RESOLVED" "$SCRIPT_DIR/installer-process-audit.mjs" --live \
        --current-release-dir "$CURRENT_RELEASE_DIR" > "$WORK_TMP/process-audit.json" \
        || fail 'installer process audit could not classify the process table'
    else
      "$NODE_RESOLVED" "$SCRIPT_DIR/installer-process-audit.mjs" --live \
        > "$WORK_TMP/process-audit.json" || fail 'installer process audit could not classify the process table'
    fi
    UNMANAGED_COUNT=$($NODE_RESOLVED -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.count))' "$WORK_TMP/process-audit.json")
    [ "$UNMANAGED_COUNT" -eq 0 ] || fail "$UNMANAGED_COUNT unmanaged direct Unity MCP/router process(es) are running; migrate/stop them before activation"
  fi
  if [ -z "$CURRENT_TARGET" ]; then
    if job_snapshot; then
      fail "LaunchAgent label is already loaded without a managed current deployment: $LABEL"
    else
      snapshot_rc=$?
      [ "$snapshot_rc" -eq 1 ] || fail "LaunchAgent state is unreadable for label: $LABEL"
    fi
  fi
  if [ -n "$CURRENT_TARGET" ]; then
    if job_snapshot; then
      OLD_WAS_LOADED=1
      OLD_JOB_PID=$(job_pid)
    else
      snapshot_rc=$?
      [ "$snapshot_rc" -eq 1 ] || fail "current LaunchAgent state is unreadable for label: $LABEL"
    fi
    CURRENT_NODE=$(sed -n '1p' "$CURRENT_DIR/node-bin.txt")
    CURRENT_NODE_SHA=$(sed -n '1p' "$CURRENT_DIR/node-sha256.txt")
    [ -f "$CURRENT_NODE" ] && [ ! -L "$CURRENT_NODE" ] && [ -x "$CURRENT_NODE" ] || fail 'current pinned node runtime is unavailable or symlinked'
    [ "$(sha256_file "$CURRENT_NODE")" = "$CURRENT_NODE_SHA" ] || fail 'current pinned node runtime checksum changed before execution'
    if [ "$OLD_WAS_LOADED" -eq 1 ] && [ -n "$OLD_JOB_PID" ]; then
      verify_target_job "$CURRENT_TARGET" 10 || fail 'launchd job PID does not match the audited broker build/config/process state'
    elif [ "$OLD_WAS_LOADED" -eq 1 ]; then
      set +e
      /bin/sh "$CURRENT_DIR/admin-launcher.sh" status --timeout-sec 3 > "$WORK_TMP/loaded-dead-status.json" 2>/dev/null
      loaded_dead_rc=$?
      set -e
      if [ "$loaded_dead_rc" -eq 0 ]; then
        fail 'LaunchAgent is loaded without a PID but a reachable broker exists; refusing to classify it as the launchd job'
      elif [ "$loaded_dead_rc" -ne 20 ]; then
        fail "loaded-but-dead broker reachability is ambiguous (admin exit $loaded_dead_rc)"
      fi
      state_is_quiescent "$CURRENT_DIR" || fail 'loaded-but-dead broker has nonterminal operations, leases, or unreadable durable state'
      OLD_JOB_DEAD=1
    fi
  fi
fi

$NODE_RESOLVED "$SCRIPT_DIR/install-state.mjs" transaction-begin --file "$TRANSACTION_FILE" \
  --transaction-id "$TXN" --operation install --prefix "$PREFIX" --candidate-target "deployments/$DEPLOYMENT_ID" \
  --old-current-target "$CURRENT_TARGET" --old-previous-target "$PREVIOUS_TARGET" --backup-dir "$BACKUP_DIR" \
  --plist-path "$PLIST_PATH" --plist-existed "$PLIST_EXISTED" --old-job-loaded "$OLD_WAS_LOADED" \
  --old-job-pid "$OLD_JOB_PID" --staging "$STAGING" --label "$LABEL" --launchctl-bin "$LAUNCHCTL_BIN" --owner-pid "$$" \
  || fail 'could not durably begin install transaction'

maybe_failpoint() {
  point=$1
  [ "${UNITY_MCP_INSTALLER_TEST_MODE:-0}" = 1 ] || return 0
  case "$PREFIX" in /private/tmp/*|/tmp/*) ;; *) return 1 ;; esac
  if [ "${UNITY_MCP_INSTALLER_FAILPOINT:-}" = "kill-$point" ]; then kill -9 "$$"; fi
  if [ "${UNITY_MCP_INSTALLER_FAILPOINT:-}" = "pause-$point" ]; then
    if [ -n "${UNITY_MCP_INSTALLER_FAILPOINT_READY:-}" ]; then printf '%s\n' "$point" > "$UNITY_MCP_INSTALLER_FAILPOINT_READY"; fi
    while :; do sleep 1; done
  fi
}

handle_signal() {
  signal=$1
  trap - HUP INT TERM
  if ! recover_pending_transaction; then
    set_transaction_phase RESTORE_FAILED >/dev/null 2>&1 || true
    printf 'install-router: ERROR: %s interrupted; restore FAILED, transaction retained at %s\n' "$signal" "$TRANSACTION_FILE" >&2
    exit 70
  fi
  printf 'install-router: %s interrupted; prior deployment restored\n' "$signal" >&2
  exit 130
}
trap 'handle_signal HUP' HUP
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

set_transaction_phase DRAIN_INTENT
if [ "$STAGING" -eq 0 ] && [ -n "$CURRENT_TARGET" ]; then
  if [ "$OLD_WAS_LOADED" -eq 1 ] && [ "$OLD_JOB_DEAD" -eq 0 ]; then
    set +e
    /bin/sh "$CURRENT_DIR/admin-launcher.sh" drain --timeout-sec "$DRAIN_TIMEOUT_SEC" > "$WORK_TMP/drain.json"
    drain_rc=$?
    set -e
    if [ "$drain_rc" -eq 0 ]; then
      DRAINED=1
    else
      /bin/sh "$CURRENT_DIR/admin-launcher.sh" resume --timeout-sec 10 >/dev/null 2>&1 || true
      set_transaction_phase PREPARED
      "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
      fail "launchd-owned broker did not drain cleanly (admin exit $drain_rc)"
    fi
  elif [ "$OLD_WAS_LOADED" -eq 0 ]; then
    set +e
    /bin/sh "$CURRENT_DIR/admin-launcher.sh" drain --timeout-sec 3 > "$WORK_TMP/offline-check.json"
    drain_rc=$?
    set -e
    if [ "$drain_rc" -eq 0 ]; then
      /bin/sh "$CURRENT_DIR/admin-launcher.sh" resume --timeout-sec 10 >/dev/null 2>&1 || true
      set_transaction_phase PREPARED
      "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
      fail 'a reachable broker is not owned by the LaunchAgent; refusing to switch it'
    elif [ "$drain_rc" -ne 20 ]; then
      set_transaction_phase PREPARED
      "$NODE_RESOLVED" "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
      fail "offline broker state is not safely classifiable (admin exit $drain_rc)"
    fi
  fi
fi
set_transaction_phase DRAINED
maybe_failpoint after-drain

set_transaction_phase BOOTOUT_INTENT
if [ "$STAGING" -eq 0 ] && [ "$OLD_WAS_LOADED" -eq 1 ]; then
  if ! ensure_job_unloaded "$OLD_JOB_PID"; then
    fail 'launchctl job registration or prior broker PID remained live after bounded bootout wait'
  fi
fi
set_transaction_phase BOOTED_OUT
maybe_failpoint after-bootout

abort_activation() {
  reason=$1
  if ! recover_pending_transaction; then
    set_transaction_phase RESTORE_FAILED >/dev/null 2>&1 || true
    fail "$reason; automatic file-state restore FAILED, use backup $BACKUP_DIR"
  fi
  fail "$reason; restored prior deployment"
}

set_transaction_phase PREVIOUS_SWITCH_INTENT
if [ -n "$CURRENT_TARGET" ] && [ "$CURRENT_TARGET" != "deployments/$DEPLOYMENT_ID" ]; then
  if ! atomic_link "$CURRENT_TARGET" "$PREFIX/previous"; then abort_activation 'could not update previous link'; fi
fi
set_transaction_phase PREVIOUS_SWITCHED
set_transaction_phase CURRENT_SWITCH_INTENT
if ! atomic_link "deployments/$DEPLOYMENT_ID" "$PREFIX/current"; then abort_activation 'could not update current link'; fi
set_transaction_phase CURRENT_SWITCHED
maybe_failpoint after-current-link
set_transaction_phase PLIST_SWITCH_INTENT
if ! atomic_file_from "$DEPLOYMENT_DIR/launch-agent.plist" "$PLIST_PATH"; then abort_activation 'could not install LaunchAgent plist'; fi
set_transaction_phase PLIST_SWITCHED
maybe_failpoint after-plist
if ! install_wrappers; then abort_activation 'could not install stable wrappers'; fi
maybe_failpoint after-wrappers

if [ "$STAGING" -eq 0 ]; then
  set_transaction_phase BOOTSTRAP_INTENT
  if ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$PLIST_PATH"; then
    abort_activation 'launchctl bootstrap failed'
  fi
  if ! "$LAUNCHCTL_BIN" kickstart -k "$DOMAIN/$LABEL"; then
    abort_activation 'launchctl kickstart failed'
  fi
  set_transaction_phase JOB_BOOTSTRAPPED
  maybe_failpoint after-bootstrap
  verified=0
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT_SEC ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if verify_target_job "deployments/$DEPLOYMENT_ID" 5 required; then verified=1; break; fi
    sleep 1
  done
  if [ "$verified" -ne 1 ]; then
    if [ -s "$WORK_TMP/verify-project-access-error.txt" ]; then sed -n '1p' "$WORK_TMP/verify-project-access-error.txt" >&2; fi
    abort_activation 'new broker did not pass exact build/config post-switch verification'
  fi
else
  audit_target "deployments/$DEPLOYMENT_ID" "$WORK_TMP/staging-post-audit.json" || abort_activation 'staging post-audit failed'
  [ -L "$PREFIX/current" ] && [ "$(readlink "$PREFIX/current")" = "deployments/$DEPLOYMENT_ID" ] || abort_activation 'staging current link post-check failed'
  [ "$(sha256_file "$PLIST_PATH")" = "$(sha256_file "$DEPLOYMENT_DIR/launch-agent.plist")" ] || abort_activation 'staging plist post-check failed'
fi

set_transaction_phase VERIFIED
maybe_failpoint after-verified
$NODE_RESOLVED "$SCRIPT_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE" || fail 'activation verified but transaction marker could not be cleared'

printf 'activated=%s\ncurrent=%s\nprevious=%s\nadapter=%s\nlaunch_agent=%s\nbackup=%s\n' \
  "$([ "$STAGING" -eq 1 ] && printf staging || printf live)" "$DEPLOYMENT_ID" "${CURRENT_TARGET#deployments/}" \
  "$PREFIX/bin/unity-mcp-adapter" "$PLIST_PATH" "$BACKUP_DIR"
