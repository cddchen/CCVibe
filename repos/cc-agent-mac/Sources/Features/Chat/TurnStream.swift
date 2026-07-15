import Foundation

@MainActor
final class TurnStream: ObservableObject {
    @Published private(set) var toolResults: [String: ToolResultState] = [:]

    private var turnId: String?
    private var blocks: [MessageBlock] = []
    private var metrics = MessageMetrics()
    private var model: String?
    private var timer: Timer?
    var onPatch: ((String, [MessageBlock], MessageMetrics?, String?, Bool) -> Void)?

    func beginTurn() -> String {
        let id = "a-\(Int(Date().timeIntervalSince1970 * 1000))"
        turnId = id
        blocks = []
        toolResults = [:]
        metrics = MessageMetrics()
        model = nil
        timer?.invalidate()
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.turnId != nil else { return }
                var m = self.metrics
                m.elapsedSeconds = (m.elapsedSeconds ?? 0) + 1
                self.metrics = m
                self.emitPatch(streaming: true)
            }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        onPatch?(id, [], nil, nil, true)
        return id
    }

    func onSdkEvent(_ msg: JSONValue) {
        let type = msg["type"]?.stringValue
        let turnDone = MessageBlocksEngine.isTurnDone(msg)

        // Only auto-start a turn on real assistant content.
        // Control noise (system/init, permission-mode side effects, late result)
        // must not open an empty "思考中…" bubble.
        if turnId == nil {
            guard type == "assistant" || type == "stream_event" else { return }
            _ = beginTurn()
        }
        guard turnId != nil else { return }

        if type == "user" {
            let applied = MessageBlocksEngine.applySdkMessage(blocks: blocks, toolResults: toolResults, msg: msg)
            toolResults = applied.toolResults
            return
        }

        let applied = MessageBlocksEngine.applySdkMessage(blocks: blocks, toolResults: toolResults, msg: msg)
        blocks = applied.blocks
        toolResults = applied.toolResults
        if let m = applied.metrics {
            metrics = MessageBlocksEngine.mergeMetrics(metrics, m) ?? m
        }
        if let mod = applied.model { model = mod }
        emitPatch(streaming: !turnDone)

        if turnDone {
            endTurn()
        }
    }

    func endTurn() {
        timer?.invalidate()
        timer = nil
        if let id = turnId {
            onPatch?(id, blocks, metrics, model, false)
        }
        turnId = nil
    }

    func reset() {
        timer?.invalidate()
        timer = nil
        turnId = nil
        blocks = []
        toolResults = [:]
        metrics = MessageMetrics()
        model = nil
    }

    private func emitPatch(streaming: Bool) {
        guard let id = turnId else { return }
        onPatch?(id, blocks, metrics, model, streaming)
    }
}