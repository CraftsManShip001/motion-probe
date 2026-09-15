# motion-probe

**녹화 없이, 에이전트가 React Native 애니메이션을 수치로 검증하는 도구.**

화면 녹화를 프레임 이미지로 읽는 대신, 네이티브 뷰 레이어가 **실제로 렌더링하는 상태**(위치·transform·opacity·보이는 면적)를 매 디스플레이 프레임마다 기록합니다. 그 결과를 "무엇이 어디서 어디로, 몇 ms 동안, 어떤 곡선으로, 끊김·잘림 없이 움직였나"로 요약해서 텍스트 몇 줄 / JSON / OpenTelemetry로 돌려줍니다.

```
$ npx motion-probe record --spec examples/demo/specs/clipped-toast.spec.json --send run/clipped-toast

motion-probe · ios (iPhone 17 Pro) · 682.4ms (settled) · 60fps · dropped 0
■ toast ⚠
  translateY   60 → 30            @16.8ms  249ms  quad-out (rmse 0.001) ≈ cubic-bezier(0.15,0.3,0.525,1)
  visible      min 8% · final 68% · ⚠ clipped 0–682.4ms (min 0%)
issues: clipped-at-end(toast)

FAIL 0/2 expectations
  ✗ toast.translateY: translateY ended at 30, expected 8±2
  ✗ toast: "toast" ends 68% visible (expected ≥ 99%): 32% clipped
```

<sub>iPhone 17 Pro 시뮬레이터(iOS 26.5)에서 데모 앱의 clipped-toast 시나리오를 실제로 기록한 출력입니다. Android 에뮬레이터(API 35)에서도 같은 결과(최종 68% 표시, 32% 잘림)가 나옵니다.</sub>

> 값(`translateY 60 → 30`)만 보면 정상이지만, 부모의 `overflow: hidden` 때문에 토스트가 **32% 잘린 채로 끝난다**는 사실까지 드러납니다. JS 값 추적(Reanimated/Animated 훅)으로는 원리상 보이지 않는 버그입니다.

## 왜 만들었나

| | 녹화 + LLM 판독 | JS 값 훅 | **motion-probe (네이티브 뷰 프로브)** |
|---|---|---|---|
| 에이전트 비용 | 이미지 수십 장 | 텍스트 | **텍스트 몇 줄** |
| duration·easing·spring 수치 | 추정 | ✅ | ✅ |
| 네이티브 드라이버·LayoutAnimation | ✅ | ❌ | ✅ |
| 부모 이동·잘림(clip) | 눈으로 | ❌ | ✅ |
| 다른 뷰에 가려짐, 스크롤과 레이아웃 이동 구분 | 눈으로 | ❌ | ✅ |
| 디자인 모션 토큰 대비 검증 | ❌ | ❌ | ✅ `spec-from-tokens` |
| "값이 멈춤"과 "프레임 드롭" 구분 | 어려움 | ❌ | ✅ |
| 명세 대비 pass/fail, 회귀 테스트 | ❌ | 직접 구현 | ✅ `--spec`, `baseline` |
| 라이브러리/번들러 의존 | 없음 | 높음 | **없음** |

자세한 설계 근거와 선행 사례 비교는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 구성

```
packages/
  core/          # 순수 TS: RawTrace → MotionReport 분석, 이슈 진단, 스펙 판정, 베이스라인, 텍스트/OTLP
  cli/           # motion-probe CLI + 로컬 데몬 (HTTP ↔ 앱 WebSocket) + 라이브러리 API
  mcp/           # MCP 서버: 에이전트가 도구 호출로 녹화·판정
  react-native/  # Expo Module: iOS(CADisplayLink + presentationLayer), Android(Choreographer)
examples/demo/   # 시나리오 8개 Expo 앱 + 시나리오별 spec + 모션 토큰 예제 + verify.sh
skills/motion-probe/SKILL.md   # 에이전트용 사용 가이드
.github/workflows/ci.yml       # 단위/통합 테스트 + iOS/Android 네이티브 컴파일 검증
```

## 빠른 시작

### 1. 앱에 설치 (dev 빌드)

```sh
npx expo install @motion-probe/react-native
```

```ts
// index.ts 또는 App.tsx 최상단
import { installMotionProbe } from '@motion-probe/react-native';
if (__DEV__) installMotionProbe();
```

선택: 스크립트나 에이전트가 `motion-probe send open-sheet`로 부를 수 있는 테스트 훅을 등록해 두면, 딥링크나 UI 자동화 없이 인터랙션을 결정적으로 일으킬 수 있습니다.

```ts
import { onMotionProbeCommand } from '@motion-probe/react-native';

useEffect(
  () =>
    onMotionProbeCommand((name) => {
      if (name !== 'open-sheet') return false; // 모르는 명령
      setSheetOpen(true);
    }),
  [],
);
```

검증할 뷰에 `testID`만 있으면 됩니다. 네이티브 코드가 들어가므로 앱을 한 번 다시 빌드해야 하고, Expo Go에서는 동작하지 않습니다. iOS 모듈은 Debug 구성에만 등록됩니다(`debugOnly`).

Expo를 쓰지 않는 bare React Native 앱은 Expo Modules가 먼저 필요합니다(`npx install-expo-modules@latest` 후 `npm install @motion-probe/react-native`, `pod install`). `install-expo-modules`는 자신이 아는 Expo SDK의 RN 버전에서만 동작합니다. 2026-09 기준 `latest`(0.16.0)는 SDK 56(RN 0.85)까지만 알아서, RN 0.86·0.87로 만든 bare 앱에서는 "Unable to find compatible Expo SDK version"(`--sdk-version 57.0.0`을 줘도 "Unsupported sdkVersion")으로 실패하고, `next`·`canary` 태그는 프로젝트 경로를 찾지 못하는 오류로 실패합니다. 이 경우 Expo 문서의 수동 설치(Podfile의 `use_expo_modules!`, AppDelegate·MainApplication 연결)를 따르거나, 도구가 지원하는 RN 버전으로 시작하세요. npm 11의 `allow-scripts` 경고 때문에 `install-expo-modules`가 "package manager error"로 끝나도 실제로는 설치된 경우가 있으니 `node_modules/expo`를 확인하세요.

### 2. 녹화 + 트리거 + 판정

```sh
# 앱이 등록한 명령으로 조작 (딥링크 확인창·UI 자동화가 필요 없어 가장 결정적)
npx motion-probe record -t sheet,backdrop --send open-sheet --spec sheet.spec.json
# 인터랙션을 일으키는 셸 명령도 무엇이든 됩니다: maestro, adb input, deep link ...
npx motion-probe record -t sheet,backdrop --trigger "maestro test open-sheet.yaml" --spec sheet.spec.json
```

```json
{
  "expectations": [
    { "target": "sheet", "prop": "translateY", "to": 0, "durationMs": 300, "easing": "cubic-out", "maxOvershootPct": 0 },
    { "target": "sheet", "minFinalVisibleRatio": 0.99, "maxDroppedFrames": 2 }
  ]
}
```

실패하면 exit code 1과 함께 이유를 문장으로 돌려줍니다.

```
FAIL 1/2 expectations
  ✓ toast.translateY
  ✗ toast: "toast" ends 68% visible (expected ≥ 99%)
```

### 3. 모션 회귀 테스트 (베이스라인)

잘 동작하는 상태를 한 번 녹화해서 스펙으로 굳혀 두면, 이후 duration·곡선·overshoot·멈춤·최종 가시성이 달라졌을 때 실패합니다.

```sh
npx motion-probe record -t sheet --trigger "..." --write-baseline specs/sheet.spec.json   # 기준 만들기
npx motion-probe record --spec specs/sheet.spec.json --trigger "..."                      # 이후 매번 검증
npx motion-probe baseline trace.json --out sheet.spec.json --tolerance 10                  # 저장된 trace로도 가능
```

### 4. 디자인 모션 토큰으로 스펙 만들기

디자인 시스템의 모션 토큰을 그대로 기준으로 삼을 수 있습니다. W3C Design Tokens(DTCG) 형식의 `duration`, `cubicBezier`, `transition`과 `spring` 토큰을 읽습니다. 어떤 뷰가 어떤 토큰을 따라야 하는지만 적으면 스펙이 만들어집니다.

`motion/motions.json`:

```json
{
  "motions": [
    { "target": "toast", "prop": "translateY", "to": 8, "transition": "motion.transition.toast", "fullyVisibleAtEnd": true },
    { "target": "badge", "prop": "scaleX", "to": 1.3, "spring": "motion.spring.playful" }
  ]
}
```

```sh
npx motion-probe spec-from-tokens motion/motions.json --tokens motion/tokens.json --out specs/motion.spec.json
npx motion-probe record --spec specs/motion.spec.json --trigger "..."
```

- duration은 기본 ±10%(최소 2프레임) 허용 범위로 검사하고, 곡선은 토큰의 cubic-bezier와 비교합니다.
- spring은 `damping/stiffness/mass`(Reanimated 설정)나 `dampingRatio`로부터 overshoot 범위와 settle 시간을 계산합니다.
- 기본으로 애니메이션 중 멈춤(stall)이 0회여야 합니다. `"smooth": false`로 끌 수 있습니다.
- 토큰 경로를 잘못 쓰면 비슷한 토큰 이름을 제안합니다. 예제는 [examples/demo/motion](examples/demo/motion)에 있습니다.

### 5. 에이전트에서 쓰기

**MCP** (Claude Code, Cursor 등):

```json
{
  "mcpServers": {
    "motion-probe": { "command": "npx", "args": ["-y", "-p", "@motion-probe/mcp", "motion-probe-mcp"] }
  }
}
```

| 도구 | 용도 |
|---|---|
| `motion_record` | arm → command/trigger 실행 → settle 대기 → 리포트(+ spec 판정) |
| `motion_arm` / `motion_report` | 조작을 다른 MCP(Maestro, mobile-mcp 등)로 할 때 |
| `motion_send` | 앱이 `onMotionProbeCommand`로 등록한 명령 실행 |
| `motion_baseline` | 방금 녹화한 세션으로 회귀 스펙 생성 |
| `motion_spec_from_tokens` | 디자인 모션 토큰으로 스펙 생성 |
| `motion_analyze` | 저장된 trace 재분석 |
| `motion_status`, `motion_easings` | 연결 상태, 이징 이름 목록 |

MCP 서버가 살아 있는 동안 데몬도 함께 떠 있어서, 앱 연결이 도구 호출 사이에 끊기지 않습니다.

**CLI + Skill**: [skills/motion-probe/SKILL.md](skills/motion-probe/SKILL.md)를 에이전트 스킬로 등록하면 CLI만으로 같은 흐름을 따릅니다.

### 6. 조작을 다른 도구로 할 때 (CLI)

```sh
npx motion-probe serve &
npx motion-probe arm -t sheet        # {"sessionId":"ab12cd34",...}
# ...Maestro / agent-device / mobile-mcp 등으로 탭, 또는 앱 명령 실행:
npx motion-probe send open-sheet
npx motion-probe report ab12cd34 --format json
```

## 리포트가 알려주는 것

| 표시 | 의미 |
|---|---|
| `translateY 0 → -120 @12ms 300ms cubic-out ≈ cubic-bezier(...)` | 구간, 시작 시점, 길이, 최근접 이징 + 피팅된 베지어 |
| `spring overshoot 37% · crossings 3 · ζ≈0.3 · settle 820ms` | 스프링 특성(감쇠비 추정 포함) |
| `JUMP` | 1프레임 안에 값이 바뀜 (애니메이션 누락) |
| `follows touch (drag)` | 손가락으로 끄는 동안 따라 움직인 구간 (곡선 피팅·JUMP·멈춤 경고 없음). 손을 뗀 뒤의 release/fling 애니메이션은 별도 구간으로 곡선까지 분석 |
| `⚠ froze 250ms` | 프레임은 나오는데 **값이 멈춤** (JS 스레드 막힘). 스프링 꼭짓점은 제외 |
| `⚠ dropped N frames` | 디스플레이 프레임 자체가 빠짐 |
| `clipped` | 조상 clip·스크롤 뷰포트·화면 경계에 잘린 구간. **일부만 보인 채 끝났을 때만** `⚠`와 `clipped-at-end` (슬라이드 인 중 잘림, 화면 밖으로 닫힘은 정상) |
| `covered` | 위에 그려진 다른 뷰(오버레이, zIndex가 높은 형제)에 가려진 구간. **스스로 움직여 가려진 자리에 멈췄을 때만** `⚠`와 `occluded-at-end` (시트 아래 backdrop은 정상) |
| `visible min·final` | 잘림과 가림을 모두 반영한, 실제로 보이는 비율 |
| `left` / `top` | 자기 transform이나 스크롤이 아니라 부모·레이아웃 때문에 이동 |
| `scrollX` / `scrollY` | 감싸는 스크롤 뷰의 스크롤 (scrollTo 애니메이션 곡선까지) |
| `inheritedOpacity` | 조상(화면·카드)이 페이드됨. 뷰 자신의 페이드는 `opacity` |
| `contentOpacity` | 뷰 안에 그려지는 내용(이미지·텍스트·자식 배경)이 페이드됨: expo-image `transition` 등 이미지 페이드 인 (iOS cross-dissolve 포함). 트랜지션 없이 이미지가 튀어나온 JUMP는 info로만 표시 |
| `issues: ...` | 스펙이 없어도 자동으로 잡은 문제 (`target-not-found`, `jump`, `stall`, `dropped-frames`, `clipped-at-end`, `occluded-at-end`, `never-settled` …) |

- `--format json`: 버전이 붙은 스키마(`motion-probe/report@1`)
- `--format otlp`: OpenTelemetry 트레이스(녹화 → 대상 → 애니메이션 span)
- `--otlp-endpoint http://collector:4318`: 기존 UX 계측 파이프라인에 바로 전송

## 개발

```sh
npm install
npm run build        # core, cli, mcp
npm run typecheck
npm test             # 분석기 단위 테스트 + 데몬/프로토콜 통합 테스트 (기기 불필요)

# 데모 앱 (iOS 시뮬레이터 또는 Android 에뮬레이터 — Android는 adb reverse tcp:7357 tcp:7357)
cd examples/demo && npx expo run:ios      # 또는 npx expo run:android
./scripts/verify.sh   # 시나리오 8개 녹화·판정. 버그 시나리오 3개는 FAIL이 정상이고, 기대와 다르면 exit 1
```

데모 명령: `motion-probe send run/<timing|spring|native-driver|clipped-toast|js-jank|covered-badge|scroll|layout|all>`, `reset/<...>`. 같은 이름의 deep link(`motionprobe-demo://run/...`)도 동작하지만, iOS 시뮬레이터는 `simctl openurl`마다 확인창을 띄워 자동화에는 맞지 않습니다.

iOS 빌드 주의: 프로젝트 경로에 공백이 있으면 Expo SDK 57의 iOS 빌드 스크립트(expo-constants 스크립트, 번들 단계)가 경로를 잘라 실패하니 공백 없는 경로에서 빌드하세요. 셸에 `LANG`이 비어 있으면 CocoaPods가 `Encoding::CompatibilityError`로 멈추므로 `LANG=en_US.UTF-8`을 지정합니다.

## 상태

프로토타입(v0.1)입니다.

- ✅ core 분석기 / 이슈 진단 / 스펙 판정 / 베이스라인 / 가림·스크롤 분석 / 디자인 토큰 → 스펙 / OTLP: 단위 테스트
- ✅ CLI + 데몬 프로토콜: 가짜 앱 통합 테스트 (녹화, 앱 명령, 트리거 실패 시 취소, 앱 끊김, 미연결 안내)
- ✅ 앱 쪽 JS 레코더: 가짜 네이티브 모듈로 settle / timeout / 마운트 감지 / 취소 / 최대 길이 테스트
- ✅ MCP 서버: SDK 클라이언트로 도구 목록·analyze·baseline·status 호출 확인
- ✅ iOS·Android 네이티브 컴파일: CI `ios-native` / `android-native` 잡 (Expo SDK 57 / RN 0.86)
- ✅ 실동작: iPhone 17 Pro 시뮬레이터(iOS 26.5)와 Android 에뮬레이터(API 35)에서 데모 시나리오 8개를 `verify.sh`로 자동 검증 — 정상 시나리오 5개 PASS, 버그 시나리오 3개는 의도한 이유(잘림·JS 멈춤·가림)로 FAIL
- ⚠️ 실물 기기, 실제 에이전트 클라이언트(Claude Code 등)에서의 MCP 연동: 아직 검증 전
- ⚠️ 약 20회 실행 중 2회, 부하가 걸린 상황에서 js-jank의 값 멈춤을 놓친 적이 있습니다(재현되지 않음, `SAVE_DIR`로 원시 기록 수집 가능)

한계와 로드맵은 [docs/DESIGN.md](docs/DESIGN.md#6-한계와-리스크)를 참고하세요.

## License

MIT
