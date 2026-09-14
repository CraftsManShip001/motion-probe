import { installMotionProbe } from '@motion-probe/react-native';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Animated as RNAnimated,
  Easing as RNEasing,
  LayoutAnimation,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

if (__DEV__) installMotionProbe({ appName: 'motion-probe-demo', verbose: true });

type Action = 'run' | 'reset';
type Command = { action: Action; n: number };
type ScenarioProps = { command?: Command };

/** Runs `run` / `reset` whenever a new command arrives (buttons or deep links). */
function useCommand(command: Command | undefined, handlers: Record<Action, () => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (command) ref.current[command.action]();
  }, [command?.n]);
}

function TimingScenario({ command }: ScenarioProps) {
  const x = useSharedValue(0);
  const opacity = useSharedValue(0.3);
  useCommand(command, {
    run: () => {
      x.value = 0;
      opacity.value = 0.3;
      x.value = withTiming(200, { duration: 300, easing: Easing.out(Easing.cubic) });
      opacity.value = withTiming(1, { duration: 200, easing: Easing.linear });
    },
    reset: () => {
      x.value = 0;
      opacity.value = 0.3;
    },
  });
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateX: x.value }] }));
  return (
    <View style={styles.stage}>
      <Animated.View testID="timing-card" style={[styles.box, style]} />
    </View>
  );
}

function SpringScenario({ command }: ScenarioProps) {
  const scale = useSharedValue(1);
  useCommand(command, {
    run: () => {
      scale.value = 1;
      // damping / (2·√(stiffness·mass)) = 6 / (2·√120) ≈ 0.27
      scale.value = withSpring(1.3, { damping: 6, stiffness: 120, mass: 1 });
    },
    reset: () => {
      scale.value = 1;
    },
  });
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <View style={[styles.stage, styles.center]}>
      <Animated.View testID="spring-badge" style={[styles.box, styles.round, style]} />
    </View>
  );
}

function NativeDriverScenario({ command }: ScenarioProps) {
  const x = useRef(new RNAnimated.Value(0)).current;
  useCommand(command, {
    run: () => {
      x.setValue(0);
      RNAnimated.timing(x, { toValue: 200, duration: 400, useNativeDriver: true }).start();
    },
    reset: () => x.setValue(0),
  });
  return (
    <View style={styles.stage}>
      <RNAnimated.View testID="native-box" style={[styles.box, styles.green, { transform: [{ translateX: x }] }]} />
    </View>
  );
}

function ClippedToastScenario({ command }: ScenarioProps) {
  const y = useSharedValue(60);
  useCommand(command, {
    run: () => {
      y.value = 60;
      // Bug: should settle at 8 so the 44pt toast fits inside the 60pt container.
      y.value = withTiming(30, { duration: 250, easing: Easing.out(Easing.quad) });
    },
    reset: () => {
      y.value = 60;
    },
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return (
    <View style={[styles.stage, styles.clip]}>
      <Animated.View testID="toast" style={[styles.toast, style]}>
        <Text style={styles.toastText}>Saved</Text>
      </Animated.View>
    </View>
  );
}

function JsJankScenario({ command }: ScenarioProps) {
  const x = useRef(new RNAnimated.Value(0)).current;
  useCommand(command, {
    run: () => {
      x.setValue(0);
      RNAnimated.timing(x, { toValue: 200, duration: 500, easing: RNEasing.linear, useNativeDriver: false }).start();
      // Simulates heavy JS work (e.g. a big setState) while a JS-driven animation runs.
      setTimeout(() => {
        const end = Date.now() + 250;
        while (Date.now() < end) {}
      }, 120);
    },
    reset: () => x.setValue(0),
  });
  return (
    <View style={styles.stage}>
      <RNAnimated.View testID="jank-box" style={[styles.box, styles.orange, { transform: [{ translateX: x }] }]} />
    </View>
  );
}

function CoveredBadgeScenario({ command }: ScenarioProps) {
  const x = useSharedValue(0);
  useCommand(command, {
    run: () => {
      x.value = 0;
      x.value = withTiming(260, { duration: 250, easing: Easing.out(Easing.cubic) });
    },
    reset: () => {
      x.value = 0;
    },
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View style={styles.stage}>
      <Animated.View testID="covered-badge" style={[styles.box, styles.red, style]} />
      {/* Bug: the tooltip is rendered after (above) the spot where the badge comes to rest. */}
      <View style={styles.tooltip}>
        <Text style={styles.tooltipText}>Tooltip</Text>
      </View>
    </View>
  );
}

function ScrollScenario({ command }: ScenarioProps) {
  const scrollRef = useRef<ScrollView>(null);
  useCommand(command, {
    run: () => scrollRef.current?.scrollTo({ y: 120, animated: true }),
    reset: () => scrollRef.current?.scrollTo({ y: 0, animated: false }),
  });
  return (
    <ScrollView ref={scrollRef} style={styles.scrollStage} contentContainerStyle={styles.scrollContent} nestedScrollEnabled>
      <View style={styles.scrollSpacer} />
      <View testID="scroll-item" style={[styles.box, styles.teal]} />
      <View style={styles.scrollSpacer} />
    </ScrollView>
  );
}

function LayoutScenario({ command }: ScenarioProps) {
  const [expanded, setExpanded] = useState(false);
  useCommand(command, {
    run: () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(true);
    },
    reset: () => setExpanded(false),
  });
  return (
    <View style={styles.stage}>
      <View testID="layout-panel" style={[styles.panel, { width: expanded ? 300 : 80 }]} />
    </View>
  );
}

const SCENARIOS: Array<{ key: string; title: string; Component: (props: ScenarioProps) => ReactElement }> = [
  { key: 'timing', title: 'Reanimated · withTiming', Component: TimingScenario },
  { key: 'spring', title: 'Reanimated · withSpring', Component: SpringScenario },
  { key: 'native-driver', title: 'Animated · native driver', Component: NativeDriverScenario },
  { key: 'clipped-toast', title: 'Bug · toast clipped by parent', Component: ClippedToastScenario },
  { key: 'js-jank', title: 'Bug · JS-driven + blocked JS thread', Component: JsJankScenario },
  { key: 'covered-badge', title: 'Bug · badge ends under a tooltip', Component: CoveredBadgeScenario },
  { key: 'scroll', title: 'ScrollView · scrollTo (animated)', Component: ScrollScenario },
  { key: 'layout', title: 'LayoutAnimation · width', Component: LayoutScenario },
];

export default function App() {
  const [commands, setCommands] = useState<Record<string, Command>>({});
  const counter = useRef(0);

  const dispatch = (key: string, action: Action) => {
    const keys = key === 'all' ? SCENARIOS.map((s) => s.key) : [key];
    setCommands((current) => {
      const next = { ...current };
      for (const k of keys) next[k] = { action, n: ++counter.current };
      return next;
    });
  };

  useEffect(() => {
    // motionprobe-demo://run/<scenario|all>, motionprobe-demo://reset/<scenario|all>
    const handle = (url: string | null) => {
      const match = url?.match(/:\/\/(run|reset)\/([\w-]+)/);
      if (match) dispatch(match[2], match[1] as Action);
    };
    Linking.getInitialURL().then(handle);
    const subscription = Linking.addEventListener('url', (event) => handle(event.url));
    return () => subscription.remove();
  }, []);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>motion-probe demo</Text>
        {SCENARIOS.map(({ key, title, Component }) => (
          <View key={key} style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.title}>{title}</Text>
              <Pressable onPress={() => dispatch(key, 'reset')} hitSlop={8}>
                <Text style={styles.link}>Reset</Text>
              </Pressable>
              <Pressable onPress={() => dispatch(key, 'run')} hitSlop={8}>
                <Text style={styles.link}>Run</Text>
              </Pressable>
            </View>
            <Component command={commands[key]} />
          </View>
        ))}
      </ScrollView>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  content: { paddingTop: 64, paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  heading: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  card: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  title: { flex: 1, fontSize: 14, fontWeight: '600', color: '#333d4b' },
  link: { fontSize: 14, color: '#3182f6', fontWeight: '600' },
  stage: { height: 60, borderRadius: 12, backgroundColor: '#f2f4f6', justifyContent: 'center', paddingHorizontal: 8 },
  center: { alignItems: 'center' },
  clip: { overflow: 'hidden', justifyContent: 'flex-start' },
  box: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#3182f6' },
  round: { borderRadius: 22, backgroundColor: '#8b5cf6' },
  green: { backgroundColor: '#10b981' },
  orange: { backgroundColor: '#f59e0b' },
  red: { backgroundColor: '#ef4444' },
  teal: { backgroundColor: '#14b8a6' },
  tooltip: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 90,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e8eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tooltipText: { color: '#333d4b', fontWeight: '600' },
  scrollStage: { height: 60, flexGrow: 0, borderRadius: 12, backgroundColor: '#f2f4f6' },
  scrollContent: { paddingHorizontal: 8 },
  scrollSpacer: { height: 128 },
  toast: {
    position: 'absolute',
    left: 8,
    right: 8,
    top: 0,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#191f28',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  toastText: { color: '#fff', fontWeight: '600' },
  panel: { height: 44, borderRadius: 10, backgroundColor: '#ec4899' },
});
