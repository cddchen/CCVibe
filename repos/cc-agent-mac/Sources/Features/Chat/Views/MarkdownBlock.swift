import MarkdownUI
import SwiftUI

/// Renders markdown that wraps within the offered width.
/// Wide code blocks and tables scroll horizontally *inside* their containers.
struct MarkdownBlock: View {
    let text: String
    /// When true, measure at ideal (content) width — used by ViewThatFits hug pass.
    var hugging: Bool = false

    var body: some View {
        Markdown(text)
            .markdownTheme(Self.chatTheme)
            .tint(Theme.brand)
            .textSelection(.enabled)
            .fixedSize(horizontal: hugging, vertical: true)
    }

    /// GitHub base + explicit horizontal scroll only for code/tables.
    private static let chatTheme = MarkdownUI.Theme.gitHub
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.25))
                .markdownMargin(top: 0, bottom: 12)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: true) {
                configuration.label
                    // Keep code on its ideal width so long lines scroll instead of wrapping.
                    .fixedSize(horizontal: true, vertical: true)
                    .relativeLineSpacing(.em(0.225))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.85))
                    }
                    .padding(12)
            }
            .background(Theme.controlBackground.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                    .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
            }
            .markdownMargin(top: 0, bottom: 12)
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: true) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: true)
                    .markdownTableBorderStyle(.init(color: Theme.separator.opacity(0.7)))
                    .markdownTableBackgroundStyle(
                        .alternatingRows(Theme.controlBackground.opacity(0.35), Theme.secondaryFill.opacity(0.55))
                    )
            }
            .markdownMargin(top: 0, bottom: 12)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 {
                        FontWeight(.semibold)
                    }
                    BackgroundColor(nil)
                }
                .fixedSize(horizontal: true, vertical: true)
                .padding(.vertical, 6)
                .padding(.horizontal, 12)
                .relativeLineSpacing(.em(0.25))
        }
}
