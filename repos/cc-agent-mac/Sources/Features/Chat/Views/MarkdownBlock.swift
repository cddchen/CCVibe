import MarkdownUI
import SwiftUI

struct MarkdownBlock: View {
    let text: String

    var body: some View {
        Markdown(text)
            .markdownTheme(.gitHub)
            .textSelection(.enabled)
    }
}