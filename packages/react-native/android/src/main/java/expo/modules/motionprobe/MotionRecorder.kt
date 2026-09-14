package expo.modules.motionprobe

import android.app.Activity
import android.graphics.RectF
import android.os.Build
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import com.facebook.react.R
import com.facebook.react.uimanager.ReactOverflowView
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Android counterpart of the iOS recorder: on every Choreographer frame, reads the rendered state
 * of views tagged with a testID (RN stores it as the view tag). Values are converted to dp so both
 * platforms report the same units. Must be used from the main thread.
 */
class MotionRecorder : Choreographer.FrameCallback {
  companion object {
    val COLUMNS = listOf(
      "frame", "target", "present",
      "x", "y", "width", "height",
      "boundsWidth", "boundsHeight",
      "translateX", "translateY", "scaleX", "scaleY", "rotation",
      "opacity", "effectiveOpacity", "visibleRatio",
      "occludedRatio", "scrollX", "scrollY",
    )

    /** Upper bound of views inspected per target per frame when looking for occluders. */
    private const val OCCLUDER_BUDGET = 400
  }

  private var activity = WeakReference<Activity>(null)
  private var targets: List<String> = emptyList()
  private var views = mutableListOf<WeakReference<View>>()
  private var lastRows = mutableListOf<DoubleArray?>()
  private val frameTimes = ArrayList<Double>()
  private var drainedFrameCount = 0
  private var pendingSamples = ArrayList<List<Double>>()
  private var running = false
  private var frameIndex = 0
  private var startNanos = 0L
  private var lastFrameNanos = 0L
  private var nominalFrameMs = 0.0
  private var maxDurationMs = 15000.0
  private var resolveEveryFrames = 6
  private var occlusionGrid = 6
  private var endReason = ""
  private var density = 1f

  fun start(
    activity: Activity?,
    targets: List<String>,
    maxDurationMs: Double,
    resolveEveryFrames: Int,
    occlusionGrid: Int,
  ): Map<String, Any> {
    stopFrames()
    this.activity = WeakReference(activity)
    this.targets = targets
    this.maxDurationMs = maxDurationMs
    this.resolveEveryFrames = max(1, resolveEveryFrames)
    this.occlusionGrid = max(0, occlusionGrid)
    density = activity?.resources?.displayMetrics?.density ?: 1f
    views = targets.map { WeakReference<View>(null) }.toMutableList()
    lastRows = targets.map { null as DoubleArray? }.toMutableList()
    frameTimes.clear()
    drainedFrameCount = 0
    pendingSamples = ArrayList()
    frameIndex = 0
    lastFrameNanos = 0L
    endReason = ""

    val root = activity?.window?.decorView
    targets.forEachIndexed { i, id -> views[i] = WeakReference(root?.let { findView(it, id) }) }

    startNanos = System.nanoTime()
    running = true
    Choreographer.getInstance().postFrameCallback(this)

    return mapOf(
      "startedAt" to System.currentTimeMillis().toDouble(),
      "found" to targets.filterIndexed { i, _ -> views[i].get() != null },
      "missing" to targets.filterIndexed { i, _ -> views[i].get() == null },
    )
  }

  fun drain(): Map<String, Any> {
    val offset = drainedFrameCount
    val frames = ArrayList(frameTimes.subList(offset, frameTimes.size))
    drainedFrameCount = frameTimes.size
    val samples = pendingSamples
    pendingSamples = ArrayList()
    return mapOf(
      "frameOffset" to offset,
      "frameTimes" to frames,
      "samples" to samples,
      "running" to running,
      "endReason" to endReason,
      "nominalFrameMs" to nominalFrameMs,
    )
  }

  fun stop(reason: String): Map<String, Any> {
    if (running) endReason = reason
    stopFrames()
    return drain()
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!running) return
    val t = max(0.0, (frameTimeNanos - startNanos) / 1e6)
    if (lastFrameNanos != 0L) nominalFrameMs = (frameTimeNanos - lastFrameNanos) / 1e6
    lastFrameNanos = frameTimeNanos
    val frame = frameIndex++
    frameTimes.add(t)

    val root = activity.get()?.window?.decorView
    targets.forEachIndexed { i, id ->
      var view = views[i].get()
      if (view == null || !view.isAttachedToWindow || !matches(view, id)) {
        view = null
        val wasPresent = lastRows[i]?.get(2) == 1.0
        if (root != null && (wasPresent || frame % resolveEveryFrames == 0)) {
          view = findView(root, id)
          views[i] = WeakReference(view)
        }
      }

      val row = if (view != null) measure(view, frame, i) else absentRow(frame, i)
      val last = lastRows[i]
      if (last == null) {
        lastRows[i] = row
        if (row[2] == 1.0) pendingSamples.add(row.toList())
      } else if (hasChanged(last, row)) {
        pendingSamples.add(row.toList())
        lastRows[i] = row
      }
    }

    if (t >= maxDurationMs) {
      endReason = "maxDuration"
      stopFrames()
      return
    }
    Choreographer.getInstance().postFrameCallback(this)
  }

  private fun measure(view: View, frame: Int, target: Int): DoubleArray {
    val rootView = view.rootView
    // Map the view's bounds into root coordinates, applying every ancestor's transform matrix.
    val rect = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
    var effectiveOpacity = if (view.visibility == View.VISIBLE) view.alpha.toDouble() else 0.0
    val clip = RectF(0f, 0f, rootView.width.toFloat(), rootView.height.toFloat())
    var scrollX = 0.0
    var scrollY = 0.0

    var current: View = view
    while (current !== rootView) {
      current.matrix.mapRect(rect)
      rect.offset(current.left.toFloat(), current.top.toFloat())
      val parent = current.parent as? View ?: break
      rect.offset(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
      scrollX += parent.scrollX
      scrollY += parent.scrollY
      current = parent
      if (current !== rootView) {
        effectiveOpacity *= if (current.visibility == View.VISIBLE) current.alpha.toDouble() else 0.0
        if (clipsChildren(current)) clip.intersect(boundsInRoot(current, rootView))
      }
    }

    val area = rect.width() * rect.height()
    val visible = RectF(rect)
    val intersects = visible.intersect(clip)
    val hasVisibleArea = area > 0 && intersects && !visible.isEmpty
    val visibleRatio = if (hasVisibleArea) (visible.width() * visible.height() / area).toDouble() else 0.0
    val occluded = if (hasVisibleArea) occludedRatio(view, visible, rootView) else 0.0

    val d = density.toDouble()
    return doubleArrayOf(
      frame.toDouble(), target.toDouble(), 1.0,
      rect.left / d, rect.top / d, rect.width() / d, rect.height() / d,
      view.width / d, view.height / d,
      view.translationX / d, view.translationY / d, view.scaleX.toDouble(), view.scaleY.toDouble(), view.rotation.toDouble(),
      view.alpha.toDouble(), effectiveOpacity, min(1.0, visibleRatio),
      occluded, scrollX / d, scrollY / d,
    )
  }

  // Occlusion

  /**
   * Share of the visible rect covered by views painted after the target: siblings of the view or of
   * any ancestor that draw later (higher elevation, then later drawing position — RN maps zIndex onto
   * the drawing order). Views with a background or an image count as covers; the covered area is
   * estimated on an `occlusionGrid`² sample grid.
   */
  private fun occludedRatio(view: View, visible: RectF, rootView: View): Double {
    if (occlusionGrid <= 0) return 0.0
    val covers = ArrayList<RectF>()
    val budget = intArrayOf(OCCLUDER_BUDGET)
    var child: View = view
    var parent = child.parent as? ViewGroup
    while (parent != null) {
      val positions = drawingPositions(parent)
      val childIndex = parent.indexOfChild(child)
      for (i in 0 until parent.childCount) {
        if (i == childIndex) continue
        val sibling = parent.getChildAt(i)
        val paintedAfter = sibling.z > child.z || (sibling.z == child.z && positions[i] > positions[childIndex])
        if (paintedAfter) collectCovers(sibling, visible, rootView, covers, budget)
      }
      if (parent === rootView) break
      child = parent
      parent = parent.parent as? ViewGroup
    }
    if (covers.isEmpty()) return 0.0

    val n = occlusionGrid
    var covered = 0
    for (gy in 0 until n) {
      for (gx in 0 until n) {
        val x = visible.left + (gx + 0.5f) * visible.width() / n
        val y = visible.top + (gy + 0.5f) * visible.height() / n
        if (covers.any { it.contains(x, y) }) covered++
      }
    }
    return covered.toDouble() / (n * n)
  }

  /** Container index → drawing position (honors custom drawing order on API 29+). */
  private fun drawingPositions(parent: ViewGroup): IntArray {
    val positions = IntArray(parent.childCount) { it }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      for (position in 0 until parent.childCount) {
        val index = parent.getChildDrawingOrder(position)
        if (index in positions.indices) positions[index] = position
      }
    }
    return positions
  }

  private fun collectCovers(view: View, target: RectF, rootView: View, covers: MutableList<RectF>, budget: IntArray) {
    if (budget[0] <= 0 || view.visibility != View.VISIBLE || view.alpha < 0.01f) return
    budget[0]--
    val rect = boundsInRoot(view, rootView)
    val intersects = RectF.intersects(rect, target)
    val clips = clipsChildren(view)
    if (intersects && view.alpha >= 0.5f && paintsOpaqueContent(view)) {
      covers.add(RectF(rect).apply { intersect(target) })
      if (clips) return
    }
    if (clips && !intersects) return
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) collectCovers(view.getChildAt(i), target, rootView, covers, budget)
    }
  }

  private fun paintsOpaqueContent(view: View): Boolean {
    val background = view.background
    if (background != null && background.alpha >= 128) return true
    return view is ImageView && view.drawable != null
  }

  private fun boundsInRoot(view: View, rootView: View): RectF {
    val rect = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
    var current: View = view
    while (current !== rootView) {
      current.matrix.mapRect(rect)
      rect.offset(current.left.toFloat(), current.top.toFloat())
      val parent = current.parent as? View ?: break
      rect.offset(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
      current = parent
    }
    return rect
  }

  /** RN implements `overflow: hidden` itself (ReactOverflowView), not via ViewGroup.clipChildren. */
  private fun clipsChildren(view: View): Boolean {
    if (view.clipToOutline) return true
    val overflow = (view as? ReactOverflowView)?.overflow
    return overflow == "hidden" || overflow == "scroll"
  }

  /** BaseViewManager.setTestId stores the testID as a keyed tag (and, for now, as the plain tag). */
  private fun matches(view: View, id: String): Boolean =
    view.getTag(R.id.react_test_id) == id || view.tag == id

  private fun findView(root: View, id: String): View? {
    val stack = ArrayDeque<View>()
    stack.add(root)
    while (stack.isNotEmpty()) {
      val view = stack.removeLast()
      if (matches(view, id)) return view
      if (view is ViewGroup) for (i in view.childCount - 1 downTo 0) stack.add(view.getChildAt(i))
    }
    return null
  }

  private fun absentRow(frame: Int, target: Int) =
    DoubleArray(COLUMNS.size).also {
      it[0] = frame.toDouble()
      it[1] = target.toDouble()
    }

  private fun hasChanged(a: DoubleArray, b: DoubleArray): Boolean {
    for (i in 2 until a.size) if (abs(a[i] - b[i]) > 0.001) return true
    return false
  }

  private fun stopFrames() {
    if (running) Choreographer.getInstance().removeFrameCallback(this)
    running = false
  }
}
