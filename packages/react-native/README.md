# @motion-probe/react-native

The in-app half of [motion-probe](https://github.com/CraftsManShip001/motion-probe): an Expo Module that
records what the native view layer **actually renders** on every display frame — position, transform,
opacity, clipping, occlusion, scrolling — for the views you name by `testID`
(iOS: `CADisplayLink` + presentation layer, Android: `Choreographer` + view matrix).

It works regardless of what drives the animation (Animated with or without the native driver,
Reanimated, layout transitions, scroll views), and it never needs a screen recording.

## Install (development builds)

```sh
npx expo install @motion-probe/react-native
```

```ts
import { installMotionProbe } from '@motion-probe/react-native';

if (__DEV__) installMotionProbe();
```

Bare React Native apps need Expo Modules first (`npx install-expo-modules@latest`, then
`npm install @motion-probe/react-native` and `pod install`). The installer only handles React Native
versions of the Expo SDKs it knows: as of September 2026, `install-expo-modules@latest` (0.16.0) stops
at SDK 56 (RN 0.85), so RN 0.86 / 0.87 bare apps fail with "Unable to find compatible Expo SDK
version" (and "Unsupported sdkVersion" with `--sdk-version 57.0.0`), while the `next` and `canary`
tags fail to resolve the project. Follow Expo's manual setup (`use_expo_modules!` in the Podfile,
AppDelegate / MainApplication wiring) or start from a React Native version the installer supports.
With npm 11, `allow-scripts` warnings can make `install-expo-modules` end with a "package manager
error" even though Expo was installed — check `node_modules/expo` before retrying.

Rebuild the app once (native code; Expo Go is not supported). The app dials the local
`motion-probe` daemon at `ws://<metro host>:7357/app`; on an Android emulator run
`adb reverse tcp:7357 tcp:7357`.

## Deterministic triggers (optional)

Register handlers that scripts and agents can call with `motion-probe send <name>` or
`motion-probe record --send <name>` — no deep links (iOS simulators confirm every `openurl`) and no
UI automation:

```ts
import { onMotionProbeCommand } from '@motion-probe/react-native';

useEffect(
  () =>
    onMotionProbeCommand((name) => {
      if (name !== 'open-sheet') return false; // not mine
      setSheetOpen(true);
    }),
  [],
);
```

Then record and verify with [`@motion-probe/cli`](https://www.npmjs.com/package/@motion-probe/cli) or
the [`@motion-probe/mcp`](https://www.npmjs.com/package/@motion-probe/mcp) server.

## License

MIT
