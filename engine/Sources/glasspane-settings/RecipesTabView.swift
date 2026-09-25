import SwiftUI
import GlassPaneEngine

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

    enum RecipeValidationOutcome: Equatable {
        case idle
        /// 客户端 JSON 解析失败：直接报"不是合法 JSON"，不进 daemon。
        case notJSON(String)
        /// 读不到 daemon 程序路径（还没连上后台服务）。
        case noDaemon
        /// 临时文件写入失败。
        case writeFailed
        /// daemon 起不来 / 超时 / 输出不是约定的 `{valid, errors, recipeName}`。
        case daemonUnavailable
        /// daemon 给出了明确结论。
        case verdict(valid: Bool, recipeName: String?, errors: [String])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
                schemaCard
                templatesCard
                editorCard
            }
            .padding(12)
        }
        .toolbar { toolbarContent }
    }

    // MARK: - 结构浏览器

    private var schemaCard: some View {
        let overview = RecipeSchemaLoader.load()
        return VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "字段结构",
                subtitle: "真源：kernel/schemas/recipe-config.schema.json（只读）",
                systemImage: "doc.badge.gearshape"
            )
            HStack(spacing: 6) {
                ChipView(text: "schema \(overview.schemaVersion ?? "-")", color: .secondary)
                ChipView(text: overview.source, color: .orange, systemImage: "person.crop.circle.badge.questionmark")
            }
            if let description = overview.description, !description.isEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
                    .accessibilityIdentifier("gp-recipe-template-\(template.title)")
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
                .disabled(isValidating)

                Spacer()
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
                          body: "后台服务不可达、超时，或其输出不是约定的 JSON，未校验。不把超时包装成结论。")
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

        // 2) 暂存到临时文件（面板只读边界内，用完即删）。
        let tempPath = NSTemporaryDirectory() + "recipe-check-\(UInt32.random(in: 0...UInt32.max)).json"
        do {
            try contents.write(toFile: tempPath, atomically: true, encoding: .utf8)
        } catch {
            outcome = .writeFailed
            isValidating = false
            return
        }

        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: ["--recipe-validate", tempPath])
            try? FileManager.default.removeItem(atPath: tempPath)
            let result: RecipeValidationOutcome
            if let run {
                result = Self.parseVerdict(run.output)
            } else {
                result = .daemonUnavailable
            }
            await MainActor.run {
                self.outcome = result
                self.isValidating = false
            }
        }
    }

    /// 解析 `--recipe-validate` 的输出 `{valid, errors[], recipeName}`（字段以
    /// RecipeLoader.validate 的返回为准）。
    nonisolated private static func parseVerdict(_ text: String) -> RecipeValidationOutcome {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let valid = object["valid"] as? Bool else {
            return .daemonUnavailable
        }
        let recipeName = object["recipeName"] as? String
        let errors = (object["errors"] as? [String]) ?? []
        return .verdict(valid: valid, recipeName: recipeName, errors: errors)
    }

    // MARK: - 工具栏

    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            Button {
                outcome = .idle
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .help("重新进入配方页（内容保存在本机设置里，不会丢失）")
            .accessibilityIdentifier("gp-refresh-recipes")
        }
    }
}

/// 模板描述（供加载按钮展示）。
struct RecipeTemplate: Identifiable {
    let title: String
    let contents: String
    var id: String { title }
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
        RecipeTemplate(title: "按压并断言", contents: pressAndAssert),
        RecipeTemplate(title: "最小单步", contents: minStep)
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
    let schemaVersion: String?
    let description: String?
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
                    schemaVersion: overview.schemaVersion,
                    description: overview.description,
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
                schemaVersion: overview.schemaVersion,
                description: overview.description,
                required: overview.required,
                fields: overview.fields,
                raw: overview.raw
            )
        }
        return SchemaOverview(source: "内置快照（解析失败）", schemaVersion: nil,
                              description: nil, required: nil, fields: [], raw: embeddedRaw)
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
        let description = root["description"] as? String
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
        return SchemaOverview(source: "", schemaVersion: schemaVersion, description: description,
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
