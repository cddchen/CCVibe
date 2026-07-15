import MarkdownUI
import SwiftUI

/// Renders markdown that wraps within the offered width.
/// Wide code blocks and tables scroll horizontally *inside* their containers.
/// Theme is chat-scoped: transparent body (inherits bubble), body-scale type.
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

    /// Transparent body + system-scale type. Not Theme.gitHub (which paints solid white at 16pt).
    private static let chatTheme = MarkdownUI.Theme()
        .text {
            // No BackgroundColor — inherit bubble / page surface.
            ForegroundColor(.primary)
            FontSize(13)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.9))
            BackgroundColor(Theme.secondaryFill)
        }
        .strong {
            FontWeight(.semibold)
        }
        .link {
            ForegroundColor(Theme.brand)
        }
        .heading1 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 10, bottom: 6)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.2))
                }
        }
        .heading2 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 10, bottom: 6)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.12))
                }
        }
        .heading3 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 8, bottom: 4)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.05))
                }
        }
        .heading4 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 8, bottom: 4)
                .markdownTextStyle {
                    FontWeight(.semibold)
                }
        }
        .heading5 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 6, bottom: 4)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(0.95))
                }
        }
        .heading6 { configuration in
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownMargin(top: 6, bottom: 4)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(0.9))
                    ForegroundColor(.secondary)
                }
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.25))
                .markdownMargin(top: 0, bottom: 8)
        }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Theme.separator)
                    .frame(width: 3)
                configuration.label
                    .markdownTextStyle { ForegroundColor(.secondary) }
                    .padding(.leading, 10)
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 0, bottom: 8)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: true) {
                configuration.label
                    // Keep code on its ideal width so long lines scroll instead of wrapping.
                    .fixedSize(horizontal: true, vertical: true)
                    .relativeLineSpacing(.em(0.25))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.9))
                    }
                    .padding(10)
            }
            .background(Theme.controlBackground.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                    .stroke(Theme.separator.opacity(0.45), lineWidth: 0.5)
            }
            .markdownMargin(top: 0, bottom: 8)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: .em(0.15))
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: true) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: true)
                    .markdownTableBorderStyle(.init(color: Theme.separator.opacity(0.7)))
                    .markdownTableBackgroundStyle(
                        .alternatingRows(Color.clear, Theme.secondaryFill.opacity(0.55))
                    )
            }
            .markdownMargin(top: 0, bottom: 8)
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
                .padding(.vertical, 5)
                .padding(.horizontal, 10)
                .relativeLineSpacing(.em(0.25))
        }
        .thematicBreak {
            Divider()
                .overlay(Theme.separator)
                .markdownMargin(top: 10, bottom: 10)
        }
}
