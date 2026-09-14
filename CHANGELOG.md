# Changelog

All `@motion-probe/*` packages share one version.

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
