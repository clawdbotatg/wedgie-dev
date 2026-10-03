// The WEDGIE drive: the one way an iPhone talks to a wedgie (no serial port without MFi). The person
// picks the drive's top folder once; we keep a security-scoped bookmark and use it every time after.
// docs/PLAN-IPHONE-APP.md has the why and the unknowns this app is here to test.
//
// Send = write a new REQ-<n>.TXT (one JSON request per line; the wedgie's inbox.py reads each new file
// once). Answers come back in ANSWER.TXT (0.3.21+): "#<count>" then the answers as JSON lines, padded
// with newlines (zeros until the first). After a send we read it every second for 60 s and log any change.
import Foundation
import SwiftUI

struct DriveFile: Identifiable, Hashable {
    let name: String
    let size: Int
    var id: String { name }
    var junk: Bool { name.hasPrefix(".") }          // iOS's own hidden files: they eat the wedgie's 12-sector RAM budget
}

struct LogLine: Identifiable {
    let id = UUID()
    let at = Date()
    let kind: Kind
    let text: String
    enum Kind { case sent, answer, info, error }
}

/// File work on the drive, off the main thread. Every call resolves the bookmark and opens and closes
/// the security scope itself, so an unplug between calls is just an error, never a stale handle.
actor DriveIO {
    static let bookmarkKey = "wedgieDriveBookmark"

    func resolve() throws -> URL {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { throw DriveError.notPicked }
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        if stale, url.startAccessingSecurityScopedResource() {
            defer { url.stopAccessingSecurityScopedResource() }
            if let fresh = try? url.bookmarkData() { UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey) }
        }
        return url
    }

    func with<T>(_ body: (URL) throws -> T) throws -> T {
        let url = try resolve()
        guard url.startAccessingSecurityScopedResource() else { throw DriveError.noAccess }
        defer { url.stopAccessingSecurityScopedResource() }
        guard (try? url.checkResourceIsReachable()) == true else { throw DriveError.away }
        return try body(url)
    }

    /// Is the drive plugged in? Returns its folder name, or throws why not.
    func check() throws -> String { try with { $0.lastPathComponent } }

    func list() throws -> [DriveFile] {
        try with { root in
            try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey])
                .map { u in
                    let v = try? u.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
                    return DriveFile(name: u.lastPathComponent + (v?.isDirectory == true ? "/" : ""), size: v?.fileSize ?? 0)
                }
                .sorted { $0.name < $1.name }
        }
    }

    func read(_ name: String) throws -> String? {
        try with { root in
            let file = root.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.path) else { return nil }
            var out: Data?, cerr: NSError?, rerr: Error?
            NSFileCoordinator().coordinate(readingItemAt: file, options: .withoutChanges, error: &cerr) { u in
                do { out = try Data(contentsOf: u, options: .uncached) } catch { rerr = error }
            }
            if let e = cerr ?? rerr { throw e }
            return String(decoding: (out ?? Data()).prefix(20000), as: UTF8.self)
        }
    }

    /// Write lines as a new REQ-<n>.TXT. Old REQ files more than 5 s old go first (the wedgie has read
    /// them by then: it waits 0.7 s after the last write), so the phone reuses their clusters and the
    /// drive's RAM budget doesn't run out after a dozen sends.
    func send(_ lines: [String]) throws -> String {
        try with { root in
            let fm = FileManager.default
            for u in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
                let n = u.lastPathComponent.uppercased()
                guard n.hasPrefix("REQ-"), n.hasSuffix(".TXT") else { continue }
                let at = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if Date().timeIntervalSince(at) > 5 { coordinated(u, .forDeleting) { try fm.removeItem(at: $0) } }
            }
            let d = UserDefaults.standard
            let n = d.integer(forKey: "wedgieReqN") % 9999 + 1
            d.set(n, forKey: "wedgieReqN")
            let name = "REQ-\(n).TXT"
            let body = Data((lines.joined(separator: "\n") + "\n").utf8)
            var werr: Error?
            coordinated(root.appendingPathComponent(name), .forReplacing) { u in
                do { try body.write(to: u) } catch { werr = error }
            }
            if let werr { throw werr }
            return name
        }
    }

    private func coordinated(_ url: URL, _ opts: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> Void) {
        var err: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: opts, error: &err) { u in try? body(u) }
    }
}

enum DriveError: LocalizedError {
    case notPicked, noAccess, away
    var errorDescription: String? {
        switch self {
        case .notPicked: return "pick the WEDGIE drive first"
        case .noAccess: return "iOS said no to the drive: pick it again"
        case .away: return "plug in your wedgie"
        }
    }
}

/// What the screen and the page see. Polls the drive every second while the app is in front.
@MainActor final class Drive: ObservableObject {
    static let shared = Drive()
    enum State: String { case unpicked, away, here }

    @Published var state: State = UserDefaults.standard.data(forKey: DriveIO.bookmarkKey) == nil ? .unpicked : .away
    @Published var name = ""
    @Published var files: [DriveFile] = []
    @Published var log: [LogLine] = []
    @Published var showPanel = false
    @Published var lastAnswer: String?

    let io = DriveIO()
    private var timer: Timer?
    private var watchUntil = Date.distantPast
    private var checking = false
    private var nextId = Int(Date().timeIntervalSince1970) % 100000

    func note(_ kind: LogLine.Kind, _ text: String) {
        log.insert(LogLine(kind: kind, text: text), at: 0)
        if log.count > 300 { log.removeLast() }
    }

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in Task { @MainActor in await Drive.shared.tick() } }
        Task { await tick() }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// From the folder picker (still inside its security scope): keep a bookmark for every later use.
    func picked(_ url: URL) {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        do {
            UserDefaults.standard.set(try url.bookmarkData(), forKey: DriveIO.bookmarkKey)
            note(.info, "picked \(url.lastPathComponent)" + (url.lastPathComponent.uppercased() == "WEDGIE" ? "" : " (not named WEDGIE: is it the wedgie?)"))
            state = .away
            Task { await tick(); await refreshFiles() }
        } catch {
            note(.error, "couldn't keep the drive: \(error.localizedDescription)")
        }
    }

    func tick() async {
        guard !checking, state != .unpicked else { return }
        checking = true
        defer { checking = false }
        let was = state
        do {
            name = try await io.check()
            state = .here
        } catch {
            state = .away
        }
        if was != state {
            note(.info, state == .here ? "wedgie plugged in (\(name))" : "wedgie unplugged")
            if state == .here { await refreshFiles() } else { files = []; lastAnswer = nil }   // a replug starts ANSWER.TXT over
        }
        if state == .here, Date() < watchUntil { await readAnswer() }
    }

    func refreshFiles() async {
        do { files = try await io.list() } catch { files = [] }
    }

    func readAnswer() async {
        guard let t = try? await io.read("ANSWER.TXT") else { return }
        let trimmed = t.replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed != lastAnswer {           // empty: nothing answered since this plug-in
            lastAnswer = trimmed
            note(.answer, trimmed)
        }
    }

    /// Send one request. Adds an "id" when it has none, so an answer can be matched to it.
    @discardableResult
    func send(_ line: String) async -> String? {
        var text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if var obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
            if obj["id"] == nil { nextId += 1; obj["id"] = nextId }
            if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) { text = String(decoding: d, as: UTF8.self) }
        }
        do {
            let file = try await io.send([text])
            note(.sent, "\(file): \(text)")
            watchUntil = Date().addingTimeInterval(60)
            await refreshFiles()
            return file
        } catch {
            note(.error, "send failed: \(error.localizedDescription)")
            return nil
        }
    }

    func open(_ name: String) async {
        do {
            if let t = try await io.read(name) { note(.info, "\(name):\n\(t)") } else { note(.error, "\(name) isn't there") }
        } catch { note(.error, "read \(name): \(error.localizedDescription)") }
    }
}
