# @motion-probe/cli

Command line and local daemon of [motion-probe](https://github.com/CraftsManShip001/motion-probe):
verify React Native animations from what the UI layer actually renders, without screen recordings.
The app side is [`@motion-probe/react-native`](https://www.npmjs.com/package/@motion-probe/react-native).

```sh
# arm the probe, perform the interaction, wait until motion settles, check the spec
npx motion-probe record -t toast --send show-toast --spec toast.spec.json
```

```
motion-probe · ios (iPhone 17 Pro) · 700ms (settled) · 60fps · dropped 0
■ toast ⚠
  translateY   60 → 30            @16.7ms  266.7ms  ease-out (rmse 0.034)
  visible      min 0% · final 68% · ⚠ clipped
issues: clipped-at-end(toast)

FAIL 0/1 expectations
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
