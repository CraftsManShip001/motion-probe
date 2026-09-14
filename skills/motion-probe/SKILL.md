---
name: motion-probe
description: Verify React Native animations on a simulator/emulator/device without screen recordings. Use after changing animation, transition, gesture or layout-animation code, or when asked to check that something "animates correctly", "isn't clipped", "doesn't jank", "matches the motion spec" or "didn't regress". Records what the native view layer renders per frame and returns a compact report, detected issues and pass/fail against expectations.
---

# motion-probe

motion-probe reads the **rendered** state of views (by `testID`) on every display frame —
position, transform, opacity, visible area — and summarizes it into animations (from → to,
duration, easing / spring fit, stalls, dropped frames, clipping). You never need to look at video
frames.

If the `motion-probe` MCP server is available, prefer its tools (`motion_record`, `motion_arm` +
`motion_report`, `motion_send`, `motion_baseline`, `motion_analyze`). They take the same parameters
as the CLI commands below.

## Preconditions

- The app is a development build (not Expo Go) with `@motion-probe/react-native` installed and
  `if (__DEV__) installMotionProbe()` called once.
- Every view you want to check has a `testID`. On Android, a plain `View` that only affects layout
  may be flattened away; add `collapsable={false}` if the report says "not found".
- Android emulator/device: run `adb reverse tcp:7357 tcp:7357` once.

## Workflow

1. **Put the app in the start state** (navigate there, or run the app's reset command).
2. **Record while triggering the interaction in one command.** The probe is armed before the
   interaction runs and stops by itself once motion settles:

   ```sh
   npx motion-probe record -t sheet,backdrop --send open-sheet
   ```

   `--send` runs a handler the app registered with `onMotionProbeCommand` — the most deterministic
   trigger. Look for existing handlers in the app (search for `onMotionProbeCommand`); adding one for
   the interaction under test is fine in development code. Otherwise any shell command can be the
   trigger: `--trigger "maestro test flow.yaml"`, `--trigger "adb shell input tap x y"` or a deep link
   (iOS simulators ask for confirmation on every `simctl openurl`, which blocks unattended runs).
   If you drive the UI with a separate tool (e.g. a Maestro or mobile MCP tap), split it:

   ```sh
   npx motion-probe serve &            # once (the MCP server hosts it for you)
   npx motion-probe arm -t sheet       # → {"sessionId":"ab12cd34",...}
   # ... perform the tap with your other tool, or: npx motion-probe send open-sheet
   npx motion-probe report ab12cd34
   ```

3. **Read the text report** (default). Example:

   ```
   motion-probe · ios (iPhone 17 Pro) · 1180ms (settled) · 60fps · dropped 0
   ■ toast ⚠
     translateY   60 → 30            @16.7ms  250ms  quad-out (rmse 0.004) ≈ cubic-bezier(0.25,0.46,0.45,0.94)
     visible      min 0% · final 32% · ⚠ clipped 0–1180ms (min 0%)
   issues: clipped-at-end(toast)
   ```

   - `issues:` lists problems found without any spec. Start there.
   - `JUMP`: the value changed within one frame (missing animation).
   - `⚠ froze Nms`: the value stopped updating mid-animation (JS thread blocked / JS-driven animation).
   - `⚠ dropped N frames`: the display itself skipped frames.
   - `⚠ clipped`: part of the view was cut off by an ancestor with `overflow: hidden`, a scroll viewport or the screen.
   - `⚠ covered`: another view painted above it (overlay, sibling with a higher zIndex) hides part of it.
   - `visible min · final`: the share actually visible, counting both clipping and covering.
   - `left` / `top` segments: the view moved because its parent or layout moved, not its own transform or scrolling.
   - `scrollX` / `scrollY` segments: the enclosing scroll view scrolled (with its own easing fit).

4. **Assert when there is a spec.** Write expectations and re-run with `--spec`; exit code 1 means
   at least one expectation failed and the output says why:

   ```json
   {
     "expectations": [
       { "target": "toast", "prop": "translateY", "to": 8, "durationMs": 250, "easing": "quad-out" },
       { "target": "toast", "minFinalVisibleRatio": 0.99 },
       { "target": "sheet", "prop": "translateY", "maxOvershootPct": 0, "maxStalls": 0 }
     ]
   }
   ```

   Available checks: `from`, `to`, `tolerance`, `startMs`, `durationMs`, `settleMs`,
   `maxOvershootPct`, `minOvershootPct`, `monotonic`, `easing` (name or `[x1,y1,x2,y2]`),
   `maxEasingRmse`, `maxStalls`, `maxDroppedFrames`, `minVisibleRatio`, `minFinalVisibleRatio`,
   `maxFinalOccludedRatio`, `shouldMove`, `mustBeFound`. Props also include `scrollX` / `scrollY`. Timing values accept a number (default tolerance), `{ "value": 300, "tolerance": 20 }`
   or `{ "min": 200, "max": 400 }`. List easing names with `npx motion-probe easings`.

5. **Fix and repeat** until the spec passes and `issues:` is empty (or only expected ones remain).
   Use `--format json` for exact numbers, and `--save trace.json` to re-analyze the same recording
   with `analyze` without re-running the app.

## Checking against design motion tokens

If the project has motion tokens (W3C DTCG `duration` / `cubicBezier` / `transition`, or `spring`
tokens), don't invent numbers: map views to tokens and generate the spec.

```json
{ "motions": [{ "target": "toast", "prop": "translateY", "to": 8, "transition": "motion.transition.toast", "fullyVisibleAtEnd": true }] }
```

```sh
npx motion-probe spec-from-tokens motions.json --tokens tokens.json --out motion.spec.json
npx motion-probe record --spec motion.spec.json --trigger "..."
```

Token references may be written as `motion.duration.normal` or `{motion.duration.normal}`; an
unknown reference fails with suggestions.

## Protecting a known-good animation

When an animation is confirmed correct, freeze it as a regression spec and commit it:

```sh
npx motion-probe record -t sheet --trigger "..." --write-baseline specs/sheet.spec.json
```

Later changes are checked with `record --spec specs/sheet.spec.json`. Only regenerate the baseline
when the motion change is intentional.

## Tips

- Record only the targets you care about; each adds per-frame work.
- `--idle 600` for animations with pauses between steps; `--gap` controls when two animations of
  the same property are reported separately.
- Numbers are in points (iOS) / dp (Android); times are ms since the probe was armed.
