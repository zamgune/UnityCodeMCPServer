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

PREFIX=${HOME}/.unity-mcp-router
LAUNCH_AGENTS_DIR=${HOME}/Library/LaunchAgents
LABEL=com.zamgune.unity-mcp-router
LAUNCHCTL_BIN=/bin/launchctl
STAGING=0
DRAIN_TIMEOUT_SEC=60
VERIFY_TIMEOUT_SEC=30
BOOTOUT_WAIT_SEC=10

usage() {
  cat >&2 <<'EOF'
usage: rollback-router.sh [options]

Options:
  --prefix DIR
  --launch-agents-dir DIR
  --launchctl-bin FILE
  --label LABEL
  --drain-timeout-sec N    1..120
  --verify-timeout-sec N   1..60
  --staging                Fixture-only transaction under /private/tmp
EOF
  exit 64
}

fail() {
  printf 'rollback-router: ERROR: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --launch-agents-dir) [ "$#" -ge 2 ] || usage; LAUNCH_AGENTS_DIR=$2; shift 2 ;;
    --launchctl-bin) [ "$#" -ge 2 ] || usage; LAUNCHCTL_BIN=$2; shift 2 ;;
    --label) [ "$#" -ge 2 ] || usage; LABEL=$2; shift 2 ;;
    --drain-timeout-sec) [ "$#" -ge 2 ] || usage; DRAIN_TIMEOUT_SEC=$2; shift 2 ;;
    --verify-timeout-sec) [ "$#" -ge 2 ] || usage; VERIFY_TIMEOUT_SEC=$2; shift 2 ;;
    --staging) STAGING=1; shift ;;
    -h|--help) usage ;;
    *) fail "unknown option: $1" ;;
  esac
done

case "$PREFIX" in /*) ;; *) fail '--prefix must be absolute' ;; esac
case "$LAUNCH_AGENTS_DIR" in /*) ;; *) fail '--launch-agents-dir must be absolute' ;; esac
case "$LAUNCHCTL_BIN" in /*) ;; *) fail '--launchctl-bin must be absolute' ;; esac
case "$PREFIX" in /|'') fail 'refusing a broad install prefix' ;; esac
case "$LABEL" in *[!A-Za-z0-9._-]*|'') fail 'invalid LaunchAgent label' ;; esac
case "$DRAIN_TIMEOUT_SEC:$VERIFY_TIMEOUT_SEC" in *[!0-9:]*|:*) fail 'timeouts must be integers' ;; esac
[ "$DRAIN_TIMEOUT_SEC" -ge 1 ] && [ "$DRAIN_TIMEOUT_SEC" -le 120 ] || fail 'drain timeout must be 1..120 seconds'
[ "$VERIFY_TIMEOUT_SEC" -ge 1 ] && [ "$VERIFY_TIMEOUT_SEC" -le 60 ] || fail 'verify timeout must be 1..60 seconds'

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
  fail 'live rollback is supported only on macOS; use --staging for fixture tests'
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail 'shasum or sha256sum is required'
  fi
}

owner_uid() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi
}

for managed_dir in "$PREFIX" "$PREFIX/run" "$PREFIX/backups" "$PREFIX/deployments" "$PREFIX/releases" "$PREFIX/configs" "$PREFIX/runtimes"; do
  [ ! -L "$managed_dir" ] && [ -d "$managed_dir" ] || fail "managed directory is missing or symlinked: $managed_dir"
  [ "$(owner_uid "$managed_dir")" = "$(id -u)" ] || fail "managed directory is owned by another user: $managed_dir"
done

WORK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/unity-mcp-rollback.XXXXXX")
LOCK_HELD=0
LOCK_FILE=$PREFIX/run/install.lock
LOCK_GUARD_FILE=$PREFIX/run/install-lock-cas.guard
LOCK_ID=
LOCK_SHA=
cleanup() {
  if [ "$LOCK_HELD" -eq 1 ] && [ -n "$LOCK_ID" ] && [ -n "$LOCK_SHA" ]; then
    if "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" lock-release --file "$LOCK_FILE" \
      --expected-lock-id "$LOCK_ID" --expected-sha256 "$LOCK_SHA" >/dev/null 2>&1; then
      LOCK_HELD=0
    else
      printf 'rollback-router: ERROR: install lock ownership changed; foreign lock preserved at %s\n' "$LOCK_FILE" >&2
    fi
  fi
  rm -rf -- "$WORK_TMP"
}
trap cleanup EXIT HUP INT TERM

read_managed_link() {
  link=$1
  [ -L "$link" ] || return 1
  target=$(readlink "$link")
  case "$target" in deployments/d-[a-f0-9][a-f0-9]*) ;; *) return 1 ;; esac
  id=${target#deployments/d-}
  [ "${#id}" -eq 32 ] || return 1
  case "$id" in *[!a-f0-9]*) return 1 ;; esac
  printf '%s\n' "$target"
}

CURRENT_TARGET=$(read_managed_link "$PREFIX/current") || fail 'no valid managed current deployment'
CURRENT_DIR=$PREFIX/$CURRENT_TARGET
[ -d "$CURRENT_DIR" ] && [ ! -L "$CURRENT_DIR" ] || fail 'current deployment directory is missing or symlinked'

# This script is shipped only in managed-runtime deployments. Derive the Node
# path before executing deployment-provided JavaScript rather than trusting a
# mutable metadata path.
NODE_SHA_EXPECTED=$(sed -n '1p' "$CURRENT_DIR/node-sha256.txt")
case "$NODE_SHA_EXPECTED" in *[!a-f0-9]*|'') fail 'current pinned node checksum is invalid' ;; esac
[ "${#NODE_SHA_EXPECTED}" -eq 64 ] || fail 'current pinned node checksum is invalid'
NODE_RESOLVED=$PREFIX/runtimes/$NODE_SHA_EXPECTED/node
fs_uid() { if stat -f '%u' "$1" >/dev/null 2>&1; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi; }
fs_mode() { if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi; }
fs_links() { if stat -f '%l' "$1" >/dev/null 2>&1; then stat -f '%l' "$1"; else stat -c '%h' "$1"; fi; }
RUNTIMES_ROOT=$PREFIX/runtimes
RUNTIME_ROOT=$RUNTIMES_ROOT/$NODE_SHA_EXPECTED
[ -d "$RUNTIMES_ROOT" ] && [ ! -L "$RUNTIMES_ROOT" ] && [ "$(CDPATH= cd -- "$RUNTIMES_ROOT" && pwd -P)" = "$RUNTIMES_ROOT" ] &&
  [ "$(fs_uid "$RUNTIMES_ROOT")" = "$(id -u)" ] && [ "$(fs_mode "$RUNTIMES_ROOT")" = 700 ] &&
  [ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] && [ "$(CDPATH= cd -- "$RUNTIME_ROOT" && pwd -P)" = "$RUNTIME_ROOT" ] &&
  [ "$(fs_uid "$RUNTIME_ROOT")" = "$(id -u)" ] && [ "$(fs_mode "$RUNTIME_ROOT")" = 500 ] ||
  fail 'current managed runtime directory verification failed'
[ -f "$NODE_RESOLVED" ] && [ ! -L "$NODE_RESOLVED" ] && [ -x "$NODE_RESOLVED" ] || fail 'current pinned node runtime is unavailable or symlinked'
[ "$(fs_uid "$NODE_RESOLVED")" = "$(id -u)" ] && [ "$(fs_mode "$NODE_RESOLVED")" = 500 ] && [ "$(fs_links "$NODE_RESOLVED")" = 1 ] ||
  fail 'current managed node ownership, mode, or link count is unsafe'
[ "$(sha256_file "$NODE_RESOLVED")" = "$NODE_SHA_EXPECTED" ] || fail 'current pinned node runtime checksum changed before execution'
[ "$($NODE_RESOLVED -p 'process.execPath')" = "$NODE_RESOLVED" ] || fail 'current pinned node reported a different process.execPath'

RUNTIME_HELPER_DIR=$CURRENT_DIR
[ -x /usr/bin/lockf ] || fail 'macOS /usr/bin/lockf is required for install-lock CAS serialization'
[ -f "$LOCK_GUARD_FILE" ] && [ ! -L "$LOCK_GUARD_FILE" ] || fail "unsafe install lock guard path: $LOCK_GUARD_FILE"
[ "$(fs_uid "$LOCK_GUARD_FILE")" = "$(id -u)" ] && [ "$(fs_mode "$LOCK_GUARD_FILE")" = 600 ] && \
  [ "$(fs_links "$LOCK_GUARD_FILE")" = 1 ] || fail 'install lock guard ownership, mode, or link count is unsafe'
if stat -f '%i' /dev/fd/9 >/dev/null 2>&1; then
  :
else
  exec 9>>"$LOCK_GUARD_FILE"
fi
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
  ' "$LOCK_GUARD_FILE" || fail 'inherited operation guard fd does not match the managed guard'
}
verify_operation_guard_fd
/usr/bin/lockf -s -t 5 9 || fail 'install/rollback operation guard is busy'
verify_operation_guard_fd
audit_target() {
  target=$1
  output=$2
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/deployment-audit.mjs" --prefix "$PREFIX" --target "$target" --expected-label "$LABEL" > "$output"
}
audit_target "$CURRENT_TARGET" "$WORK_TMP/current-audit.json" || fail 'current deployment failed exact containment/identity audit'

ROLLBACK_SCRIPT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
[ -f "$ROLLBACK_SCRIPT" ] && [ ! -L "$ROLLBACK_SCRIPT" ] || fail 'rollback script path is not a regular file'
SCRIPT_SHA=$(sha256_file "$ROLLBACK_SCRIPT")
LOCK_PAYLOAD=$WORK_TMP/rollback-lock.json
"$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" lock-payload --pid "$$" \
  --command-identity "rollback:$SCRIPT_SHA" --script-path "$ROLLBACK_SCRIPT" --script-sha256 "$SCRIPT_SHA" > "$LOCK_PAYLOAD"
LOCK_ID=$("$NODE_RESOLVED" -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(v.lockId)' "$LOCK_PAYLOAD")
LOCK_SHA=$(sha256_file "$LOCK_PAYLOAD")
acquire_install_lock() {
  STALE_LOCK=$PREFIX/run/stale-install-lock-$(date -u +%Y%m%dT%H%M%SZ)-$$.json
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" lock-acquire \
    --file "$LOCK_FILE" --payload "$LOCK_PAYLOAD" --payload-sha256 "$LOCK_SHA" \
    --destination "$STALE_LOCK" >/dev/null \
    || fail 'could not acquire the guarded install/rollback lock'
  LOCK_HELD=1
}
acquire_install_lock

UID_VALUE=$(id -u)
DOMAIN=gui/$UID_VALUE
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
  "$NODE_RESOLVED" -e '
    const s=require("fs").readFileSync(process.argv[1],"utf8");
    const m=s.match(/\bpid\s*=\s*(\d+)/);if(m&&Number(m[1])>0)process.stdout.write(m[1]);
  ' "$WORK_TMP/job-print.txt"
}
atomic_link() {
  target=$1
  link=$2
  temp=$PREFIX/.link-$(basename -- "$link")-$$
  rm -f -- "$temp"
  ln -s "$target" "$temp" || return 1
  "$NODE_RESOLVED" -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$temp" "$link" || return 1
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" sync-parent --path "$link"
}
atomic_file_from() {
  source=$1
  destination=$2
  mode=${3:-600}
  temp=$(dirname -- "$destination")/.file-$(basename -- "$destination")-$$
  rm -f -- "$temp"
  cp -p -- "$source" "$temp" || return 1
  chmod "$mode" "$temp" || return 1
  "$NODE_RESOLVED" -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$temp" "$destination" || return 1
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" sync-file --file "$destination"
}
verify_target_job() {
  target=$1
  timeout=$2
  access_mode=${3:-auto}
  access_error=$WORK_TMP/verify-project-access-error.txt
  : > "$access_error"
  audit_target "$target" "$WORK_TMP/verify-audit.json" || return 1
  job_snapshot || return 1
  expected_pid=$(job_pid)
  [ -n "$expected_pid" ] || return 1
  directory=$PREFIX/$target
  /bin/sh "$directory/admin-launcher.sh" status --timeout-sec "$timeout" > "$WORK_TMP/verify-status.json" 2>/dev/null || return 1
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
  ' "$WORK_TMP/verify-audit.json" "$PREFIX" "$directory/config.json") || return 1
  if [ "$access_mode" = required ] && [ "$identity_doctor_supported" -ne 1 ]; then
    printf '%s\n' "Deployment $target lacks canonical-devino-v1 project identity metadata; strict project-access verification is required." > "$access_error"
    return 1
  fi
  if [ "$identity_doctor_supported" -ne 1 ]; then
    legacy_warning=$WORK_TMP/legacy-status-only-${target#deployments/}.warned
    if [ ! -e "$legacy_warning" ]; then
      printf 'rollback-router: WARNING: legacy deployment %s has no canonical-devino-v1 project identity metadata; migration/recovery verification is status-only, not strict project-access verification.\n' "$target" >&2
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
  "$NODE_RESOLVED" -e '
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
  ' "$WORK_TMP/verify-status.json" "$WORK_TMP/verify-audit.json" "$expected_pid" "$process_audit_required" "$identity_doctor_supported" "$WORK_TMP/verify-doctor.json" "$directory/config.json" "$access_error" || return 1
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

TRANSACTION_FILE=$PREFIX/run/transaction.json
set_transaction_phase() {
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-phase --file "$TRANSACTION_FILE" --phase "$1"
}
RECOVERY_FINALIZED=0
recover_pending_transaction() {
  [ -e "$TRANSACTION_FILE" ] || return 0
  [ -f "$TRANSACTION_FILE" ] && [ ! -L "$TRANSACTION_FILE" ] || return 1
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-read --file "$TRANSACTION_FILE" > "$WORK_TMP/recovery.json" || return 1
  tx_value() { "$NODE_RESOLVED" -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=v[process.argv[2]];if(x!==null&&x!==undefined)process.stdout.write(String(x))' "$WORK_TMP/recovery.json" "$1"; }
  TX_PREFIX=$(tx_value prefix)
  TX_LABEL=$(tx_value label)
  TX_PLIST=$(tx_value plistPath)
  TX_BACKUP=$(tx_value backupDir)
  TX_PHASE=$(tx_value phase)
  TX_OPERATION=$(tx_value operation)
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
    if [ "$TX_STAGING" = true ]; then
      [ -L "$PREFIX/current" ] && [ "$(readlink "$PREFIX/current")" = "$TX_CANDIDATE" ] || return 1
      [ "$(sha256_file "$TX_PLIST")" = "$(sha256_file "$PREFIX/$TX_CANDIDATE/launch-agent.plist")" ] || return 1
    else
      verify_target_job "$TX_CANDIDATE" 10 || return 1
    fi
    "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE" || return 1
    if [ "$TX_OPERATION" = rollback ]; then RECOVERY_FINALIZED=1; fi
    return 0
  fi
  if [ "$TX_PHASE" = PREPARED ]; then
    "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
    return 0
  fi
  if [ "$TX_STAGING" = false ] && { [ "$TX_PHASE" = DRAIN_INTENT ] || [ "$TX_PHASE" = DRAINED ]; } && \
     [ "$TX_OLD_LOADED" = true ] && [ -n "$TX_OLD_CURRENT" ] && [ -n "$TX_OLD_PID" ]; then
    if job_snapshot && [ "$(job_pid)" = "$TX_OLD_PID" ] && \
       /bin/sh "$PREFIX/$TX_OLD_CURRENT/admin-launcher.sh" resume --timeout-sec 10 >/dev/null 2>&1 && \
       verify_target_job "$TX_OLD_CURRENT" 10; then
      "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
      return 0
    fi
    return 1
  fi
  if [ "$TX_STAGING" = false ]; then
    ensure_job_unloaded "$TX_OLD_PID" || return 1
  fi
  if [ -n "$TX_OLD_CURRENT" ]; then atomic_link "$TX_OLD_CURRENT" "$PREFIX/current" || return 1; else
    rm -f -- "$PREFIX/current" || return 1
    "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" sync-parent --path "$PREFIX/current" || return 1
  fi
  if [ -n "$TX_OLD_PREVIOUS" ]; then atomic_link "$TX_OLD_PREVIOUS" "$PREFIX/previous" || return 1; else
    rm -f -- "$PREFIX/previous" || return 1
    "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" sync-parent --path "$PREFIX/previous" || return 1
  fi
  if [ "$(tx_value plistExisted)" = true ]; then atomic_file_from "$TX_BACKUP/launch-agent-before.plist" "$TX_PLIST" || return 1; else
    rm -f -- "$TX_PLIST" || return 1
    "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" sync-parent --path "$TX_PLIST" || return 1
  fi
  if [ "$TX_STAGING" = false ] && [ "$TX_OLD_LOADED" = true ]; then
    "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$TX_PLIST" || return 1
    "$LAUNCHCTL_BIN" kickstart -k "$DOMAIN/$LABEL" || return 1
    recovered=0
    deadline=$(( $(date +%s) + 30 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do if verify_target_job "$TX_OLD_CURRENT" 5; then recovered=1; break; fi; sleep 1; done
    [ "$recovered" -eq 1 ] || return 1
  elif [ "$TX_STAGING" = false ]; then
    if job_snapshot; then return 1; else snapshot_rc=$?; [ "$snapshot_rc" -eq 1 ] || return 1; fi
  fi
  "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
}

if ! recover_pending_transaction; then
  if [ -f "$TRANSACTION_FILE" ] && [ ! -L "$TRANSACTION_FILE" ]; then set_transaction_phase RESTORE_FAILED >/dev/null 2>&1 || true; fi
  fail "unfinished deployment transaction could not be safely recovered: $TRANSACTION_FILE"
fi
if [ "$RECOVERY_FINALIZED" -eq 1 ]; then
  printf 'rollback_recovery=finalized\ncurrent=%s\n' "${TX_CANDIDATE#deployments/}"
  exit 0
fi

# Recovery may have restored links. Re-read and audit both endpoints.
CURRENT_TARGET=$(read_managed_link "$PREFIX/current") || fail 'no valid managed current deployment'
PREVIOUS_TARGET=$(read_managed_link "$PREFIX/previous") || fail 'no valid previous deployment to roll back to'
[ "$CURRENT_TARGET" != "$PREVIOUS_TARGET" ] || fail 'current and previous point to the same deployment'
CURRENT_DIR=$PREFIX/$CURRENT_TARGET
TARGET_DIR=$PREFIX/$PREVIOUS_TARGET
audit_target "$CURRENT_TARGET" "$WORK_TMP/current-audit.json" || fail 'current deployment failed identity audit after recovery'
audit_target "$PREVIOUS_TARGET" "$WORK_TMP/target-audit.json" || fail 'previous deployment failed exact containment/identity audit'
EXPECT_LABEL="$LABEL" EXPECT_AGENTS="$LAUNCH_AGENTS_DIR" EXPECT_LAUNCHCTL="$LAUNCHCTL_BIN" \
EXPECT_MODE="$([ "$STAGING" -eq 1 ] && printf staging || printf live)" \
"$NODE_RESOLVED" -e '
  const fs=require("fs");
  for(const file of process.argv.slice(1)){
    const i=JSON.parse(fs.readFileSync(file,"utf8")).identity;
    if(i.label!==process.env.EXPECT_LABEL||i.launchAgentsDir!==process.env.EXPECT_AGENTS||i.launchctlBin!==process.env.EXPECT_LAUNCHCTL||i.installMode!==process.env.EXPECT_MODE)process.exit(2);
  }
' "$WORK_TMP/current-audit.json" "$WORK_TMP/target-audit.json" \
  || fail 'rollback context does not match immutable deployment identity'

TARGET_NODE=$(sed -n '1p' "$TARGET_DIR/node-bin.txt")
TARGET_NODE_SHA=$(sed -n '1p' "$TARGET_DIR/node-sha256.txt")
[ -f "$TARGET_NODE" ] && [ ! -L "$TARGET_NODE" ] && [ -x "$TARGET_NODE" ] || fail 'rollback pinned node runtime is unavailable or symlinked'
[ "$(sha256_file "$TARGET_NODE")" = "$TARGET_NODE_SHA" ] || fail 'rollback node runtime checksum changed before execution'

CURRENT_FORMAT=$(sed -n '1p' "$CURRENT_DIR/journal-format.txt")
TARGET_FORMAT=$(sed -n '1p' "$TARGET_DIR/journal-format.txt")
case "$CURRENT_FORMAT:$TARGET_FORMAT" in 1:1|1:2|2:1|2:2) ;; *) fail 'unsupported journal format metadata' ;; esac
CURRENT_RELEASE_ID=$(sed -n '1p' "$CURRENT_DIR/release-id.txt")
TARGET_RELEASE_ID=$(sed -n '1p' "$TARGET_DIR/release-id.txt")
CURRENT_RELEASE_DIR=$PREFIX/releases/$CURRENT_RELEASE_ID
TARGET_RELEASE_DIR=$PREFIX/releases/$TARGET_RELEASE_ID
CURRENT_RELEASE_FORMAT=$($NODE_RESOLVED -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.journalFormat))' "$CURRENT_RELEASE_DIR/release.json")
TARGET_RELEASE_FORMAT=$($NODE_RESOLVED -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.journalFormat))' "$TARGET_RELEASE_DIR/release.json")
[ "$CURRENT_RELEASE_FORMAT" = "$CURRENT_FORMAT" ] && [ "$TARGET_RELEASE_FORMAT" = "$TARGET_FORMAT" ] || fail 'journal format metadata does not match release metadata'

CURRENT_JOURNAL=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.journalFile)' "$CURRENT_DIR/config.json")
TARGET_JOURNAL=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.journalFile)' "$TARGET_DIR/config.json")
CURRENT_WORKSPACE=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.workspaceLeaseFile)' "$CURRENT_DIR/config.json")
TARGET_WORKSPACE=$($NODE_RESOLVED -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.broker.workspaceLeaseFile)' "$TARGET_DIR/config.json")
if [ "$CURRENT_JOURNAL" != "$TARGET_JOURNAL" ] && { [ -s "$CURRENT_JOURNAL" ] || [ -s "$TARGET_JOURNAL" ]; }; then fail 'refusing rollback across different non-empty operation journal paths'; fi
if [ "$CURRENT_WORKSPACE" != "$TARGET_WORKSPACE" ] && { [ -s "$CURRENT_WORKSPACE" ] || [ -s "$TARGET_WORKSPACE" ]; }; then fail 'refusing rollback across different non-empty workspace lease paths'; fi

"$NODE_RESOLVED" "$CURRENT_DIR/inspect-journal.mjs" "$CURRENT_JOURNAL" > "$WORK_TMP/journal.json" || fail 'operation journal is malformed'
if ! "$NODE_RESOLVED" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.versions.some(v=>v!==1&&v!==2))process.exit(2)' "$WORK_TMP/journal.json"; then fail 'operation journal contains an unsupported future format'; fi
HAS_V2=$($NODE_RESOLVED -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.hasV2?"1":"0")' "$WORK_TMP/journal.json")
NON_TERMINAL_V2=$($NODE_RESOLVED -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.nonTerminalV2.length))' "$WORK_TMP/journal.json")
if [ "$TARGET_FORMAT" -eq 1 ] && { [ "$HAS_V2" -eq 1 ] || [ "$NON_TERMINAL_V2" -gt 0 ]; }; then fail 'journalFormat 1 rollback blocked by v2 journal state'; fi
if [ "$TARGET_FORMAT" -eq 1 ] && [ -e "$CURRENT_WORKSPACE" ]; then
  WORKSPACE_COUNT=$($NODE_RESOLVED -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(p.version!==1||!Array.isArray(p.leases))process.exit(2);process.stdout.write(String(p.leases.length))' "$CURRENT_WORKSPACE") || fail 'durable workspace lease store is malformed'
  [ "$WORKSPACE_COUNT" -eq 0 ] || fail 'journalFormat 1 rollback blocked by a durable workspace lease'
fi

PLIST_PATH=$LAUNCH_AGENTS_DIR/$LABEL.plist
if [ -L "$PLIST_PATH" ]; then fail "refusing a symlinked LaunchAgent plist: $PLIST_PATH"; fi
if [ -e "$PLIST_PATH" ]; then [ -f "$PLIST_PATH" ] || fail 'LaunchAgent path is not a regular file'; fi
STARTED_AT=$(date +%s)
TXN=$(date -u +%Y%m%dT%H%M%SZ)-rollback-$$
BACKUP_DIR=$PREFIX/backups/$TXN
mkdir -m 700 "$BACKUP_DIR"
printf '%s\n' "$CURRENT_TARGET" > "$BACKUP_DIR/current-before.txt"
printf '%s\n' "$PREVIOUS_TARGET" > "$BACKUP_DIR/previous-before.txt"
PLIST_EXISTED=0
if [ -e "$PLIST_PATH" ]; then cp -p -- "$PLIST_PATH" "$BACKUP_DIR/launch-agent-before.plist"; PLIST_EXISTED=1; fi
chmod -R go-rwx "$BACKUP_DIR"
"$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" sync-tree --path "$BACKUP_DIR" || fail 'could not durably sync rollback backup'

workspace_lease_count() {
  file=$1
  if [ ! -e "$file" ]; then printf '0\n'; return 0; fi
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  "$NODE_RESOLVED" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(p.version!==1||!Array.isArray(p.leases))process.exit(2);process.stdout.write(String(p.leases.length))' "$file"
}
state_is_quiescent() {
  "$NODE_RESOLVED" "$CURRENT_DIR/inspect-journal.mjs" "$CURRENT_JOURNAL" > "$WORK_TMP/quiescent.json" || return 1
  active=$($NODE_RESOLVED -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.nonTerminal.length))' "$WORK_TMP/quiescent.json") || return 1
  leases=$(workspace_lease_count "$CURRENT_WORKSPACE") || return 1
  [ "$active" -eq 0 ] && [ "$leases" -eq 0 ]
}

OLD_WAS_LOADED=0
OLD_JOB_PID=
OLD_JOB_DEAD=0
DRAINED=0
if [ "$STAGING" -eq 0 ]; then
  [ -x "$LAUNCHCTL_BIN" ] || fail "launchctl is not executable: $LAUNCHCTL_BIN"
  if job_snapshot; then OLD_WAS_LOADED=1; OLD_JOB_PID=$(job_pid); else
    snapshot_rc=$?
    [ "$snapshot_rc" -eq 1 ] || fail "current LaunchAgent state is unreadable for label: $LABEL"
  fi
  if [ "$OLD_WAS_LOADED" -eq 1 ] && [ -n "$OLD_JOB_PID" ]; then
    verify_target_job "$CURRENT_TARGET" 10 || fail 'launchd job PID does not match the current broker identity'
  elif [ "$OLD_WAS_LOADED" -eq 1 ]; then
    set +e
    /bin/sh "$CURRENT_DIR/admin-launcher.sh" status --timeout-sec 3 > "$WORK_TMP/loaded-dead-status.json" 2>/dev/null
    loaded_dead_rc=$?
    set -e
    if [ "$loaded_dead_rc" -eq 0 ]; then
      fail 'LaunchAgent is loaded without a PID but a reachable broker exists; refusing rollback ownership classification'
    elif [ "$loaded_dead_rc" -ne 20 ]; then
      fail "loaded-but-dead broker reachability is ambiguous (admin exit $loaded_dead_rc)"
    fi
    state_is_quiescent || fail 'loaded-but-dead broker has nonterminal operations, leases, or unreadable state'
    OLD_JOB_DEAD=1
  fi
fi

"$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-begin --file "$TRANSACTION_FILE" \
  --transaction-id "$TXN" --operation rollback --prefix "$PREFIX" --candidate-target "$PREVIOUS_TARGET" \
  --old-current-target "$CURRENT_TARGET" --old-previous-target "$PREVIOUS_TARGET" --backup-dir "$BACKUP_DIR" \
  --plist-path "$PLIST_PATH" --plist-existed "$PLIST_EXISTED" --old-job-loaded "$OLD_WAS_LOADED" \
  --old-job-pid "$OLD_JOB_PID" --staging "$STAGING" --label "$LABEL" --launchctl-bin "$LAUNCHCTL_BIN" --owner-pid "$$" \
  || fail 'could not durably begin rollback transaction'

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
    printf 'rollback-router: ERROR: %s interrupted; restore FAILED, transaction retained at %s\n' "$signal" "$TRANSACTION_FILE" >&2
    exit 70
  fi
  printf 'rollback-router: %s interrupted; prior deployment restored\n' "$signal" >&2
  exit 130
}
trap 'handle_signal HUP' HUP
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
abort_rollback() {
  reason=$1
  if ! recover_pending_transaction; then
    set_transaction_phase RESTORE_FAILED >/dev/null 2>&1 || true
    fail "$reason; automatic restore FAILED, use backup $BACKUP_DIR"
  fi
  fail "$reason; restored original deployment"
}

set_transaction_phase DRAIN_INTENT
if [ "$STAGING" -eq 0 ]; then
  if [ "$OLD_WAS_LOADED" -eq 1 ] && [ "$OLD_JOB_DEAD" -eq 0 ]; then
    set +e
    /bin/sh "$CURRENT_DIR/admin-launcher.sh" drain --timeout-sec "$DRAIN_TIMEOUT_SEC" > "$WORK_TMP/drain.json"
    drain_rc=$?
    set -e
    if [ "$drain_rc" -eq 0 ]; then DRAINED=1; else
      /bin/sh "$CURRENT_DIR/admin-launcher.sh" resume --timeout-sec 10 >/dev/null 2>&1 || true
      set_transaction_phase PREPARED
      "$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE"
      fail "current broker did not drain cleanly (admin exit $drain_rc)"
    fi
  elif [ "$OLD_WAS_LOADED" -eq 0 ]; then
    set +e
    /bin/sh "$CURRENT_DIR/admin-launcher.sh" drain --timeout-sec 3 > "$WORK_TMP/offline.json"
    drain_rc=$?
    set -e
    if [ "$drain_rc" -eq 0 ]; then
      /bin/sh "$CURRENT_DIR/admin-launcher.sh" resume --timeout-sec 10 >/dev/null 2>&1 || true
      abort_rollback 'a reachable broker is not owned by the LaunchAgent'
    elif [ "$drain_rc" -ne 20 ]; then
      abort_rollback "offline broker state is not safely classifiable (admin exit $drain_rc)"
    fi
  fi
fi
set_transaction_phase DRAINED
maybe_failpoint after-drain

set_transaction_phase BOOTOUT_INTENT
if [ "$STAGING" -eq 0 ] && [ "$OLD_WAS_LOADED" -eq 1 ]; then
  ensure_job_unloaded "$OLD_JOB_PID" || abort_rollback 'launchctl job registration or prior broker PID remained live after bounded bootout wait'
fi
set_transaction_phase BOOTED_OUT
maybe_failpoint after-bootout

set_transaction_phase PREVIOUS_SWITCH_INTENT
atomic_link "$CURRENT_TARGET" "$PREFIX/previous" || abort_rollback 'could not update previous link'
set_transaction_phase PREVIOUS_SWITCHED
set_transaction_phase CURRENT_SWITCH_INTENT
atomic_link "$PREVIOUS_TARGET" "$PREFIX/current" || abort_rollback 'could not update current link'
set_transaction_phase CURRENT_SWITCHED
maybe_failpoint after-current-link
set_transaction_phase PLIST_SWITCH_INTENT
atomic_file_from "$TARGET_DIR/launch-agent.plist" "$PLIST_PATH" || abort_rollback 'could not install rollback LaunchAgent plist'
set_transaction_phase PLIST_SWITCHED
maybe_failpoint after-plist

if [ "$STAGING" -eq 0 ]; then
  set_transaction_phase BOOTSTRAP_INTENT
  "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$PLIST_PATH" || abort_rollback 'rollback broker bootstrap failed'
  "$LAUNCHCTL_BIN" kickstart -k "$DOMAIN/$LABEL" || abort_rollback 'rollback broker kickstart failed'
  set_transaction_phase JOB_BOOTSTRAPPED
  maybe_failpoint after-bootstrap
  verified=0
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT_SEC ))
  # An immutable pre-canonical-devino migration target may only prove
  # exact status/process identity. verify_target_job emits an explicit legacy
  # warning for that bounded compatibility path; every prepared target still
  # runs the strict identity doctor automatically.
  while [ "$(date +%s)" -lt "$deadline" ]; do if verify_target_job "$PREVIOUS_TARGET" 5; then verified=1; break; fi; sleep 1; done
  if [ "$verified" -ne 1 ]; then
    if [ -s "$WORK_TMP/verify-project-access-error.txt" ]; then sed -n '1p' "$WORK_TMP/verify-project-access-error.txt" >&2; fi
    abort_rollback 'rollback broker failed exact PID/build/version/config/project-access post-switch verification'
  fi
else
  audit_target "$PREVIOUS_TARGET" "$WORK_TMP/staging-post.json" || abort_rollback 'staging rollback target audit failed'
  [ -L "$PREFIX/current" ] && [ "$(readlink "$PREFIX/current")" = "$PREVIOUS_TARGET" ] || abort_rollback 'staging current link post-check failed'
  [ -L "$PREFIX/previous" ] && [ "$(readlink "$PREFIX/previous")" = "$CURRENT_TARGET" ] || abort_rollback 'staging previous link post-check failed'
  [ "$(sha256_file "$PLIST_PATH")" = "$(sha256_file "$TARGET_DIR/launch-agent.plist")" ] || abort_rollback 'staging plist post-check failed'
fi

set_transaction_phase VERIFIED
maybe_failpoint after-verified
"$NODE_RESOLVED" "$RUNTIME_HELPER_DIR/install-state.mjs" transaction-clear --file "$TRANSACTION_FILE" || fail 'rollback verified but transaction marker could not be cleared'
ELAPSED=$(( $(date +%s) - STARTED_AT ))
[ "$ELAPSED" -lt 300 ] || fail "rollback exceeded the five-minute budget (${ELAPSED}s)"
printf 'rolled_back_to=%s\nprevious_now=%s\nelapsed_seconds=%s\nmode=%s\nbackup=%s\n' \
  "${PREVIOUS_TARGET#deployments/}" "${CURRENT_TARGET#deployments/}" "$ELAPSED" \
  "$([ "$STAGING" -eq 1 ] && printf staging || printf live)" "$BACKUP_DIR"
