#!/usr/bin/env bash

set -Eeuo pipefail
set +x
umask 077

readonly worker_user="signal-foundry-x"
readonly config_file="/etc/signal-foundry/x-for-you.env"

if [[ "${EUID}" -eq 0 ]]; then
  if printf '%s\0%s\0%s\0' \
    "${X_WEB_AUTOMATION_ENABLED:-}" \
    "${X_WEB_AUTOMATION_APPROVED_ACCOUNT:-}" \
    "${X_FOR_YOU_RESULT_URL:-}" | \
    /usr/sbin/runuser -u "${worker_user}" -- \
      /usr/bin/env -i \
      HOME="/var/lib/${worker_user}" \
      LANG="C.UTF-8" \
      PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      "$0" "$@"
  then
    exit 0
  else
    exit $?
  fi
fi

if [[ "$(id -un)" != "${worker_user}" ]]; then
  printf '%s\n' "The AWS X collector must run as ${worker_user}." >&2
  exit 1
fi

if [[ ! -r "${config_file}" ]]; then
  printf '%s\n' "The AWS X collector configuration is unavailable." >&2
  exit 1
fi

if ! IFS= read -r -d '' invocation_enabled ||
  ! IFS= read -r -d '' invocation_approved_account ||
  ! IFS= read -r -d '' invocation_result_url
then
  printf '%s\n' "The AWS X collector invocation is unavailable." >&2
  exit 1
fi
set -a
# This root-owned file contains paths and AWS resource identifiers only.
# Authorization values must arrive in the environment of each SSM invocation.
# shellcheck disable=SC1090
source "${config_file}"
set +a
export X_WEB_AUTOMATION_ENABLED="${invocation_enabled}"
export X_WEB_AUTOMATION_APPROVED_ACCOUNT="${invocation_approved_account}"
export X_FOR_YOU_RESULT_URL="${invocation_result_url}"
unset invocation_enabled invocation_approved_account invocation_result_url

for variable_name in DEBUG DEBUG_FILE PWDEBUG; do
  unset "${variable_name}" || true
done
while IFS= read -r variable_name; do
  if [[ "${variable_name}" != "PWD" ]]; then
    unset "${variable_name}" || true
  fi
done < <(compgen -A variable PW || true)
while IFS= read -r variable_name; do
  unset "${variable_name}" || true
done < <(compgen -A variable PLAYWRIGHT_ || true)

if (
  [[ -z "${X_FOR_YOU_REPOSITORY_DIR:-}" ]] ||
  [[ "${X_FOR_YOU_REPOSITORY_DIR}" != /* ]] ||
  [[ ! -f "${X_FOR_YOU_REPOSITORY_DIR}/package.json" ]] ||
  [[ ! -f "${X_FOR_YOU_REPOSITORY_DIR}/scripts/run-x-for-you-aws.js" ]]
); then
  printf '%s\n' "The AWS X collector repository is unavailable." >&2
  exit 1
fi

cd "${X_FOR_YOU_REPOSITORY_DIR}"
exec /usr/bin/xvfb-run \
  -a \
  --server-args="-screen 0 1280x900x24 -nolisten tcp" \
  /usr/bin/env node scripts/run-x-for-you-aws.js "$@"
