#!/usr/bin/env bash
# Records every demo scenario on the booted iOS simulator and checks it against its spec.
# The "Bug" scenarios (clipped-toast, js-jank, covered-badge) are expected to FAIL.
#
# Prerequisites: demo app running on a booted simulator, `npm run build` at the repo root.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="node $ROOT/packages/cli/dist/cli.js"
SPECS="$ROOT/examples/demo/specs"
SCHEME="motionprobe-demo"
DEVICE="${DEVICE:-booted}"
SCENARIOS=("${@:-timing spring native-driver clipped-toast js-jank covered-badge scroll layout}")

for scenario in ${SCENARIOS[@]}; do
  echo "=== $scenario"
  xcrun simctl openurl "$DEVICE" "$SCHEME://reset/$scenario"
  $CLI record --spec "$SPECS/$scenario.spec.json" \
    --trigger "xcrun simctl openurl $DEVICE $SCHEME://run/$scenario" \
    --timeout 8000 --idle 400
  echo "exit=$?"
  echo
done
