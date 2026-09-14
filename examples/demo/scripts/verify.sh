#!/usr/bin/env bash
# Records every demo scenario and checks it against its spec, on iOS or Android. Scenarios are
# triggered through the app's `onMotionProbeCommand` handler (`motion-probe send`), so no deep links
# (iOS asks for confirmation on every simulator `openurl`), taps or device ids are involved.
# The "Bug" scenarios (clipped-toast, js-jank, covered-badge) are expected to FAIL; the script exits
# non-zero when any scenario does not end the way it is expected to.
#
# Prerequisites: demo app running (Android emulator: `adb reverse tcp:7357 tcp:7357`),
# `npm run build` at the repo root. With both an iOS and an Android app connected, pick one with
# PLATFORM=ios or PLATFORM=android.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="${PLATFORM:+--app=$PLATFORM}"
CLI=(node "$ROOT/packages/cli/dist/cli.js")
SPECS="$ROOT/examples/demo/specs"
EXPECTED_FAIL=" clipped-toast js-jank covered-badge "
if [ $# -gt 0 ]; then
  SCENARIOS=("$@")
else
  SCENARIOS=(timing spring native-driver clipped-toast js-jank covered-badge scroll layout)
fi

# One daemon for the whole run (a daemon that is already running keeps being used).
"${CLI[@]}" serve >/dev/null 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null' EXIT
for _ in $(seq 50); do
  "${CLI[@]}" status >/dev/null 2>&1 && break
  sleep 0.1
done

summary=""
unexpected=0
for scenario in "${SCENARIOS[@]}"; do
  echo "=== $scenario"
  # $APP is intentionally unquoted: it is empty or a single --app=<platform> word.
  if "${CLI[@]}" send "reset/$scenario" $APP; then
    sleep 0.3 # let the reset render before arming
    "${CLI[@]}" record $APP --spec "$SPECS/$scenario.spec.json" \
      --send "run/$scenario" \
      --timeout 8000 --idle 400
    code=$?
  else
    code=2
  fi
  expected=0
  [[ "$EXPECTED_FAIL" == *" $scenario "* ]] && expected=1
  verdict="ok"
  if [ "$code" -ne "$expected" ]; then
    verdict="UNEXPECTED"
    unexpected=$((unexpected + 1))
  fi
  summary+="$(printf '%-14s exit=%s expected=%s %s' "$scenario" "$code" "$expected" "$verdict")"$'\n'
  echo
done

echo "=== summary"
printf '%s' "$summary"
[ "$unexpected" -eq 0 ]
