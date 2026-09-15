import Foundation
import ApplicationServices
import GlassPaneEngine

/// glasspaned — the P0 engine daemon. Serves the v0 local-socket protocol
/// (P0 spec §3) on a Unix domain socket with 0600 permissions.
///
/// Usage:
///   glasspaned [--socket-path <path>] [--verbose]
///   glasspaned --grant-accessibility
///   glasspaned --help

private struct Options {
    var socketPath: String?
    var verbose = false
    var grantAccessibility = false
}

private enum ParseResult {
    case parsed(Options)
    case help
    case error(String)
}

private func parseArguments(_ arguments: [String]) -> ParseResult {
    var options = Options()
    var index = 1
    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--help", "-h":
            return .help
        case "--verbose", "-v":
            options.verbose = true
        case "--grant-accessibility":
            options.grantAccessibility = true
        case "--socket-path":
            guard index + 1 < arguments.count else {
                return .error("--socket-path requires a value")
            }
            index += 1
            options.socketPath = arguments[index]
        default:
            if argument.hasPrefix("--socket-path=") {
                let value = String(argument.dropFirst("--socket-path=".count))
                guard !value.isEmpty else {
                    return .error("--socket-path requires a value")
                }
                options.socketPath = value
            } else {
                return .error("unknown argument: \(argument)")
            }
        }
        index += 1
    }
    return .parsed(options)
}

private func printUsage() {
    let usage = """
    glasspaned — GlassPane P0 engine daemon

    USAGE:
        glasspaned [--socket-path <path>] [--verbose]
        glasspaned --grant-accessibility

    OPTIONS:
        --socket-path <path>   Unix socket path (default: ~/.glasspane/engine.sock)
        --verbose             Log frames and state transitions to stderr
        --grant-accessibility  Onboarding: prompt for accessibility permission
        --help, -h            Show this help

    PROTOCOL:
        Newline-delimited JSON over the socket; see specs/GlassPane_P0_实施规格_v1.0.md §3.

    """
    FileHandle.standardOutput.write(Data(usage.utf8))
}

private func defaultSocketPath() -> String {
    NSHomeDirectory() + "/.glasspane/engine.sock"
}

// MARK: - Onboarding (R36: permission guidance)

private func runGrantAccessibilityFlow() {
    if AXIsProcessTrusted() {
        print("accessibility permission already granted — the daemon is ready to attach.")
        return
    }
    // Show the system prompt anchored to this process, and open the pane.
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let promptOptions = [promptKey: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(promptOptions)
    openPrivacyPane()
    print("Waiting for accessibility permission (System Settings > Privacy & Security > Accessibility)...")
    print("Enable the entry for the terminal running glasspaned, then switch back here.")
    let pollIntervalSeconds: UInt32 = 1
    let timeoutSeconds = 300
    var waited = 0
    while waited < timeoutSeconds {
        if AXIsProcessTrusted() {
            print("Accessibility permission granted — the daemon is ready to attach.")
            return
        }
        sleep(pollIntervalSeconds)
        waited += Int(pollIntervalSeconds)
    }
    print("Timed out after \(timeoutSeconds)s waiting for accessibility permission.")
    print("Re-run: glasspaned --grant-accessibility  (the daemon requires this permission to observe and drive apps.)")
    exit(1)
}

private func openPrivacyPane() {
    let paneURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = [paneURL]
    do {
        try process.run()
    } catch {
        // Opening the pane is best-effort; the system prompt above is the
        // primary path.
    }
}

// MARK: - Signals

private func installSignalHandlers(_ server: SocketServer) {
    for signalNumber in [SIGINT, SIGTERM] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            server.cleanup()
            exit(0)
        }
        source.resume()
    }
}

// MARK: - Entry

private let parseResult = parseArguments(CommandLine.arguments)
private let options: Options
switch parseResult {
case .help:
    printUsage()
    exit(0)
case .error(let message):
    FileHandle.standardError.write(Data("glasspaned: \(message)\n".utf8))
    printUsage()
    exit(64)
case .parsed(let parsed):
    options = parsed
}

if options.grantAccessibility {
    runGrantAccessibilityFlow()
    exit(0)
}

let socketPath = options.socketPath ?? defaultSocketPath()
let log = EngineLog(quiet: !options.verbose)
let channel = AXChannel()
let core = EngineCore(channel: channel)
let dispatcher = Dispatcher(core: core, log: log)
let server = SocketServer(socketPath: socketPath, dispatcher: dispatcher, log: log)
installSignalHandlers(server)

FileHandle.standardOutput.write(
    Data("glasspaned \(core.version) listening on \(socketPath)\n".utf8)
)

do {
    try server.run()
    exit(0)
} catch {
    log.error("fatal: \(error)")
    server.cleanup()
    exit(1)
}
