# Changelog

All `@motion-probe/*` packages share one version.

## 0.1.4

Found with a fourth fresh app (Expo SDK 57 / RN 0.86: React Navigation's JS stack, a card swiped
away with react-native-gesture-handler + Reanimated, a press-and-hold scale, expo-image with a
`transition`) on iOS and Android, with real touches on Android.

- **Touch-aware segments.** The probe now records when fingers are down (`touches` in the raw trace)
  and the analyzer splits motion where a finger goes down or lifts. Motion while a finger drags is
  marked `follows touch (drag)` (no curve fitted, no jump/stall warnings), and what happens after the
  finger lifts is its own segment with its own curve: a swiped card read as one 0 → 500 "ease-out"
  mixing the drag and the release; it now reads as a drag to ~280 and a 250ms release animation. A
  press-and-hold no longer merges the press and release animations into one "returns to start"
  segment when the hold is shorter than the 300ms gap. Spec expectations compare animations, not drags.

- **Fades of an ancestor are reported.** A screen or card fading in (React Navigation's Android card
  transition fades the whole card) only showed up in `effective opacity`; it is now an
  `inheritedOpacity` segment with its own curve, separate from the view's own `opacity`.
- **Fades inside a view are reported.** Image libraries fade the image, not the view you tag: expo-image
  animates a child ImageView's alpha on Android and runs a cross-dissolve transition on iOS, so an image
  with `transition={300}` read `(no motion)`. The new `contentOpacity` column records what a view draws
  inside itself (images, text and backgrounds of its descendants, blended through cross-dissolves), so
  the fade reads `contentOpacity 0 → 1 … 300ms`. A content JUMP (an image appearing without a
  transition) is info, not a warning.
- **No phantom jump when a recycled view mounts (iOS).** Fabric reuses native views; a reused view kept
  its previous frame in the presentation layer until it was first rendered, so a freshly mounted view
  was reported as `JUMP` from its old size and position (e.g. from a full-screen container to 96×96).
- **Transparent React Native backgrounds no longer count as opaque (Android).** RN keeps a view's
  background, borders and radii in one layer drawable that reports full alpha even without a background
  color, so a view with only a `borderRadius` counted as painted content (and as a cover for occlusion).
  The background color is now read from React Native itself.

## 0.1.3

Found with a third fresh app: a bare React Native app (no Expo template, no Reanimated) using
`Animated.stagger` / `Animated.loop`, `LayoutAnimation`, FlatList scrolling, `KeyboardAvoidingView` and
the core `<Modal>`, on iOS and Android.

- **A view's own children no longer count as covering it.** Fabric can mount a view's children as
  later siblings of it (view flattening), so the text field inside a composer, or the label of a list
  row, was reported as covering it (`occluded-at-end`, "covered 67%"). Views lying entirely inside the
  target are now treated as its content; overlays that reach past it are still covers.
- **Looping animations are reported as loops.** A sustained oscillation (an `Animated.loop` pulse, a
  breathing or shimmer effect) reads `loop 0.4 ↔ 1 · period 833ms · 3 cycles` instead of a spring with
  a negative damping ratio.
- Docs: installing into bare React Native apps (Expo Modules through `install-expo-modules`, and the
  React Native versions it currently supports).

Known limitation: Android window animations (the core `<Modal>`'s slide, activity transitions) run in
the system compositor and are invisible to an in-app probe; the content's layout is still recorded.
Observed along the way (React Native, not motion-probe): `LayoutAnimation` animated on iOS but jumped
on Android in a bare RN 0.85 New Architecture app.

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
- **A view removed during the recording has no end state to judge.** An exiting list item that fades
  out while the next item slides over it used to get `clipped-at-end` / `occluded-at-end` from its last
  frame; it now reports the info `unmounted`, and baselines skip its final visibility.

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
