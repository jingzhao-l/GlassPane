import Foundation

// MARK: - State root (X-22: the one named entry for every mutable location)

/// The single directory a `glasspaned` process keeps its mutable state in, and
/// the **only** place that spells out what is inside it:
///
/// ```
/// <root>/evidence/     EvidenceStore archive (one pack per operation)
/// <root>/projects.json ProjectRegistry table
/// <root>/approvals.json ApprovalGate hash chain
/// <root>/probe.sock    default P6 probe listener
/// <root>/daemon.sock   engine socket of a daemon whose root was injected
/// ```
///
/// This type exists because the alternative — each state object composing
/// `NSHomeDirectory() + "/.glasspane"…` on its own — has already cost this
/// project data twice over. On macOS `NSHomeDirectory()` does **not** honour a
/// `HOME` override set by the caller, so "point HOME at a sandbox" does not
/// move any of those locations: a `swift test` run rewrote the developer's
/// real `projects.json` (71 registrations down to 2 synthetic ones,
/// unrecoverable) while every path in the suite looked sandboxed. The fix has
/// to be an *argument* a caller passes, not an environment variable it hopes
/// is read, and every derived location has to come from one value so a
/// subcommand cannot quietly resolve its own.
///
/// Deliberately a value type with no filesystem access: constructing one reads
/// and writes nothing.
public struct StateRoot: Equatable {

    /// Name of the per-user state folder under the home directory. Spelled
    /// here once so no other file in the module composes it again.
    static let folderName = ".glasspane"

    /// Canonical root path: absolute, with no trailing slash (the filesystem
    /// root "/" aside), so `<root>/<name>` joins the same way everywhere.
    public let path: String

    /// An injected root as named on the command line. Nothing on this path
    /// checks the filesystem: the daemon reports where it resolved state, it
    /// does not silently create, chmod or migrate anything.
    public init(path: String) {
        self.path = StateRoot.canonical(path)
    }

    /// The per-user state root — what every one of these locations meant
    /// before this type existed, and what they still mean when `--state-dir`
    /// was not given.
    ///
    /// A function and not a constant on purpose: the home lookup is a process
    /// property that a caller cannot influence (`HOME` is not consulted), so
    /// the one line that says "no root was named" has to be visible at every
    /// place that uses it.
    public static func homeDefault() -> StateRoot {
        StateRoot(path: NSHomeDirectory() + "/" + folderName)
    }

    // MARK: - Derived locations

    /// The evidence archive directory. Carries the trailing slash the store
    /// has always been given, so the value is byte-identical to the one
    /// `EvidenceStore` published before this type existed.
    public var evidenceDirectory: String { child("evidence") + "/" }

    /// The project registry table.
    public var projectsFile: String { child("projects.json") }

    /// The approval hash chain.
    public var approvalsFile: String { child("approvals.json") }

    /// Default probe listener path (`--probe-socket-path` overrides it).
    public var probeSocketFile: String { child("probe.sock") }

    /// Engine socket of a daemon that **named** its state root. A daemon that
    /// named none keeps the historic `engine.sock` name — see
    /// `engineSocketPath(explicitSocketPath:stateRoot:)`, which is the single
    /// place that rule is written down.
    public var daemonSocketFile: String { child("daemon.sock") }

    /// Where the engine protocol socket is, given what the caller passed.
    /// One implementation shared by `glasspaned` and the settings panel, so
    /// the panel cannot point itself at a different daemon than the daemon
    /// points itself at.
    ///
    /// Precedence is the ordinary one: an explicit `--socket-path` wins, then
    /// the socket that belongs to a named state root, then the historic
    /// home-derived default (whose leaf name stays `engine.sock` — this
    /// function does not rename the socket of an existing installation).
    public static func engineSocketPath(
        explicitSocketPath: String?, stateRoot: StateRoot?
    ) -> String {
        if let explicitSocketPath { return explicitSocketPath }
        if let stateRoot { return stateRoot.daemonSocketFile }
        return homeDefault().child("engine.sock")
    }

    /// `<root>/<name>` without ever producing a doubled slash.
    private func child(_ name: String) -> String {
        path.hasSuffix("/") ? path + name : path + "/" + name
    }

    /// Drops redundant trailing slashes so `/tmp/x/` and `/tmp/x` are the same
    /// root (and `Equatable` says so). Symlinks, `..` and the home-vs-`$HOME`
    /// question are **not** resolved here: the smoke gates compare paths with
    /// `realpath` after asking the daemon what it used, which keeps this
    /// function pure and the measurement honest.
    private static func canonical(_ raw: String) -> String {
        guard raw.count > 1 else { return raw }
        var end = raw.endIndex
        while end > raw.startIndex, raw[raw.index(before: end)] == "/" {
            end = raw.index(before: end)
        }
        // "/" itself: every character was a slash, so keep the one.
        return end == raw.startIndex ? "/" : String(raw[..<end])
    }
}

// MARK: - Command-line shape

/// The verdict on a `--state-dir` argument, as one pure function so the
/// refusing branch is executable in a test (`glasspaned`'s own
/// `parseArguments` is top-level code in an executable target and cannot be
/// imported). `main.swift` maps `.rejected` onto its existing usage-error
/// route: message to stderr, usage printed, exit 64.
public enum StateRootArgument: Equatable {

    /// A usable root.
    case named(StateRoot)

    /// Why this argument is not a root, phrased to follow the flag name.
    case rejected(String)

    /// The whole rule set lives in `classify`, so the verdict and the reason
    /// it reports cannot drift apart.
    private enum Outcome {
        case usable(String)
        case refused(String)
    }

    /// `raw` is the token that followed the flag, or `nil` when nothing did.
    public init(raw: String?) {
        switch StateRootArgument.classify(raw) {
        case .usable(let value):
            self = .named(StateRoot(path: value))
        case .refused(let reason):
            self = .rejected(reason)
        }
    }

    /// Why `raw` cannot name a state root, or nil when it can. Exposed for the
    /// test suite; `main.swift` only needs the message, which it gets from
    /// `.rejected(reason)`.
    public static func rejection(for raw: String?) -> String? {
        guard case .refused(let reason) = classify(raw) else { return nil }
        return reason
    }

    /// Refusal shape follows `--probe-socket-path` (a value that is another
    /// flag is not a value), plus the one extra rule this argument needs: a
    /// relative path would mean a different state root depending on the
    /// working directory the daemon happened to be started in, which is the
    /// opposite of naming where your state lives. An empty value is refused
    /// before the absolute-path rule because its message would be useless.
    private static func classify(_ raw: String?) -> Outcome {
        guard let raw else {
            return .refused("requires a path (nothing followed the flag)")
        }
        guard !raw.hasPrefix("--") else {
            return .refused("requires a path, got what looks like another argument (\(raw))")
        }
        guard !raw.isEmpty else {
            return .refused("requires a path, got an empty string")
        }
        guard raw.hasPrefix("/") else {
            return .refused("must be an absolute path, got \(raw)")
        }
        return .usable(raw)
    }
}
