import ExpoModulesCore
import UIKit

struct StartOptions: Record {
  @Field var maxDurationMs: Double = 15000
  @Field var resolveEveryFrames: Int = 6
  /// Sample grid size for occlusion (n × n points); 0 disables occlusion detection.
  @Field var occlusionGrid: Int = 6
}

public final class MotionProbeModule: Module {
  private let recorder = MotionRecorder()

  public func definition() -> ModuleDefinition {
    Name("MotionProbe")

    AsyncFunction("getInfo") { () -> [String: Any] in
      return [
        "platform": "ios",
        "columns": MotionRecorder.columns,
        "osVersion": UIDevice.current.systemVersion,
        "deviceName": UIDevice.current.name,
        "maximumFramesPerSecond": UIScreen.main.maximumFramesPerSecond,
      ]
    }.runOnQueue(.main)

    AsyncFunction("start") { (targets: [String], options: StartOptions) -> [String: Any] in
      return self.recorder.start(
        targets: targets,
        maxDurationMs: options.maxDurationMs,
        resolveEveryFrames: options.resolveEveryFrames,
        occlusionGrid: options.occlusionGrid
      )
    }.runOnQueue(.main)

    AsyncFunction("drain") { () -> [String: Any] in
      return self.recorder.drain()
    }.runOnQueue(.main)

    AsyncFunction("stop") { (reason: String) -> [String: Any] in
      return self.recorder.stop(reason: reason)
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async { [recorder] in
        _ = recorder.stop(reason: "cancelled")
      }
    }
  }
}
