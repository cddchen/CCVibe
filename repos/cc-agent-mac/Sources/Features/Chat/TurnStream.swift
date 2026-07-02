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
        if turnId == nil, MessageBlocksEngine.isTurnDone(msg) || msg["type"]?.stringValue != nil {
            _ = beginTurn()
        }
        guard turnId != nil else { return }
        if msg["type"]?.stringValue == "user" { return }

        let applied = MessageBlocksEngine.applySdkMessage(blocks: blocks, toolResults: toolResults, msg: msg)
        blocks = applied.blocks
        toolResults = applied.toolResults
        if let m = applied.metrics {
            metrics = MessageBlocksEngine.mergeMetrics(metrics, m) ?? m
        }
        if let mod = applied.model { model = mod }
        emitPatch(streaming: !MessageBlocksEngine.isTurnDone(msg))

        if MessageBlocksEngine.isTurnDone(msg) {
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