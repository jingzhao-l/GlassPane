import SwiftUI
import GlassPaneEngine
import Darwin  // open/write/close/unlink + S_IRUSR/S_IWUSR + O_EXCL/O_NOFOLLOW（临时文件独占创建）

/// 配方页（控制台「配方」tab）：面向内核 recipe 契约的只读结构浏览 + 模板 + 校验。
///
/// 三块能力的分工：
///  1. **结构浏览器**：以 `kernel/schemas/recipe-config.schema.json` 为只读真源。
///     运行时尝试读该文件（字段随真源），读不到则展示与它一致的**内置快照**
///     并如实标注来源（"内置快照"），绝不假装读到了盘上的文件。
///  2. **模板**：内置两条最小合法 recipe（均能通过 daemon `--recipe-validate`），
///     一键加载为编辑起点。
///  3. **编辑器 + 校验**：TextEditor 编辑 JSON；先做客户端 JSON 可解析性检查，
///     再经 daemon `--recipe-validate` 出结论。daemon 不可达/超时/输出异常一律
///     显式显示，吞掉任何一步都不被允许。
///
/// 只读边界：编辑内容只落在 @AppStorage（面板 UserDefaults）与临时文件，从不写
/// projects.json / evidence，也不写平台目录。
struct RecipesTabView: View {
    @EnvironmentObject private var console: ConsoleModel

    @AppStorage("glasspane.recipeEditor") private var editorText = RecipeTemplates.emptyEditorSlot

    /// 校验结论（nil = 还没点过校验）。
    @State private var outcome: RecipeValidationOutcome?
    @State private var isValidating = false
    /// 每次校验分配递增序号（token）：后台完成时仅当 token 仍最新才写 outcome，
    /// 保证显示的结论一定对应当前编辑器内容，不被旧校验覆盖。
    @State private var validationToken = 0

    enum RecipeValidationOutcome: Equatable {
        case idle
        /// 客户端 JSON 解析失败：直接报"不是合法 JSON"，不进 daemon。
        case notJSON(String)
        /// 读不到 daemon 程序路径（还没连上后台服务）。
        case noDaemon
        /// 临时文件写入失败。
        case writeFailed
        /// daemon 给出了明确结论。
        case verdict(valid: Bool, recipeName: String?, errors: [String])
        /// daemon **回了话**，却没把结论交出来：它读不到那个文件（stderr + 退出码 2），
        /// 或结论编码不出去（stderr + 退出码 1），或回了一段读不出形状的文本。
        /// 这一支必须与下面那一支分开——它的原话是事实，"它没在说话"是另一件事实。
        case daemonRefused(reason: String, exitCode: Int32)
        /// 一次回话都没拿到：起不来 / 超时 / 两路管道都读不出。
        case daemonUnavailable
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
                schemaCard
                templatesCard
                editorCard
            }
            .panelColumn()
        }
        .toolbar { toolbarContent }
    }

    // MARK: - 结构浏览器

    private var schemaCard: some View {
        let overview = RecipeSchemaLoader.load()
        return VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "字段结构",
                subtitle: RecipeSchemaLoader.subtitle(for: overview),
                systemImage: "doc.badge.gearshape"
            )
            HStack(spacing: 6) {
                ChipView(text: "schema \(overview.schemaVersion ?? "-")", color: .secondary)
                ChipView(text: overview.source, color: .orange, systemImage: "person.crop.circle.badge.questionmark")
            }
            Text(RecipeSchemaLoader.userFacingSummary(for: overview))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let required = overview.required {
                Text("必填：\(required.joined(separator: "、"))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(overview.fields) { field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.name)
                        .font(.caption.monospaced().weight(.semibold))
                        .frame(width: 104, alignment: .leading)
                    Text(field.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Text(overview.raw)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(ConsoleTheme.insetBackground.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .consoleCard()
    }

    // MARK: - 模板

    private var templatesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "模板", subtitle: "内置最小合法配方，可加载为起点", systemImage: "square.grid.2x2")
            HStack(spacing: 8) {
                ForEach(RecipeTemplates.all) { template in
                    Button {
                        editorText = template.contents
                        outcome = .idle
                    } label: {
                        Label(template.title, systemImage: "plus.circle")
                            .font(.callout)
                    }
                    .help("把模板文本加载进编辑器")
                    .disabled(isValidating)
                    .accessibilityIdentifier("gp-recipe-template-\(template.key)")
                }
                Spacer()
            }
        }
        .consoleCard()
    }

    // MARK: - 编辑器 + 校验

    private var editorCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "Recipe JSON 编辑器",
                subtitle: "仅校验，不持久化到项目/平台目录",
                systemImage: "square.and.pencil"
            )
            TextEditor(text: $editorText)
                .font(.system(size: 12, design: .monospaced))
                .frame(minHeight: 220)
                .scrollContentBackground(.hidden)
                .background(ConsoleTheme.insetBackground.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(ConsoleTheme.cardStroke, lineWidth: 1)
                )
                .accessibilityIdentifier("gp-recipe-editor")

            HStack(spacing: 8) {
                Button {
                    validate()
                } label: {
                    Label(isValidating ? "校验中……" : "校验", systemImage: "checkmark.shield")
                }
                .disabled(isValidating)
                .accessibilityIdentifier("gp-recipe-validate")

                Button {
                    editorText = ""
                    outcome = .idle
                } label: {
                    Label("清空", systemImage: "trash")
                }
                .help("把编辑器里的文本清成空白（不落盘、不动项目）")
                .disabled(isValidating)

                Spacer()
            }

            // 禁用态自己上屏：这一排三枚按钮在校验中都会变灰，而 `.help` 说的是启用时
            // 做什么。与项目页 `gp-prune-in-flight` 同一条规矩——按钮禁用理由与下一步都要
            // 看得见，不是等人把鼠标停上去猜。
            if isValidating {
                HStack(spacing: 5) {
                    ProgressView().controlSize(.small)
                    Text("校验中：这一趟还没回话，模板、清空与重新校验都要等它回话后再点")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("gp-recipe-in-flight")
                }
            }

            outcomeView
        }
        .consoleCard()
    }

    @ViewBuilder
    private var outcomeView: some View {
        switch outcome {
        case .idle, nil:
            Text("点「校验」后，结论会显示在这里；daemon 说非法就显示非法与原因。")
                .font(.caption)
                .foregroundStyle(.tertiary)
        case .notJSON(let error):
            verdictBanner(icon: "exclamationmark.triangle.fill", tint: .red, title: "不是合法 JSON",
                          body: error)
        case .noDaemon:
            verdictBanner(icon: "questionmark.circle", tint: .orange,
                          title: "后台服务不可达",
                          body: "读不到后台服务的程序路径，无法调用它校验，也不能代它判定。点侧栏底部的「刷新」恢复连接后重试。")
        case .writeFailed:
            verdictBanner(icon: "exclamationmark.triangle.fill", tint: .orange,
                          title: "写临时文件失败", body: "无法把内容落盘给 daemon 读取，未校验。")
        case .daemonUnavailable:
            verdictBanner(icon: "questionmark.circle", tint: .orange,
                          title: "未测得",
                          body: "这一趟没拿到后台服务的任何回话：它没在跑、起不来，或没在时限内回话。"
                              + "不把超时包装成结论。点侧栏底部的「刷新」恢复连接后再点一次「校验」。")
        case .daemonRefused(let reason, let exitCode):
            // 后台服务答了话、却把结论拒了回来：这一屏说的是**它的原话**，
            // 不是"它不可达"——那是另一件没发生过的事。
            verdictBanner(icon: "exclamationmark.triangle.fill", tint: .orange,
                          title: "后台服务答了话，但没给出结论",
                          body: "退出码 \(exitCode)。" + ConsoleModel.quoteDaemonWords(reason)
                            + " 这不是配方非法：按它自己报的退出码，这一趟没走到校验那一步。"
                            + "下一步：点侧栏底部的「刷新」确认它在跑，再点一次「校验」；"
                            + "一直如此就把编辑器里的内容另存成文件，"
                            + "用后台服务的命令行 --recipe-validate <路径> 跑一次看它说什么。")
        case .verdict(let valid, let recipeName, let errors):
            if valid {
                verdictBanner(icon: "checkmark.seal.fill", tint: .green,
                              title: recipeName.map { "合法（\($0)）" } ?? "合法",
                              body: "daemon 校验通过。")
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    verdictBanner(icon: "xmark.circle.fill", tint: .red, title: "非法",
                                  body: recipeName.map { "配方名：\($0)" } ?? "daemon 判定配方不符合契约。")
                    if !errors.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(errors.enumerated()), id: \.offset) { _, error in
                                HStack(alignment: .top, spacing: 6) {
                                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                                    Text(error)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        .padding(8)
                        .background(Color.red.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            }
        }
    }

    private func verdictBanner(icon: String, tint: Color, title: String, body: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.callout).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(tint)
                Text(body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - 校验动作

    private func validate() {
        guard !isValidating else { return }
        isValidating = true
        outcome = .idle
        // 分配新 token：本次校验唯一标识。（非 &+ 也不溢出——开关顺序由 MainActor 保证。）
        validationToken += 1
        let token = validationToken

        // 0) 客户端先做 JSON 可解析性检查：解析失败直接报"不是合法 JSON"。
        let contents = editorText
        do {
            _ = try JSONSerialization.jsonObject(
                with: Data(contents.utf8), options: [.fragmentsAllowed]
            )
        } catch {
            outcome = .notJSON(error.localizedDescription)
            isValidating = false
            return
        }

        // 1) 校验动作必须落在 daemon 身上：读不到它的路径就不代测。
        guard let binary = console.daemonBinaryPath else {
            outcome = .noDaemon
            isValidating = false
            return
        }

        // 2) 以 0600 + O_EXCL + O_NOFOLLOW 独占创建临时文件（面板只读边界内，用完即删）。
        //    随机名不可预测，加上 O_EXCL 就同时消掉"其他进程先占路径 / 符号链接"的 TOCTOU，
        //    权限也不开给别人读。写入失败则走 writeFailed，绝不落成 0644。
        let tempPath: String
        do {
            tempPath = try Self.createSecurely(contents: contents)
        } catch {
            outcome = .writeFailed
            isValidating = false
            return
        }

        Task.detached(priority: .userInitiated) {
            // 清理放进 defer，读与不读都会删。
            defer { try? FileManager.default.removeItem(atPath: tempPath) }
            let run = ConsoleModel.runDaemonCLI(
                binary: binary, arguments: ["--recipe-validate", tempPath]
            )
            let result: RecipeValidationOutcome
            if let run {
                result = Self.foldValidation(
                    stdout: run.output, stderr: run.errorOutput, exitCode: run.status
                )
            } else {
                result = .daemonUnavailable
            }
            await MainActor.run {
                // 仅当本次校验仍是最新才写结论，避免旧内容结论覆盖当前编辑器显示。
                guard self.validationToken == token else { return }
                self.outcome = result
                self.isValidating = false
            }
        }
    }

    /// 以 0600 权限 + O_EXCL/O_NOFOLLOW 独占创建临时文件（UUID 随机名，重试避撞名）。
    /// 返回写入成功后的路径；彻底失败抛错，不落盘低权限/可被替换的诊断文件。
    private static func createSecurely(contents: String) throws -> String {
        let dir = NSTemporaryDirectory()
        let retries = 16
        let byteCount = contents.utf8.count
        for _ in 0..<retries {
            let path = dir + "recipe-check-\(UUID().uuidString).json"
            let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard fd != -1 else { continue }  // 撞名/被占/符号链接 → 换名重试
            let written = contents.withCString { bytes in write(fd, bytes, byteCount) }
            close(fd)
            if written == byteCount {
                return path
            }
            unlink(path)  // 写坏了就删掉，不留残缺诊断文件
        }
        throw NSError(domain: "glasspane.recipes", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "无法以独占权限创建临时文件（重试次数已用完）"])
    }

    /// `--recipe-validate` 那一趟的结局折算（纯函数，供单测）。
    ///
    /// 从前只看 stdout：这条命令的**拒绝写在 stderr**——文件读不开是
    /// `{"valid":false,"errors":["file not found: …"],"path":…}` 配退出码 2，
    /// 结论编码不出去是 `{"encodeFailed":true,…}` 配退出码 1。只看 stdout 的那一条
    /// 把它们全折成"输出不是约定的 JSON"，屏幕上于是写「后台服务不可达」——
    /// 后台服务明明答了话、还答了自己的原因，被换成了一件没发生过的事实。
    ///
    /// 判据两样，都是量到的东西：`ConsoleModel.replyText` 选出的那一路回话（stdout
    /// 优先、形状不成才看 stderr），与退出码。退出码 2 按这条命令自己的 `--help`
    /// 说的是"它给的这个值用不了"（不是 64 那种用法错），连文件都没读，
    /// 那份载荷里的 `valid:false` 就不是配方的结论。
    nonisolated static func foldValidation(
        stdout: String, stderr: String, exitCode: Int32
    ) -> RecipeValidationOutcome {
        let reply = ConsoleModel.replyText(stdout: stdout, stderr: stderr)
        guard let data = reply.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .daemonRefused(
                reason: ConsoleModel.daemonRefusalReason(reply: reply), exitCode: exitCode
            )
        }
        if let valid = object["valid"] as? Bool, exitCode == 0 || exitCode == 1 {
            return .verdict(
                valid: valid,
                recipeName: object["recipeName"] as? String,
                errors: (object["errors"] as? [String]) ?? []
            )
        }
        return .daemonRefused(
            reason: ConsoleModel.daemonRefusalReason(reply: reply), exitCode: exitCode
        )
    }

    // MARK: - 工具栏

    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            Button {
                outcome = .idle
            } label: {
                Label("清除结论", systemImage: "xmark.circle")
            }
            // 这一枚原先写着"刷新"配一个转圈箭头，做的却是把上一次的校验结论抹掉：
            // 字段结构本来就随每次渲染重读盘，这里没有任何可"刷新"的东西。
            // 按钮说什么，它就得做什么。
            .help("清掉上一次显示的校验结论（配方内容保存在本机设置里，不会丢失）")
            .disabled(isValidating)
            .accessibilityIdentifier("gp-clear-recipe-verdict")
        }
    }
}

/// 模板描述（供加载按钮展示）。
///
/// `key` 是标识里的那一段 ASCII：无障碍标识里放中文，`act` 按标识就选不中元素
/// （与 `UpdateTabView.reasonLine` 同一条规矩）。标题给人看，标识给机器按。
struct RecipeTemplate: Identifiable {
    let key: String
    let title: String
    let contents: String
    var id: String { key }
}

/// 内置最小合法 recipe 模板。两条都满足 recipe-config.schema.json 的约束
/// （schemaVersion 字面量、简单步骤），能通过 daemon `--recipe-validate`。
enum RecipeTemplates {
    /// 编辑器首次的占位：一个最小合法配方，而不是空文本。
    static let emptyEditorSlot: String = {
        let json = """
        {"schemaVersion":"glasspane.recipe/0.1-draft","name":"最小配方","steps":[{"kind":"observe","params":{"selector":{"role":"window","title":"Main"}}}]}
        """
        return pretty(json)
    }()

    static let all: [RecipeTemplate] = [
        RecipeTemplate(key: "press-assert", title: "按压并断言", contents: pressAndAssert),
        RecipeTemplate(key: "min-step", title: "最小单步", contents: minStep)
    ]

    /// 模板一：点按按钮后断言可用。
    static let pressAndAssert: String = pretty("""
    {"schemaVersion":"glasspane.recipe/0.1-draft","name":"点按按钮并断言可用","steps":[{"kind":"act","params":{"selector":{"role":"btn","title":"确认"},"action":"press"}},{"kind":"assert","params":{"selector":{"role":"btn","title":"确认"},"property":"enabled","expected":true}}]}
    """)

    /// 模板二：单步观察，最小壳。
    static let minStep: String = pretty("""
    {"schemaVersion":"glasspane.recipe/0.1-draft","name":"最小单步观察","steps":[{"kind":"observe","params":{"selector":{"role":"window","title":"Main"}}}]}
    """)

    /// 把紧凑 JSON 排成缩进的可读文本（供编辑器起点；解析失败则原样返回）。
    private static func pretty(_ compact: String) -> String {
        guard let data = compact.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let prettyData = try? JSONSerialization.data(withJSONObject: object,
                                                          options: [.prettyPrinted, .sortedKeys]),
              let pretty = String(data: prettyData, encoding: .utf8) else {
            return compact
        }
        return pretty
    }
}

// MARK: - 结构浏览器的解析与真源读取

/// 从 schema JSON 提炼出来的可读字段行。
struct SchemaFieldRow: Identifiable {
    let name: String
    let detail: String
    var id: String { name }
}

/// 结构浏览器的完整内容（含原始 JSON 与来源说明）。
struct SchemaOverview {
    /// 来源标注：`schema 文件（只读真源）` 或 `内置快照（文件未找到）`。
    let source: String
    /// 这一屏**真的读到的**那一份文件在哪（绝对路径）。nil = 盘上那一份没读到，
    /// 页面上摊开的是内置快照。那句副标题只认这一个判据——它不能由 `source` 那句
    /// 人话里含哪些字猜出来（猜错过一次：「内置快照（schema 文件未找到）」里也含
    /// "schema 文件"，于是快照那一屏被自称成了真源）。
    let loadedPath: String?
    let schemaVersion: String?
    let required: [String]?
    let fields: [SchemaFieldRow]
    /// 原始 schema 的缩进文本（真源原貌）。
    let raw: String
}

/// 读 `kernel/schemas/recipe-config.schema.json` 作为只读真源；读不到则回退到
/// 与它一致的内置快照并如实标注来源。真源内容见文件头注释里嵌入的 `embeddedRaw`。
enum RecipeSchemaLoader {
    /// 内置快照：与 `kernel/schemas/recipe-config.schema.json` 内容一致（只读，
    /// 若两者发生漂移，项目门禁会以 schema 文件为准）。
    static let embeddedRaw = """
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "RecipeConfig",
      "description": "Recipe configuration contract (P0 landing of the shared recipe validator, R35). A recipe is a named ordered sequence of engine primitives; step params are validated by the corresponding tool contracts, not by this schema.",
      "type": "object",
      "additionalProperties": false,
      "required": ["schemaVersion", "name", "steps"],
      "properties": {
        "schemaVersion": { "const": "glasspane.recipe/0.1-draft" },
        "name": { "type": "string", "maxLength": 256 },
        "steps": {
          "type": "array",
          "minItems": 1,
          "maxItems": 64,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "params"],
            "properties": {
              "kind": { "enum": ["act", "observe", "assert", "diagnose"] },
              "params": { "type": "object" }
            }
          }
        }
      }
    }
    """

    /// 卡片顶部那句"这一屏显示的是哪一份"。
    ///
    /// 它必须跟着 `load()` 的实际结局走。从前这一行硬写着
    /// "真源：kernel/schemas/recipe-config.schema.json（只读）"，而 `load()` 只试
    /// **当前工作目录**相对的那两个候选：面板由 launchd/Finder 起时 cwd 是 `/`，
    /// 那一次永远落到内置快照，屏幕上那份内置快照却由那句话自称是真源。
    /// 这一行不是给读的人增加装饰的，它说的必须就是这一屏的东西（面板只报它测到的）。
    static func subtitle(for overview: SchemaOverview) -> String {
        // 判据是"这一趟到底读到了一份文件没有"，不是那句 `source` 人话里含哪些字：
        // 快照那一句写作「内置快照（schema 文件未找到）」，用 `contains("schema 文件")`
        // 去分枝会把这一支读成真源那一支——一句给错的副标题正是这条缺陷本身。
        // 读到的一律点名**那一份文件**（绝对路径），这一屏才说得出它显示的是哪一份。
        if let path = overview.loadedPath {
            return "这一屏读的是盘上那一份 \(path)（只读真源）"
        }
        return "这一屏显示的是面板内置的快照（\(overview.source)）："
            + "kernel/schemas/recipe-config.schema.json 这一趟没读到，页面上这份不声称就是那一份"
    }

    /// 候选位置：优先当前工作目录下的 kernel 路径；其余兜底。
    private static let candidatePaths = [
        "kernel/schemas/recipe-config.schema.json",
        "../kernel/schemas/recipe-config.schema.json"
    ]

    static func load(fromWorkingDirectory cwd: String = FileManager.default.currentDirectoryPath)
        -> SchemaOverview {
        // 尝试读真源文件。
        for relative in candidatePaths {
            let absolute = (cwd as NSString).appendingPathComponent(relative)
            if let data = FileManager.default.contents(atPath: absolute),
               let overview = makeOverview(text: String(data: data, encoding: .utf8)) {
                return SchemaOverview(
                    source: "schema 文件（只读真源）",
                    loadedPath: absolute,
                    schemaVersion: overview.schemaVersion,
                    required: overview.required,
                    fields: overview.fields,
                    raw: overview.raw
                )
            }
        }
        // 回退真源：内置快照（内容与 schema 文件一致）。
        if let overview = makeOverview(text: embeddedRaw) {
            return SchemaOverview(
                source: "内置快照（schema 文件未找到）",
                loadedPath: nil,
                schemaVersion: overview.schemaVersion,
                required: overview.required,
                fields: overview.fields,
                raw: overview.raw
            )
        }
        return SchemaOverview(source: "内置快照（解析失败）", loadedPath: nil, schemaVersion: nil,
                              required: nil, fields: [], raw: embeddedRaw)
    }

    /// 结构卡顶部那一句**给人读**的话（纯函数，供单测）。
    ///
    /// 它从前是 schema 自己那句 `description` 原文。那一句是写给内核读者的契约注脚
    /// （"…contract (P0 landing of the shared recipe validator, R35)…"），把它原样印在
    /// 这一页上，用户读到的就是内部批次编号与一句自我说明——这一面的用户文案不许
    /// 承载那种东西。这里只说这一屏是什么、以及它**不**替你做什么；契约原文仍然完整
    /// 保留在下面那份原始 JSON 里，一个字没改。
    static func userFacingSummary(for overview: SchemaOverview) -> String {
        var sentence = "一份配方就是「一个名字 + 一串按顺序执行的步骤」。"
        if let required = overview.required, !required.isEmpty {
            sentence += "下面这张表列的是 \(required.joined(separator: "、")) 这些字段要写成什么样；"
        } else {
            sentence += "下面这张表列的是这份结构要求的字段与取值范围；"
        }
        sentence += "内容合不合格由「校验」交给后台服务判，这一页不替它判定。"
        return sentence
    }

    private static func makeOverview(text: String?) -> SchemaOverview? {
        guard let text,
              let data = text.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        let pretty = prettyPrinted(root)
        let props = root["properties"] as? [String: Any]
        let schemaVersion = (props?["schemaVersion"] as? [String: Any])?["const"] as? String
        let required = root["required"] as? [String]
        var fields: [SchemaFieldRow] = []
        if let properties = root["properties"] as? [String: Any] {
            for key in properties.keys.sorted() {
                let raw = properties[key] as? [String: Any] ?? [:]
                var detailParts: [String] = []
                if let const = raw["const"] as? String {
                    detailParts.append("常量：\(const)")
                }
                if let type = raw["type"] as? String {
                    detailParts.append("type=\(type)")
                }
                if let maxLength = raw["maxLength"] {
                    detailParts.append("maxLength=\(maxLength)")
                }
                if let minItems = raw["minItems"], let maxItems = raw["maxItems"] {
                    detailParts.append("minItems=\(minItems) maxItems=\(maxItems)")
                }
                if let enumValues = raw["enum"] as? [String], !enumValues.isEmpty {
                    detailParts.append("枚举：\(enumValues.joined(separator: " | "))")
                }
                fields.append(SchemaFieldRow(name: key,
                                             detail: detailParts.isEmpty ? "object" : detailParts.joined(separator: "， ")))
            }
        }
        return SchemaOverview(source: "", loadedPath: nil, schemaVersion: schemaVersion,
                              required: required, fields: fields, raw: pretty)
    }

    private static func prettyPrinted(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object,
                                                     options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }
}
