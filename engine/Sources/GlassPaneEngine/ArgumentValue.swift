import Foundation

/// 取值旗标的"下一个 token 算不算值"判据，收在一处。
///
/// 为什么需要这一处：`--state-dir` / `--socket-path` / `--probe-socket-path` 三个走
/// `StateRootArgument.rejection`，那里第一条规则就是"a token that is another flag is
/// not a value"。其余六个取值旗标（`--request-permission`、`--active-project`、
/// `--project-remove`、`--recipe-validate`、`--older-than`、`--project`）从前是裸的
/// `arguments[index + 1]`，于是 `glasspaned --state-dir X --project-remove --dry-run`
/// 把 `--dry-run` 当成项目 id 吃掉：答"no project --dry-run is registered"（退出码 3，
/// 一次运行期的拒绝而不是用法错），而 `--dry-run` 这一辈子没被执行过——旗标被吞掉之后
/// 连"读过它"的读者都找不到。同一个失败类在三面旗上给两种答案，正是本文件前面几轮反复
/// 收口的那件事。
public enum ArgumentValue: Equatable {

    /// 后面那个 token 可以当值。
    case value(String)

    /// 旗标是命令行的最后一个 token，后面什么都没有。
    case nothingFollows

    /// 后面那个 token 自己是一个旗标：它不是值。
    case anotherArgument(String)

    /// `arguments[index]` 就是这面旗；只看它后面那一个 token。
    public static func follow(_ arguments: [String], after index: Int) -> ArgumentValue {
        guard index + 1 < arguments.count else { return .nothingFollows }
        let next = arguments[index + 1]
        guard !next.hasPrefix("--") else { return .anotherArgument(next) }
        return .value(next)
    }

    /// 用法错的句子，沿用 `glasspaned` 既有那一句的语法：`<flag> requires <thing>`，
    /// 后面那个 token 是旗标时把它原样点名——调用方看这一句就知道自己少写了值，
    /// 而不是看见一个把旗标当值的运行期代号。
    public static func usageError(flag: String, expects: String, value: ArgumentValue) -> String? {
        switch value {
        case .value:
            return nil
        case .nothingFollows:
            return "\(flag) requires \(expects)"
        case .anotherArgument(let token):
            return "\(flag) requires \(expects), got what looks like another argument (\(token))"
        }
    }
}
