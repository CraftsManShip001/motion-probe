# @motion-probe/cli

Command line and local daemon of [motion-probe](https://github.com/CraftsManShip001/motion-probe):
verify React Native animations from what the UI layer actually renders, without screen recordings.
The app side is [`@motion-probe/react-native`](https://www.npmjs.com/package/@motion-probe/react-native).

```sh
# arm the probe, perform the interaction, wait until motion settles, check the spec
npx motion-probe record --spec specs/clipped-toast.spec.json --send run/clipped-toast
```

```
motion-probe · ios (iPhone 17 Pro) · 682.4ms (settled) · 60fps · dropped 0
■ toast ⚠
  translateY   60 → 30            @16.8ms  249ms  quad-out (rmse 0.001) ≈ cubic-bezier(0.15,0.3,0.525,1)
  visible      min 8% · final 68% · ⚠ clipped 0–682.4ms (min 0%)
issues: clipped-at-end(toast)

FAIL 0/2 expectations
  ✗ toast.translateY: translateY ended at 30, expected 8±2
  ✗ toast: "toast" ends 68% visible (expected ≥ 99%): 32% clipped
```

## Commands

| Command | |
|---|---|
| `record -t <testIDs> [--send <command> \| --trigger "<shell>"] [--spec s.json]` | arm → interaction → settle → report (exit 1 when an expectation fails) |
| `arm -t <testIDs>` / `report <sessionId>` | when another tool performs the interaction |
| `send <command>` | run a handler the app registered with `onMotionProbeCommand` |
| `analyze <trace.json>` | re-analyze a saved recording (`--save`) |
| `baseline <trace.json>` / `record --write-baseline` | freeze a known-good animation as a regression spec |
| `spec-from-tokens <motions.json> --tokens tokens.json` | build a spec from W3C DTCG motion tokens |
| `serve`, `status`, `easings` | daemon, connected apps, easing names |

Output formats: compact text for agents (default), versioned JSON (`--format json`) and
OpenTelemetry traces (`--format otlp`, `--otlp-endpoint`).

The package also exports a library API (`startDaemon`, `DaemonClient`, `recordMotion`, `analyzeTrace`).

## License

MIT
