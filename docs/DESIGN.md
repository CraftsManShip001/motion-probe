# motion-probe 설계 문서

## 1. 문제

에이전트가 RN 애니메이션을 검증하려면 지금은 화면을 녹화해서 프레임 이미지를 한 장씩 보는 수밖에 없다.

- **느리고 비싸다**: 1초 애니메이션을 60fps로 보면 이미지가 60장이고, 이미지 토큰이 계속 쌓인다.
- **부정확하다**: 이미지로는 "300ms였나, 350ms였나", "ease-out인가 spring인가"를 판단하기 어렵다.
- **판정이 불가능하다**: 명세("250ms, overshoot 없이, 잘리지 않게")와 비교할 수치가 없다.

에이전트에게 필요한 건 픽셀이 아니라 **"무엇이, 언제, 어디서 어디로, 어떤 곡선으로, 끊김·잘림 없이 움직였나"라는 구조화된 사실**이다.

## 2. 어느 층에서 관측할 것인가

| 층 | 수집 대상 | 잡을 수 있는 것 | 놓치는 것 |
|---|---|---|---|
| L1 JS 값 | SharedValue / Animated.Value | duration, easing | style 미연결, 네이티브 드라이버, 레이아웃, 잘림 |
| L2 적용 props | useAnimatedStyle 결과 | + style 연결 | LayoutAnimation, 네이티브 전환, 잘림 |
| **L3 네이티브 뷰** | **CALayer presentation / Android View** | **+ 네이티브 드라이버, LayoutAnimation, 부모 이동, 잘림, 실제 갱신 끊김** | 셰이더/Lottie 내부 픽셀 |
| L4 픽셀 | 녹화·스크린샷 | 전부 | 비용·정밀도·토큰 |

**L3를 핵심으로 선택한 이유**

1. **라이브러리와 무관하다.** Animated, Reanimated, LayoutAnimation, RN 0.85의 New Animation Backend 무엇이 값을 바꾸든, 최종 네이티브 뷰만 읽는다. JS 쪽 훅(L1/L2)은 라이브러리 내부 구조가 바뀔 때마다 깨진다.
2. **번들러와 무관하다.** Babel 플러그인에 의존하지 않으므로 Metro가 아닌 자체 번들러 환경(예: Granite)에도 들어갈 수 있다.
3. **"사용자에게 보이는 것"에 가장 가깝다.** 값은 정상인데 부모의 `overflow: hidden`에 잘리는 버그는 L1/L2로는 원리상 보이지 않는다.

## 3. 구조

```
 조작 계층 (의존하지 않음)
 Maestro · Detox · agent-device · mobile MCP · deep link · 사람
          │  --trigger "<아무 shell 명령>"  또는  arm → (다른 도구로 조작) → report
          ▼
 ┌─ @motion-probe/cli ───────────────────────────────┐
 │ daemon: HTTP(에이전트/CLI) ↔ WebSocket /app(앱)     │
 │ record · arm · report · analyze · easings           │
 └──────────────┬─────────────────────────────────────┘
                │ arm / trace (protocol v1)
 ┌─ @motion-probe/react-native (앱, dev 빌드 전용) ────┐
 │ JS: 데몬 연결, drain 폴링, settle 감지               │
 │ iOS: CADisplayLink + presentationLayer               │
 │ Android: Choreographer + View matrix                 │
 └────────────────────────────────────────────────────┘
                │ RawTrace (motion-probe/raw-trace@1)
 ┌─ @motion-probe/core (순수 TS, 플랫폼 무관) ──────────┐
 │ summarize → MotionReport (motion-probe/report@1)     │
 │ evaluate(spec) → AssertionReport                     │
 │ formatReport(텍스트) · toOtlpJson(OpenTelemetry)      │
 └────────────────────────────────────────────────────┘
```

## 4. 주요 결정

### 조작 도구에 의존하지 않고 트리거를 위임한다
Maestro MCP 같은 도구에 런타임으로 의존하면 사용자층이 좁아지고(Detox·Appium·agent-device 사용자 제외), 설치 부담(Java)이 생기고, 에이전트용 도구 인터페이스라는 불안정한 계약에 묶인다. Flashlight(`--testCommand`)처럼 **관측만 담당하고 조작은 아무 명령에나 위임**한다.

### arm → 자동 settle
에이전트는 도구 호출 사이에 수 초가 걸려서 "지금 녹화 시작/중지"를 맞출 수 없다. 그래서 먼저 arm해 두고, **첫 변화가 생긴 뒤 `idleMs` 동안 아무 변화가 없으면 스스로 종료**한다. 대상이 arm 시점에 없어도 마운트되는 순간부터 추적한다.

### 네이티브는 얇게, 판단은 TS로
네이티브는 "지정한 뷰의 렌더 상태를 매 프레임 읽고, **값이 바뀐 행만** 쌓는다"만 한다. 구간 분할, 이징 피팅, 판정은 모두 `core`(TS)에 있다. 그래서
- 대부분의 개선이 앱 재빌드 없이 npm 업데이트로 끝나고,
- 같은 raw trace를 `analyze`로 몇 번이든 재분석할 수 있고,
- 분석 로직을 기기 없이 합성 데이터로 단위 테스트할 수 있다.

### 분석 모델
- **값 재구성**: 변화 행을 프레임 단위 step-held 시계열로 복원한다.
- **left/top**: `중심 − 자기 translate − bounds/2`, 즉 변환 전 위치. 자기 transform이 아니라 **부모·레이아웃 때문에 움직였을 때만** 보고해서 중복 보고를 막는다.
- **구간 분할**: prop별 epsilon보다 큰 변화를 모으고, `gapMs` 이상 멈추면 끊는다. 1프레임 변화는 `jump`(애니메이션 누락 신호)로 분류한다.
- **곡선**: overshoot < 2%이면 명명된 이징(RN/Reanimated 기본값 포함) 중 최근접 + cubic-bezier 그리드 피팅. 아니면 spring으로 보고 반주기 감쇠율에서 damping ratio를 추정한다.
- **끊김 두 종류를 구분**:
  - `droppedFrames`: 디스플레이 프레임 자체가 빠짐(메인 스레드 막힘)
  - `stalls`: 프레임은 나오는데 **값이 멈춤**(JS 스레드 막힘, JS 구동 애니메이션). 녹화 영상으로는 둘을 구분하기 어렵다.
- **가시성**: 조상 중 `clipsToBounds`/`overflow: hidden`의 교집합과 화면 경계로 visible area ratio를 계산한다.

### 보이는 정도: 잘림, 가림, 스크롤
"보인다"를 원인별로 나눠 기록한다. 원인에 따라 고치는 방법이 다르기 때문이다.

- **잘림(`visibleRatio`)**: 조상 중 `clipsToBounds`/`overflow: hidden`인 뷰, 스크롤 뷰포트, 화면 경계의 교집합 안에 들어온 면적 비율.
- **가림(`occludedRatio`)**: 그 면적 중 **대상보다 나중에 그려지는 뷰**에 덮인 비율. 대상과 각 조상의 "뒤쪽 형제" 서브트리만 훑는다.
  - iOS: Fabric이 zIndex 순으로 정렬해서 마운트하므로 subview 순서가 곧 그리는 순서다.
  - Android: elevation(z)을 먼저 보고, 그다음 `getChildDrawingOrder`로 그리는 순서를 본다(RN은 zIndex를 여기에 매핑한다).
  - 불투명 배경(Fabric의 배경 서브레이어 포함), 이미지, 그려진 콘텐츠만 가리는 뷰로 친다.
  - 면적은 n×n 샘플 격자로 추정하고(기본 6×6), 프레임당 400뷰까지만 탐색한다.
- **스크롤(`scrollX/Y`)**: 조상들의 bounds origin(= contentOffset) 합. 분석기는 `left/top`에서 스크롤을 보정해 **레이아웃 이동과 스크롤을 분리**하고, 스크롤 자체도 하나의 애니메이션(scrollTo 곡선)으로 보고한다. 스크롤한 뒤 뷰포트 밖으로 나간 경우는 버그가 아니므로 `clipped-at-end` 대신 info(`scrolled-out-of-view`)로 분류한다.

리포트의 `visible`은 둘을 곱한 실제 보이는 비율이다. 스펙의 `minVisibleRatio`/`minFinalVisibleRatio`도 이 값을 기준으로 판정하고, 실패 메시지에는 원인 비율을 함께 적는다.

### 디자인 모션 토큰 → 스펙
명세의 원천은 보통 디자인 시스템의 토큰이다. `specFromMotionTokens`는 W3C Design Tokens(DTCG) 파일을 읽는다. 지원 범위는 다음과 같다.
- 그룹 `$type` 상속과 별칭(`{motion.duration.normal}`)
- `duration`: `"250ms"`, `"0.25s"`, `{value, unit}` 형식
- `cubicBezier`, 합성 `transition`
- `spring`: `dampingRatio` 또는 Reanimated 스타일의 `damping/stiffness/mass`

"어떤 testID의 어떤 prop이 어떤 토큰을 따르는가" 목록과 합쳐 기대값을 만든다. spring은 감쇠비로 overshoot(`exp(-ζπ/√(1-ζ²))`)와 2% 수렴 시간(`4/(ζω₀)`)을 계산하고, 그 결과로 상·하한과 settle 상한을 둔다. 토큰 경로를 잘못 쓰면 비슷한 경로를 제안하고, 타입이 맞지 않으면("easing 토큰을 duration에 씀") 거부한다.

### 스펙 없이도 판정: 이슈 자동 진단
스펙을 쓰는 사람이 없어도 에이전트가 바로 행동할 수 있어야 한다. 리포트에 `issues`를 붙여 흔한 결함을 코드로 분류한다.
`target-not-found`, `jump`, `stall`, `dropped-frames`, `clipped-at-end`, `never-settled`는 warning 이상이고, `clipped-during-motion`(슬라이드 인/아웃에서 정상), `invisible-at-end`, `no-motion`은 info다.

`stall`은 "값이 2프레임 이상 그대로이고, 아직 5% 이상 남았고, **멈추기 전후 진행 방향이 같다**"일 때만 잡는다. 스프링 꼭짓점처럼 속도가 0에 가까워지는 순간을 멈춤으로 오판하지 않기 위해서다.

### 모션 회귀 테스트: 베이스라인
`createBaselineSpec(report)`은 잘 동작하는 녹화를 스펙으로 바꾼다. duration은 ±15%(최소 2프레임) 허용, 이징은 명명 곡선이 충분히 맞으면 이름으로, 아니면 피팅된 베지어로 적는다. 스프링은 overshoot 상한과 settle 시간, 그리고 멈춤 횟수와 최종 가시성까지 고정한다. 스냅샷 테스트처럼 **의도하지 않은 모션 변경**을 CI에서 잡는 용도다.

### 에이전트 인터페이스: CLI → 라이브러리 → MCP
기능은 `@motion-probe/cli`의 라이브러리 API(`recordMotion`, `analyzeTrace`, `DaemonClient`) 한 곳에 있고, CLI와 MCP 서버는 그 위의 얇은 껍데기다. MCP 서버는 살아 있는 동안 데몬을 직접 호스팅해서, 앱 연결이 도구 호출 사이에 끊기지 않는다. MCP의 stdout은 프로토콜 전용이므로 trigger 출력과 로그는 모두 stderr로 보낸다.

### 검증 전략: 네이티브 컴파일은 CI에서
분석기는 합성 trace로 단위 테스트하고, 데몬↔앱 프로토콜은 가짜 앱(WebSocket)으로 통합 테스트한다. 둘 다 기기가 필요 없다. iOS/Android 네이티브 코드는 CI에서 `expo prebuild` 후 xcodebuild와 Gradle로 컴파일해 검증한다. 시뮬레이터에서 실제로 돌려보는 검증은 별도 단계로 둔다.

### 출력 계약
- `text`: 에이전트용 기본값. 대상당 몇 줄.
- `json`: 버전이 붙은 스키마(`motion-probe/report@1`, `assertions@1`). 다른 도구가 소비하는 API다.
- `otlp`: OpenTelemetry 트레이스(녹화 → 대상 → 애니메이션 span). 기존 UX 계측 파이프라인에 그대로 보낼 수 있다.

## 5. 선행 사례와의 차이

| 도구 | 하는 일 | motion-probe와의 차이 |
|---|---|---|
| DetoxSync | 네이티브 애니메이션 감지해서 idle 판단 | "어떤 뷰가 애니메이션 중인지는 제공 불가". 개수만 셈 |
| Flashlight · agent-device | FPS, frame-health | 앱 전체 수준. 뷰별 값·곡선·잘림 없음 |
| Reanimated Jest 유틸 | 가짜 시계로 style 조회 | JS만, 기기·네이티브 드라이버·레이아웃 없음 |
| Compose/Flutter 테스트 | 프레임 단위 중간값 검증 | 각 프레임워크 단위 테스트 전용 |
| 녹화 + LLM 판독 | 픽셀 | 느림·비쌈·수치 판정 불가 |

## 6. 한계와 리스크

- **Android 미검증**: Kotlin 구현은 작성했지만 이 프로토타입 환경(JDK/SDK 없음)에서는 빌드·실행하지 못했다.
- **디스플레이 링크 순서**: 우리 CADisplayLink와 애니메이션 드라이버의 콜백 순서가 정해져 있지 않아 최대 1프레임 오차가 생길 수 있다.
- **view flattening**: Android Fabric에서 레이아웃 전용 View는 네이티브 뷰가 없을 수 있다. 이때 "not found"로 알리고 `collapsable={false}`를 안내한다.
- **가림 추정의 근사**: 텍스트 박스와 둥근 모서리를 사각형 전체로 치고, 반투명(alpha < 0.5) 뷰나 그림자는 무시한다. 별도 UIWindow(시스템 알림 등)는 고려하지 않는다.
- **중첩 스크롤**: 조상 스크롤 오프셋을 모두 합산하므로, 어느 스크롤 뷰가 움직였는지는 구분하지 않는다.
- **토큰의 delay**: 녹화 시점과 트리거 사이의 지연을 알 수 없어서, 토큰의 delay는 아직 검사하지 않는다.
- **탐색 비용**: 누락된 대상은 N프레임마다 트리를 탐색한다. 큰 화면에서는 testID 인덱싱으로 바꿀 필요가 있다.

## 7. 로드맵

1. 시뮬레이터/에뮬레이터 실동작 검증을 CI에 추가 (데모 `verify.sh`)
2. 연속 애니메이션 간 상대 타이밍(stagger, delay) 검증
3. 선택적 L4: 핵심 시점 크롭 스크린샷과 픽셀 diff 수치화(Lottie/Skia, 텍스트 가림 정밀화)
4. agent-device / Maestro와 함께 쓰는 예제 flow
