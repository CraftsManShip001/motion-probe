package expo.modules.motionprobe

import android.app.Activity
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.ImageView
import com.facebook.react.R
import com.facebook.react.uimanager.BackgroundStyleApplicator
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
      "occludedRatio", "scrollX", "scrollY", "contentOpacity",
    )

    /** Upper bound of views inspected per target per frame when looking for occluders. */
    private const val OCCLUDER_BUDGET = 400

    /** Upper bound of descendants inspected per target per frame for content opacity. */
    private const val CONTENT_BUDGET = 200
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
  private var resolveEveryFrames = 1
  private var occlusionGrid = 6
  private var endReason = ""
  private var density = 1f

  /** Touch sequences as [startMs, endMs (-1 while down), farthest distance from touch-down in dp]. */
  private val touches = ArrayList<DoubleArray>()
  private val touchOrigins = HashMap<Int, Pair<Float, Float>>()
  private var touchWindow: Window? = null

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
    touches.clear()
    touchOrigins.clear()
    activity?.window?.let { window ->
      val callback = window.callback ?: return@let
      window.callback = TouchObserver(callback, ::onTouch)
      touchWindow = window
    }

    val root = activity?.window?.decorView
    targets.forEachIndexed { i, id -> views[i] = WeakReference<View>(root?.let { findView(it, id) }) }

    startNanos = System.nanoTime()
    running = true
    // Sample once right away: the interaction may start before the next display frame.
    sample(0.0)
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
      "touches" to touches.map { it.toList() },
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
    sample(t)

    if (t >= maxDurationMs) {
      endReason = "maxDuration"
      stopFrames()
      return
    }
    Choreographer.getInstance().postFrameCallback(this)
  }

  /** Records one frame: looks up targets that are not on screen and appends the rows that changed. */
  private fun sample(t: Double) {
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

      val row = if (view != null && !hasPendingAnimation(view)) measure(view, frame, i) else absentRow(frame, i)
      val last = lastRows[i]
      if (last == null) {
        lastRows[i] = row
        if (row[2] == 1.0) pendingSamples.add(row.toList())
      } else if (hasChanged(last, row)) {
        pendingSamples.add(row.toList())
        lastRows[i] = row
      }
    }
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
      effectiveOpacity *= mapToParent(current, rect)
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
      occluded, scrollX / d, scrollY / d, contentOpacity(view, RectF(rect).apply { inset(-1f, -1f) }, rootView),
    )
  }

  // Content

  /**
   * Opacity of what the view draws inside itself, relative to the view: its own image and its
   * descendants' images, text and backgrounds, composited as overlapping layers (1 − Π(1 − alpha)).
   * The view's own background is not content, so an image fading in over a placeholder color counts.
   * Image libraries fade images in by animating a child ImageView's alpha (expo-image, Glide targets).
   */
  private fun contentOpacity(view: View, own: RectF, rootView: View): Double {
    val budget = intArrayOf(CONTENT_BUDGET)
    var clear = 1.0
    fun visit(v: View, inherited: Double, isTarget: Boolean) {
      if (budget[0] <= 0 || clear <= 0.001 || v.visibility != View.VISIBLE) return
      budget[0]--
      val alpha = if (isTarget) 1.0 else inherited * v.alpha
      if (alpha < 0.001) return
      if (drawsContent(v, withBackground = !isTarget)) clear *= 1 - alpha
      if (v is ViewGroup) for (i in 0 until v.childCount) visit(v.getChildAt(i), alpha, false)
    }
    visit(view, 1.0, true)
    // Fabric mounts the children of a view that does not form a stacking context as later siblings of
    // it (view flattening): what lies inside the view and draws after it is its content too.
    val parent = view.parent as? ViewGroup
    if (parent != null) {
      val positions = drawingPositions(parent)
      val index = parent.indexOfChild(view)
      for (i in 0 until parent.childCount) {
        val sibling = parent.getChildAt(i)
        val paintedAfter = sibling.z > view.z || (sibling.z == view.z && positions[i] > positions[index])
        if (i != index && paintedAfter && own.contains(boundsInRoot(sibling, rootView))) visit(sibling, 1.0, false)
      }
    }
    return 1 - clear
  }

  /** Backgrounds, loaded images, and leaf views that draw themselves (text, custom drawing). */
  private fun drawsContent(view: View, withBackground: Boolean): Boolean {
    if (withBackground && paintsOpaqueContent(view)) return true
    return when (view) {
      is ImageView -> view.drawable != null
      is ViewGroup -> false
      else -> view.width > 0 && view.height > 0
    }
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
    // Fabric can mount a view's children as later siblings (view flattening), so anything lying
    // entirely inside the target is its own content, not something covering it.
    val own = boundsInRoot(view, rootView).apply { inset(-1f, -1f) }
    var child: View = view
    var parent = child.parent as? ViewGroup
    while (parent != null) {
      val positions = drawingPositions(parent)
      val childIndex = parent.indexOfChild(child)
      for (i in 0 until parent.childCount) {
        if (i == childIndex) continue
        val sibling = parent.getChildAt(i)
        val paintedAfter = sibling.z > child.z || (sibling.z == child.z && positions[i] > positions[childIndex])
        if (paintedAfter) collectCovers(sibling, visible, own, rootView, covers, budget)
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

  private fun collectCovers(view: View, target: RectF, own: RectF, rootView: View, covers: MutableList<RectF>, budget: IntArray) {
    if (budget[0] <= 0 || view.visibility != View.VISIBLE || view.alpha < 0.01f) return
    budget[0]--
    val rect = boundsInRoot(view, rootView)
    val intersects = RectF.intersects(rect, target)
    val clips = clipsChildren(view)
    if (intersects && !own.contains(rect) && view.alpha >= 0.5f && paintsOpaqueContent(view)) {
      covers.add(RectF(rect).apply { intersect(target) })
      if (clips) return
    }
    if (clips && !intersects) return
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) collectCovers(view.getChildAt(i), target, own, rootView, covers, budget)
    }
  }

  private fun paintsOpaqueContent(view: View): Boolean {
    val background = view.background
    if (background != null && background.alpha >= 128) {
      val opaque = when {
        // RN keeps backgrounds, borders and radii in one layer drawable whose alpha is 255 even
        // without a background color (a view with only a borderRadius paints nothing).
        background.javaClass.name.endsWith(".CompositeBackgroundDrawable") ->
          BackgroundStyleApplicator.getBackgroundColor(view)?.let { Color.alpha(it) >= 128 } ?: false
        background is ColorDrawable -> Color.alpha(background.color) >= 128
        else -> true
      }
      if (opaque) return true
    }
    return view is ImageView && view.drawable != null
  }

  /**
   * Maps a rect from `view`'s coordinates into its parent's the way View.draw does: the view's own
   * transform, then a running legacy view animation, then its position. Legacy animations
   * (android.view.animation, used for fragment and native-stack screen transitions) transform the view
   * at draw time without touching its properties, so they have to be applied explicitly.
   * Returns the animation's alpha (1 without one).
   */
  private fun mapToParent(view: View, rect: RectF): Float {
    view.matrix.mapRect(rect)
    var alpha = 1f
    val animation = view.animation
    if (animation != null && animation.hasStarted() && !animation.hasEnded()) {
      val transformation = android.view.animation.Transformation()
      animation.getTransformation(view.drawingTime, transformation)
      val type = transformation.transformationType
      if (type and android.view.animation.Transformation.TYPE_MATRIX != 0) transformation.matrix.mapRect(rect)
      if (type and android.view.animation.Transformation.TYPE_ALPHA != 0) alpha = transformation.alpha
    }
    rect.offset(view.left.toFloat(), view.top.toFloat())
    return alpha
  }

  /**
   * A legacy animation that is scheduled but not drawn yet (a screen that was just pushed) starts at
   * the next draw, so this frame shows its first animation frame, not the untransformed view. Treat the
   * view as not on screen until then instead of recording a position it never had.
   */
  private fun hasPendingAnimation(view: View): Boolean {
    var current: View? = view
    while (current != null) {
      val animation = current.animation
      if (animation != null && !animation.hasStarted()) return true
      current = current.parent as? View
    }
    return false
  }

  private fun boundsInRoot(view: View, rootView: View): RectF {
    val rect = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
    var current: View = view
    while (current !== rootView) {
      mapToParent(current, rect)
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
    // Restore the window callback unless something wrapped it after us (ours then just forwards).
    touchWindow?.let { window ->
      (window.callback as? TouchObserver)?.let { window.callback = it.delegate }
    }
    touchWindow = null
  }

  // Touches

  /** Notes when fingers are down and how far they moved; times share the Choreographer's clock. */
  private fun onTouch(event: MotionEvent) {
    if (!running) return
    val t = max(0.0, (event.eventTime * 1_000_000L - startNanos) / 1e6)
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        touchOrigins.clear()
        touches.add(doubleArrayOf(t, -1.0, 0.0))
      }
      MotionEvent.ACTION_MOVE -> {
        val current = touches.lastOrNull()?.takeIf { it[1] < 0 } ?: return
        for (i in 0 until event.pointerCount) {
          val origin = touchOrigins[event.getPointerId(i)] ?: continue
          val distance = Math.hypot((event.getX(i) - origin.first).toDouble(), (event.getY(i) - origin.second).toDouble())
          current[2] = max(current[2], distance / density)
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> touches.lastOrNull()?.takeIf { it[1] < 0 }?.set(1, t)
    }
    if (event.actionMasked == MotionEvent.ACTION_DOWN || event.actionMasked == MotionEvent.ACTION_POINTER_DOWN) {
      touchOrigins[event.getPointerId(event.actionIndex)] = event.getX(event.actionIndex) to event.getY(event.actionIndex)
    }
  }

  /** Sees every touch the window dispatches without consuming or changing any. */
  private class TouchObserver(val delegate: Window.Callback, val onTouch: (MotionEvent) -> Unit) :
    Window.Callback by delegate {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
      onTouch(event)
      return delegate.dispatchTouchEvent(event)
    }
  }
}
