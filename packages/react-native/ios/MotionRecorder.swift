import QuartzCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Samples the *presentation* state of views (found by testID / accessibilityIdentifier) on every
/// display frame. It reads what Core Animation is about to put on screen, so it is agnostic of which
/// JS library (Animated, Reanimated, LayoutAnimation, ...) drove the change.
///
/// Only rows whose values changed are kept; frame timestamps are kept for every frame so the
/// analyzer can reconstruct step-held series and detect dropped frames / visual stalls.
/// All methods must be called on the main thread.
final class MotionRecorder: NSObject {
  static let columns = [
    "frame", "target", "present",
    "x", "y", "width", "height",
    "boundsWidth", "boundsHeight",
    "translateX", "translateY", "scaleX", "scaleY", "rotation",
    "opacity", "effectiveOpacity", "visibleRatio",
    "occludedRatio", "scrollX", "scrollY", "contentOpacity",
  ]

  /// Upper bound of views inspected per target per frame when looking for occluders.
  private static let occluderBudget = 400
  /// Upper bound of descendants inspected per target per frame for content opacity.
  private static let contentBudget = 200

  private final class WeakView {
    weak var view: UIView?
  }

  private var link: CADisplayLink?
  private var targets: [String] = []
  private var resolved: [WeakView] = []
  private var lastRows: [[Double]?] = []
  private var frameTimes: [Double] = []
  private var drainedFrameCount = 0
  private var pendingSamples: [[Double]] = []
  private var frameIndex = 0
  private var t0: CFTimeInterval = 0
  private var maxDurationMs: Double = 15000
  private var resolveEveryFrames = 1
  private var occlusionGrid = 6
  private var nominalFrameMs: Double = 0
  private var endReason = ""
  /// Per target: opacity of each content layer in the previous frame, and running cross-dissolves.
  private var contentBefore: [[ObjectIdentifier: Double]] = []
  private var fades: [[ObjectIdentifier: (before: Double, begin: CFTimeInterval)]] = []
  /// Touch sequences as [startMs, endMs (-1 while down), farthest distance from touch-down in points].
  private var touches: [[Double]] = []
  private var touchObservers: [TouchObserver] = []

  func start(targets: [String], maxDurationMs: Double, resolveEveryFrames: Int, occlusionGrid: Int) -> [String: Any] {
    invalidateLink()
    self.targets = targets
    self.maxDurationMs = maxDurationMs
    self.resolveEveryFrames = max(1, resolveEveryFrames)
    self.occlusionGrid = max(0, occlusionGrid)
    resolved = targets.map { _ in WeakView() }
    lastRows = Array(repeating: nil, count: targets.count)
    contentBefore = Array(repeating: [:], count: targets.count)
    fades = Array(repeating: [:], count: targets.count)
    frameTimes = []
    drainedFrameCount = 0
    pendingSamples = []
    frameIndex = 0
    endReason = ""
    touches = []
    t0 = CACurrentMediaTime()

    let windows = allWindows()
    installTouchObservers(on: windows)
    for (i, id) in targets.enumerated() {
      resolved[i].view = findView(id, in: windows)
    }
    // Sample once right away: the interaction may start before the next display frame.
    sample(at: 0)

    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    if #available(iOS 15.0, *) {
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
    }
    link.add(to: .main, forMode: .common)
    self.link = link

    return [
      "startedAt": Date().timeIntervalSince1970 * 1000,
      "found": targets.enumerated().filter { resolved[$0.offset].view != nil }.map { $0.element },
      "missing": targets.enumerated().filter { resolved[$0.offset].view == nil }.map { $0.element },
    ]
  }

  func drain() -> [String: Any] {
    let offset = drainedFrameCount
    let frames = Array(frameTimes[offset...])
    drainedFrameCount = frameTimes.count
    let samples = pendingSamples
    pendingSamples = []
    return [
      "frameOffset": offset,
      "frameTimes": frames,
      "samples": samples,
      "running": link != nil,
      "endReason": endReason,
      "nominalFrameMs": nominalFrameMs,
      "touches": touches,
    ]
  }

  func stop(reason: String) -> [String: Any] {
    if link != nil {
      endReason = reason
    }
    invalidateLink()
    return drain()
  }

  // MARK: - Frame loop

  @objc private func tick(_ link: CADisplayLink) {
    let t = max(0, (link.timestamp - t0) * 1000)
    nominalFrameMs = (link.targetTimestamp - link.timestamp) * 1000
    sample(at: t)
    if t >= maxDurationMs {
      endReason = "maxDuration"
      invalidateLink()
    }
  }

  /// Records one frame: looks up targets that are not on screen and appends the rows that changed.
  private func sample(at t: Double) {
    let frame = frameIndex
    frameIndex += 1
    frameTimes.append(t)

    var windows: [UIWindow]?
    for (i, id) in targets.enumerated() {
      var view = resolved[i].view
      if view == nil || view?.window == nil || view?.accessibilityIdentifier != id {
        view = nil
        // Look it up again right after losing it (remount / recycling), otherwise every
        // `resolveEveryFrames` frames (default: every frame, so a mounting view is caught at once).
        let wasPresent = lastRows[i]?[2] == 1
        if wasPresent || frame % resolveEveryFrames == 0 {
          if windows == nil { windows = allWindows() }
          view = findView(id, in: windows!)
          resolved[i].view = view
        }
      }

      let row: [Double]
      if let view, let window = view.window {
        row = measure(view, in: window, frame: frame, target: i, mounting: lastRows[i]?[2] != 1)
      } else {
        row = [Double(frame), Double(i), 0] + Array(repeating: 0, count: Self.columns.count - 3)
      }

      guard let last = lastRows[i] else {
        lastRows[i] = row
        if row[2] == 1 { pendingSamples.append(row) }
        continue
      }
      if hasChanged(last, row) {
        pendingSamples.append(row)
        lastRows[i] = row
      }
    }
  }

  private func measure(_ view: UIView, in window: UIWindow, frame: Int, target: Int, mounting: Bool) -> [Double] {
    // Coordinate conversion only works within one layer tree, so never mix model and presentation
    // layers. The presentation tree is what is on screen; it exists once the layers were rendered.
    let usePresentation = view.layer.presentation() != nil && window.layer.presentation() != nil
      && !(mounting && hasStalePresentation(view.layer, in: window.layer))
    func onScreen(_ layer: CALayer) -> CALayer {
      usePresentation ? (layer.presentation() ?? layer) : layer
    }
    let layer = onScreen(view.layer)
    let windowLayer = onScreen(window.layer)
    let rect = layer.convert(layer.bounds, to: windowLayer)

    let m = layer.transform
    let translateX = Double(m.m41)
    let translateY = Double(m.m42)
    let scaleX = Double((m.m11 * m.m11 + m.m12 * m.m12).squareRoot())
    let scaleY = Double((m.m21 * m.m21 + m.m22 * m.m22).squareRoot())
    let rotation = Double(atan2(m.m12, m.m11)) * 180 / .pi

    var effectiveOpacity = view.isHidden ? 0 : Double(layer.opacity)
    var clip = windowLayer.bounds
    var scrollX = 0.0
    var scrollY = 0.0
    var ancestor = view.superview
    while let a = ancestor {
      let al = onScreen(a.layer)
      effectiveOpacity *= a.isHidden ? 0 : Double(al.opacity)
      if a.clipsToBounds || a.layer.masksToBounds {
        clip = clip.intersection(al.convert(al.bounds, to: windowLayer))
      }
      // A shifted bounds origin is a scroll offset (UIScrollView.contentOffset).
      scrollX += Double(al.bounds.origin.x)
      scrollY += Double(al.bounds.origin.y)
      ancestor = a.superview
    }

    let area = rect.width * rect.height
    let visible = rect.intersection(clip)
    let hasVisibleArea = area > 0 && !visible.isNull && visible.width > 0 && visible.height > 0
    let visibleRatio = hasVisibleArea ? Double(visible.width * visible.height / area) : 0
    let occluded = hasVisibleArea
      ? occludedRatio(of: view, visibleRect: visible, windowLayer: windowLayer, onScreen: onScreen)
      : 0

    return [
      Double(frame), Double(target), 1,
      Double(rect.origin.x), Double(rect.origin.y), Double(rect.width), Double(rect.height),
      Double(layer.bounds.width), Double(layer.bounds.height),
      translateX, translateY, scaleX, scaleY, rotation,
      Double(layer.opacity), effectiveOpacity, visibleRatio,
      occluded, scrollX, scrollY,
      contentOpacity(
        of: view, target: target, own: rect.insetBy(dx: -1, dy: -1), windowLayer: windowLayer, onScreen: onScreen),
    ]
  }

  /// Fabric recycles native views: a reused view keeps the presentation state of its previous use (its
  /// old size and position) until it is rendered again, while its model already has the new layout. On
  /// the frame a view mounts, a layer whose presentation disagrees with its model without an animation
  /// explaining it has not been rendered yet, so the model is what this frame will show.
  private func hasStalePresentation(_ layer: CALayer, in root: CALayer) -> Bool {
    var current: CALayer? = layer
    while let model = current, model !== root {
      if let presentation = model.presentation(), (model.animationKeys() ?? []).isEmpty,
        presentation.bounds != model.bounds || presentation.position != model.position
          || !CATransform3DEqualToTransform(presentation.transform, model.transform)
      {
        return true
      }
      current = model.superlayer
    }
    return false
  }

  // MARK: - Content

  /// Opacity of what the view draws inside itself, relative to the view: its own drawn content (an
  /// image) and its subviews' images, text and backgrounds, composited as overlapping layers
  /// (1 − Π(1 − alpha)). The view's own background is not content, so an image fading in over a
  /// placeholder color counts. Cross-dissolve transitions (UIView.transition, which image libraries
  /// use to fade images in) blend from the content shown before them.
  private func contentOpacity(
    of view: UIView,
    target: Int,
    own: CGRect,
    windowLayer: CALayer,
    onScreen: (CALayer) -> CALayer
  ) -> Double {
    var clear = 1.0
    var budget = Self.contentBudget
    var pieces: [ObjectIdentifier: Double] = [:]
    func visit(_ v: UIView, inherited: Double, isTarget: Bool) {
      guard budget > 0, clear > 0.001, !v.isHidden else { return }
      budget -= 1
      let layer = onScreen(v.layer)
      let alpha = isTarget ? 1 : inherited * Double(layer.opacity)
      guard alpha >= 0.001 else { return }
      let draws = isTarget ? layer.contents != nil : paintsOpaqueContent(layer)
      let piece = crossDissolved(v.layer, target: target, piece: draws ? alpha : 0)
      pieces[ObjectIdentifier(v.layer)] = piece
      clear *= 1 - piece
      for subview in v.subviews {
        visit(subview, inherited: alpha, isTarget: false)
      }
    }
    visit(view, inherited: 1, isTarget: true)
    // Fabric mounts the children of a view that does not form a stacking context as later siblings of
    // it (view flattening): what lies inside the view and is painted after it is its content too.
    if let parent = view.superview, let index = parent.subviews.firstIndex(where: { $0 === view }) {
      for sibling in parent.subviews[(index + 1)...] {
        let layer = onScreen(sibling.layer)
        if own.contains(layer.convert(layer.bounds, to: windowLayer)) {
          visit(sibling, inherited: 1, isTarget: false)
        }
      }
    }
    contentBefore[target] = pieces
    return 1 - clear
  }

  /// A running fade transition renders the content from before it dissolving into the current one.
  private func crossDissolved(_ layer: CALayer, target: Int, piece: Double) -> Double {
    let id = ObjectIdentifier(layer)
    guard let transition = runningFade(on: layer) else {
      fades[target][id] = nil
      return piece
    }
    let now = layer.convertTime(CACurrentMediaTime(), from: nil)
    var fade = fades[target][id] ?? (before: contentBefore[target][id] ?? 0, begin: now)
    // CA sets the begin time when the transaction commits; a new transition restarts the blend.
    if transition.beginTime > 0, abs(transition.beginTime - fade.begin) > 0.001 {
      if fades[target][id] != nil { fade.before = contentBefore[target][id] ?? 0 }
      fade.begin = transition.beginTime
    }
    fades[target][id] = fade
    let duration = transition.duration > 0 ? transition.duration : 0.25
    let p = eased(transition.timingFunction, min(1, max(0, (now - fade.begin) / duration)))
    return fade.before * (1 - p) + piece * p
  }

  private func runningFade(on layer: CALayer) -> CATransition? {
    for key in layer.animationKeys() ?? [] {
      if let transition = layer.animation(forKey: key) as? CATransition, transition.type == .fade {
        return transition
      }
    }
    return nil
  }

  /// Value of a cubic-bezier timing function at `x` (bisection on the x polynomial).
  private func eased(_ function: CAMediaTimingFunction?, _ x: Double) -> Double {
    guard let function else { return x }
    var c1: [Float] = [0, 0]
    var c2: [Float] = [0, 0]
    function.getControlPoint(at: 1, values: &c1)
    function.getControlPoint(at: 2, values: &c2)
    func bezier(_ s: Double, _ a: Float, _ b: Float) -> Double {
      3 * Double(a) * s * (1 - s) * (1 - s) + 3 * Double(b) * s * s * (1 - s) + s * s * s
    }
    var lo = 0.0
    var hi = 1.0
    for _ in 0..<30 {
      let mid = (lo + hi) / 2
      if bezier(mid, c1[0], c2[0]) < x { lo = mid } else { hi = mid }
    }
    return bezier((lo + hi) / 2, c1[1], c2[1])
  }

  // MARK: - Occlusion

  /// Share of the target's visible rect covered by views painted after it: later siblings of the view
  /// or of any ancestor. Fabric mounts children already sorted by zIndex, so subview order is paint
  /// order. Only views with an opaque-ish background, image or drawn content count as covers; the
  /// covered area is estimated on an `occlusionGrid`² sample grid.
  private func occludedRatio(
    of view: UIView,
    visibleRect: CGRect,
    windowLayer: CALayer,
    onScreen: (CALayer) -> CALayer
  ) -> Double {
    guard occlusionGrid > 0 else { return 0 }
    var covers: [CGRect] = []
    var budget = Self.occluderBudget
    // Fabric can mount a view's children as later siblings (view flattening), so anything lying
    // entirely inside the target is its own content, not something covering it.
    let ownLayer = onScreen(view.layer)
    let own = ownLayer.convert(ownLayer.bounds, to: windowLayer).insetBy(dx: -1, dy: -1)
    var child = view
    while let parent = child.superview {
      var paintedAfter = false
      for sibling in parent.subviews {
        if sibling === child {
          paintedAfter = true
        } else if paintedAfter {
          collectCovers(sibling, target: visibleRect, own: own, windowLayer: windowLayer, onScreen: onScreen, covers: &covers, budget: &budget)
        }
      }
      child = parent
    }
    guard !covers.isEmpty else { return 0 }

    let n = occlusionGrid
    var covered = 0
    for gy in 0..<n {
      for gx in 0..<n {
        let point = CGPoint(
          x: visibleRect.minX + (CGFloat(gx) + 0.5) * visibleRect.width / CGFloat(n),
          y: visibleRect.minY + (CGFloat(gy) + 0.5) * visibleRect.height / CGFloat(n)
        )
        if covers.contains(where: { $0.contains(point) }) { covered += 1 }
      }
    }
    return Double(covered) / Double(n * n)
  }

  private func collectCovers(
    _ view: UIView,
    target: CGRect,
    own: CGRect,
    windowLayer: CALayer,
    onScreen: (CALayer) -> CALayer,
    covers: inout [CGRect],
    budget: inout Int
  ) {
    guard budget > 0, !view.isHidden else { return }
    budget -= 1
    let layer = onScreen(view.layer)
    guard layer.opacity >= 0.01 else { return }

    let rect = layer.convert(layer.bounds, to: windowLayer)
    let intersects = rect.intersects(target)
    let clipsChildren = view.clipsToBounds || view.layer.masksToBounds
    if intersects && !own.contains(rect) && layer.opacity >= 0.5 && paintsOpaqueContent(layer) {
      covers.append(rect.intersection(target))
      if clipsChildren { return }
    }
    if clipsChildren && !intersects { return }
    for subview in view.subviews {
      collectCovers(subview, target: target, own: own, windowLayer: windowLayer, onScreen: onScreen, covers: &covers, budget: &budget)
    }
  }

  private func paintsOpaqueContent(_ layer: CALayer) -> Bool {
    if let color = layer.backgroundColor, color.alpha >= 0.5 { return true }
    // Images and drawn content (including text).
    if layer.contents != nil { return true }
    // Fabric paints rounded / bordered backgrounds into a dedicated full-size sublayer.
    for sublayer in layer.sublayers ?? [] where sublayer.bounds.size == layer.bounds.size {
      if let color = sublayer.backgroundColor, color.alpha >= 0.5 { return true }
    }
    return false
  }

  private func hasChanged(_ a: [Double], _ b: [Double]) -> Bool {
    for i in 2..<a.count where abs(a[i] - b[i]) > 0.001 {
      return true
    }
    return false
  }

  // MARK: - View lookup

  private func allWindows() -> [UIWindow] {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
  }

  private func findView(_ id: String, in windows: [UIWindow]) -> UIView? {
    var stack: [UIView] = windows.reversed()
    while let view = stack.popLast() {
      if view.accessibilityIdentifier == id {
        return view
      }
      stack.append(contentsOf: view.subviews.reversed())
    }
    return nil
  }

  private func invalidateLink() {
    link?.invalidate()
    link = nil
    for observer in touchObservers {
      observer.view?.removeGestureRecognizer(observer)
    }
    touchObservers = []
  }

  // MARK: - Touches

  private func installTouchObservers(on windows: [UIWindow]) {
    for window in windows {
      let observer = TouchObserver { [weak self] phase, timestamp, distance in
        self?.recordTouch(phase, timestamp: timestamp, distance: distance)
      }
      window.addGestureRecognizer(observer)
      touchObservers.append(observer)
    }
  }

  /// Touch timestamps share CACurrentMediaTime's clock (time since boot).
  private func recordTouch(_ phase: TouchObserver.Phase, timestamp: TimeInterval, distance: Double) {
    let t = max(0, (timestamp - t0) * 1000)
    switch phase {
    case .began:
      touches.append([t, -1, 0])
    case .moved, .ended:
      guard let i = touches.indices.last, touches[i][1] < 0 else { return }
      touches[i][2] = max(touches[i][2], distance)
      if phase == .ended { touches[i][1] = max(touches[i][0], t) }
    }
  }
}

/// Watches the touches a window receives without taking part in gesture handling: it never
/// recognizes, so it cannot cancel, delay or block touches or other recognizers.
final class TouchObserver: UIGestureRecognizer {
  enum Phase { case began, moved, ended }

  private let onTouch: (Phase, TimeInterval, Double) -> Void
  private var origins: [ObjectIdentifier: CGPoint] = [:]
  private var distance = 0.0

  init(onTouch: @escaping (Phase, TimeInterval, Double) -> Void) {
    self.onTouch = onTouch
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    if origins.isEmpty, let first = touches.first {
      distance = 0
      onTouch(.began, first.timestamp, 0)
    }
    for touch in touches {
      origins[ObjectIdentifier(touch)] = touch.location(in: nil)
    }
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    for touch in touches {
      guard let origin = origins[ObjectIdentifier(touch)] else { continue }
      let point = touch.location(in: nil)
      distance = max(distance, Double(hypot(point.x - origin.x, point.y - origin.y)))
    }
    if let first = touches.first { onTouch(.moved, first.timestamp, distance) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches) }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches) }

  private func lift(_ touches: Set<UITouch>) {
    for touch in touches {
      origins[ObjectIdentifier(touch)] = nil
    }
    guard origins.isEmpty, let first = touches.first else { return }
    onTouch(.ended, first.timestamp, distance)
    state = .failed
  }

  override func reset() {
    origins = [:]
    distance = 0
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
