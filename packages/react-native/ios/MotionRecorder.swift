import QuartzCore
import UIKit

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
    "occludedRatio", "scrollX", "scrollY",
  ]

  /// Upper bound of views inspected per target per frame when looking for occluders.
  private static let occluderBudget = 400

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

  func start(targets: [String], maxDurationMs: Double, resolveEveryFrames: Int, occlusionGrid: Int) -> [String: Any] {
    invalidateLink()
    self.targets = targets
    self.maxDurationMs = maxDurationMs
    self.resolveEveryFrames = max(1, resolveEveryFrames)
    self.occlusionGrid = max(0, occlusionGrid)
    resolved = targets.map { _ in WeakView() }
    lastRows = Array(repeating: nil, count: targets.count)
    frameTimes = []
    drainedFrameCount = 0
    pendingSamples = []
    frameIndex = 0
    endReason = ""
    t0 = CACurrentMediaTime()

    let windows = allWindows()
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
        row = measure(view, in: window, frame: frame, target: i)
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

  private func measure(_ view: UIView, in window: UIWindow, frame: Int, target: Int) -> [Double] {
    // Coordinate conversion only works within one layer tree, so never mix model and presentation
    // layers. The presentation tree is what is on screen; it exists once the layers were rendered.
    let usePresentation = view.layer.presentation() != nil && window.layer.presentation() != nil
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
    ]
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
    var child = view
    while let parent = child.superview {
      var paintedAfter = false
      for sibling in parent.subviews {
        if sibling === child {
          paintedAfter = true
        } else if paintedAfter {
          collectCovers(sibling, target: visibleRect, windowLayer: windowLayer, onScreen: onScreen, covers: &covers, budget: &budget)
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
    if intersects && layer.opacity >= 0.5 && paintsOpaqueContent(layer) {
      covers.append(rect.intersection(target))
      if clipsChildren { return }
    }
    if clipsChildren && !intersects { return }
    for subview in view.subviews {
      collectCovers(subview, target: target, windowLayer: windowLayer, onScreen: onScreen, covers: &covers, budget: &budget)
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
  }
}
