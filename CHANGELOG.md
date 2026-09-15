# Changelog

All `@motion-probe/*` packages share one version.

## 0.1.2

Found with a second fresh app (expo-router native stack, Reanimated 4 `entering` / `exiting` / layout
transitions, a `withRepeat` spinner, springs, a percentage-width progress bar) on iOS and Android.

- **Views that mount during a recording are recorded from their first frame.** Targets that are not on
  screen are looked up every frame instead of every 6th, so a modal or the next screen of a stack is no
  longer picked up up to 100ms late (a pushed screen used to be recorded from the middle of its slide).
- **The probe samples once at arm time**, so an interaction that starts before the next display frame
  keeps its start value (an Android progress bar used to start at 6.48 instead of 0).
- **Android native-stack / fragment transitions are visible.** Legacy view animations
  (`android.view.animation`) transform a view at draw time without touching its properties; the probe
  now applies them, including their alpha, and treats a view whose animation is scheduled but not
  drawn yet as not on screen. A pushed screen now reads `left 61 → 20 · 450ms` instead of "no motion".
- **Rotation is unwrapped across turns.** An infinite spinner reads as one linear rotation
  (`0 → 1125` · never-settled) instead of a jump every turn or a bogus spring.
- **Springs report their equivalent stiffness and damping at mass 1**, which makes config mismatches
  obvious: a Reanimated 4 `withSpring(…, { damping: 14, stiffness: 180 })` without `mass` measured
  `≈ stiffness 45 damping 3.5 @ mass 1`, i.e. it ran with mass 4.
- Single-frame intervals print as `@t (1 frame)`.

Known limitation: a fade inherited from an ancestor (a screen fading in) only shows in the final
effective opacity, not as an `opacity` segment.

## 0.1.1

Found by installing 0.1.0 from npm into a fresh Expo app (bottom sheet + backdrop, spring like
button, toast, accordion) and verifying it on iOS and Android.

- **No more false issues on intended endings.** `clipped-at-end` fires only when a view comes to rest
  *partly* visible; a view dismissed entirely off screen reports the new info `offscreen-at-end`.
  `occluded-at-end` fires only when the view moved itself into the covered spot; a view that was
  covered by something sliding over it (a backdrop under a sheet) reports the new info `covered-at-end`.
- **Less noise in the text report.** `⚠` marks a target only when it has a warning; clipping while
  sliding in is listed without `⚠`. Zero-size frames (an accordion before it opens) no longer count as
  clipped. "on screen" is only shown when a view mounted or unmounted during the recording. A view that
  ends at opacity 0 reads `final transparent` instead of a visible share.
- **Baselines guard frame drops.** `baseline` / `--write-baseline` / `motion_baseline` now add
  `maxDroppedFrames` to every animation, so a regression that janks an animation fails the spec.
- The MCP server reports its real package version.

## 0.1.0

First public release: native per-frame probe (iOS / Android), analyzer, spec assertions, baselines,
design-token specs, OTLP export, CLI + daemon, MCP server, Agent Skill, and the app command channel
(`motion-probe send` / `onMotionProbeCommand`).
