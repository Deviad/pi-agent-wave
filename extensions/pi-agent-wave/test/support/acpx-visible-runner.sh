#!/usr/bin/env bash
set -uo pipefail

if [[ $# -lt 5 || $4 != "--" ]]; then
	printf 'usage: acpx-visible-runner.sh <executable> <stdout-path> <stderr-path> -- <args...>\n' >&2
	exit 64
fi

executable=$1
stdout_path=$2
stderr_path=$3
shift 4

"$executable" "$@" > >(tee "$stdout_path") 2> >(tee "$stderr_path" >&2)
exit_code=$?
wait
exit "$exit_code"
