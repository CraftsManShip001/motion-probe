package expo.modules.motionprobe

import android.os.Build
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class StartOptions : Record {
  @Field
  val maxDurationMs: Double = 15000.0

  @Field
  val resolveEveryFrames: Int = 6

  /** Sample grid size for occlusion (n × n points); 0 disables occlusion detection. */
  @Field
  val occlusionGrid: Int = 6
}

class MotionProbeModule : Module() {
  private val recorder = MotionRecorder()

  override fun definition() = ModuleDefinition {
    Name("MotionProbe")

    AsyncFunction("getInfo") {
      return@AsyncFunction mapOf(
        "platform" to "android",
        "columns" to MotionRecorder.COLUMNS,
        "osVersion" to Build.VERSION.RELEASE,
        "deviceName" to Build.MODEL,
      )
    }

    AsyncFunction("start") { targets: List<String>, options: StartOptions ->
      return@AsyncFunction recorder.start(
        appContext.currentActivity,
        targets,
        options.maxDurationMs,
        options.resolveEveryFrames,
        options.occlusionGrid,
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("drain") {
      return@AsyncFunction recorder.drain()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") { reason: String ->
      return@AsyncFunction recorder.stop(reason)
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      recorder.stop("cancelled")
    }
  }
}
