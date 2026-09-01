#!/usr/bin/env bash

set -Eeuo pipefail
set +x
umask 077

repository_directory="/opt/signal-foundry"
runtime_directory="/var/lib/signal-foundry/x-for-you"
worker_user="signal-foundry-x"
secret_id=""
aws_region=""
post_limit="100"

usage() {
  printf '%s\n' \
    "Usage: sudo ./scripts/setup-x-for-you-aws.sh --secret-id ID --region REGION [--repository /opt/signal-foundry] [--runtime PATH] [--post-limit N]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository)
      repository_directory="${2:-}"
      shift 2
      ;;
    --runtime)
      runtime_directory="${2:-}"
      shift 2
      ;;
    --secret-id)
      secret_id="${2:-}"
      shift 2
      ;;
    --region)
      aws_region="${2:-}"
      shift 2
      ;;
    --post-limit)
      post_limit="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]] || [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' "The AWS X collector setup must run as root on Linux." >&2
  exit 1
fi

if (
  [[ "${repository_directory}" != /* ]] ||
  [[ "${runtime_directory}" != /* ]] ||
  [[ ! -f "${repository_directory}/package.json" ]] ||
  [[ ! -f "${repository_directory}/deploy/aws/x-for-you/run.sh" ]] ||
  [[ ! -f "${repository_directory}/deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.service" ]] ||
  [[ ! -f "${repository_directory}/deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.timer" ]] ||
  [[ -z "${secret_id}" ]] ||
  [[ ! "${secret_id}" =~ ^[A-Za-z0-9/_+=.@:-]{1,2048}$ ]] ||
  [[ ! "${aws_region}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] ||
  [[ ! "${post_limit}" =~ ^[1-9][0-9]*$ ]] ||
  (( post_limit > 100 ))
); then
  printf '%s\n' "The AWS X collector setup arguments are invalid." >&2
  exit 1
fi

for required_command in aws google-chrome node npm realpath runuser xvfb-run; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    printf '%s\n' "Missing required command: ${required_command}" >&2
    exit 1
  fi
done

repository_directory="$(realpath -e -- "${repository_directory}")"
runtime_directory="$(realpath -m -- "${runtime_directory}")"

if (
  [[ "${repository_directory}" != /opt/signal-foundry ]] ||
  [[ "${runtime_directory}" != /var/lib/signal-foundry/* ]] ||
  [[ "${runtime_directory}/" == "${repository_directory}/"* ]]
); then
  printf '%s\n' "The AWS X collector runtime path is unsafe." >&2
  exit 1
fi

if ! id "${worker_user}" >/dev/null 2>&1; then
  /usr/sbin/useradd \
    --system \
    --home-dir "/var/lib/${worker_user}" \
    --create-home \
    --shell /usr/sbin/nologin \
    "${worker_user}"
fi

worker_group="$(id -gn "${worker_user}")"
/usr/bin/chown -R root:"${worker_group}" "${repository_directory}"
/usr/bin/chmod -R u=rwX,g=rX,o= "${repository_directory}"
/usr/bin/install -d -m 0750 -o root -g "${worker_group}" /etc/signal-foundry
/usr/bin/install -d -m 0700 -o "${worker_user}" -g "${worker_group}" \
  "${runtime_directory}"
/usr/bin/install -m 0755 -o root -g root \
  "${repository_directory}/deploy/aws/x-for-you/run.sh" \
  /usr/local/bin/signal-foundry-x-for-you
/usr/bin/install -m 0644 -o root -g root \
  "${repository_directory}/deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.service" \
  /etc/systemd/system/signal-foundry-x-for-you-auto-stop.service
/usr/bin/install -m 0644 -o root -g root \
  "${repository_directory}/deploy/aws/x-for-you/signal-foundry-x-for-you-auto-stop.timer" \
  /etc/systemd/system/signal-foundry-x-for-you-auto-stop.timer
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable --now signal-foundry-x-for-you-auto-stop.timer

if ! /usr/sbin/runuser -u "${worker_user}" -- \
  /usr/bin/test -r "${repository_directory}/package.json"; then
  printf '%s\n' "The AWS X collector repository is not readable by the worker." >&2
  exit 1
fi

config_temporary="$(mktemp /etc/signal-foundry/.x-for-you.env.XXXXXX)"
trap 'rm -f -- "${config_temporary}"' EXIT
{
  printf 'AWS_REGION=%q\n' "${aws_region}"
  printf 'X_FOR_YOU_REPOSITORY_DIR=%q\n' "${repository_directory}"
  printf 'X_FOR_YOU_AWS_SECRET_ID=%q\n' "${secret_id}"
  printf 'X_WEB_AUTOMATION_POST_LIMIT=%q\n' "${post_limit}"
  printf 'X_WEB_AUTOMATION_RUNTIME_DIR=%q\n' "${runtime_directory}"
  printf 'X_WEB_AUTOMATION_MAX_SCROLLS=60\n'
  printf 'X_WEB_AUTOMATION_MAX_NO_GROWTH_CYCLES=5\n'
  printf 'X_WEB_AUTOMATION_MAX_RUNTIME_MS=300000\n'
  printf 'X_WEB_AUTOMATION_LOAD_WAIT_MS=2500\n'
  printf 'X_WEB_AUTOMATION_STATE_TIMEOUT_MS=20000\n'
  printf 'X_WEB_AUTOMATION_INCLUDE_RAW_TEXT=false\n'
  printf 'X_WEB_AUTOMATION_SAVE_FAILURE_SCREENSHOT=true\n'
} > "${config_temporary}"
/usr/bin/chown root:"${worker_group}" "${config_temporary}"
/usr/bin/chmod 0640 "${config_temporary}"
/usr/bin/mv -f -- "${config_temporary}" /etc/signal-foundry/x-for-you.env
trap - EXIT

printf '%s\n' "X_FOR_YOU_AWS_RUNTIME_READY"
printf '%s\n' "Authorization values must be supplied by each SSM invocation."
