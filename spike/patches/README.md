# spike/patches

finetune-probe.patch.raw — FineTune@main(codeload main tar) 的对照实测补丁全集（diff -u 原树→spike 树）：
1. `SpikeBundleGuard.swift` 新增：裸可执行下 UNUserNotificationCenter.current() 会 trap（bundleProxy nil），通知面 bundle 守卫。
2. `FineTuneApp.swift`：`GP.start(appName:"FineTune")` + `GP.registerMirrorRoot(label:"settings", object: settings)`。
3. `Models/VolumeState.swift`：`setVolume` 头部 `GP.recordHandler()` + `GP.recordState(volume.<pid>)`（Z1 手动形态，H7 opt-in 口径）。
4. `Audio/Engine/AudioEngine.swift`：通知 add 调用点走守卫。
构建壳 Package.swift 不在补丁内（spike 工程形态，见 results.md H1 记录）。上游语义零改动、未上传。
