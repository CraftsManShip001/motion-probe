# @motion-probe/core

Pure TypeScript analysis engine of [motion-probe](https://github.com/CraftsManShip001/motion-probe).
It turns a raw per-frame trace recorded by
[`@motion-probe/react-native`](https://www.npmjs.com/package/@motion-probe/react-native) into:

- animation segments per property — from → to, start, duration, nearest named easing and fitted
  cubic-bezier, spring overshoot / damping ratio / settle time
- detected issues — jumps, stalls (value frozen while frames keep coming), dropped frames, clipping,
  occlusion, targets never found
- PASS/FAIL against a spec, with the reason as a sentence
- regression baselines (`createBaselineSpec`) and specs from W3C DTCG motion tokens
  (`specFromMotionTokens`)
- compact text (`formatReport`), versioned JSON (`motion-probe/report@1`) and OpenTelemetry traces

```ts
import { summarize, formatReport } from '@motion-probe/core';

const report = summarize(trace);
console.log(formatReport(report));
```

No device or native code is needed, so saved traces can be re-analyzed at any time. Most users use it
through [`@motion-probe/cli`](https://www.npmjs.com/package/@motion-probe/cli).

## License

MIT
