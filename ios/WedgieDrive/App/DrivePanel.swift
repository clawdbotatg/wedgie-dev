// The drive panel: pick the WEDGIE drive once, send requests, see the files and every answer.
import SwiftUI

struct DrivePanel: View {
    @EnvironmentObject var drive: Drive
    @Environment(\.dismiss) private var dismiss
    @State private var picking = false
    @State private var line = #"{"type":"hello"}"#

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        Circle().fill(drive.state == .here ? .green : .gray).frame(width: 10, height: 10)
                        Text(status).font(.headline)
                    }
                    Button(drive.state == .unpicked ? "Pick the WEDGIE drive" : "Pick the drive again") { picking = true }
                    if drive.state != .unpicked { Button("Forget the drive", role: .destructive) { drive.forget() } }
                } footer: {
                    if drive.state == .unpicked {
                        Text("Plug in your wedgie, tap Pick, then choose WEDGIE under Locations and tap Open. You only do this once.")
                    }
                }

                if drive.state == .here {
                    Section("Send") {
                        HStack {
                            Button("Hello") { Task { await drive.send(#"{"type":"hello"}"#) } }
                                .buttonStyle(.borderedProminent)
                            Button("Ask to connect") { Task { await drive.send(#"{"type":"open"}"#) } }
                                .buttonStyle(.bordered)
                        }
                        HStack {
                            Button("My Safes") { Task { await drive.send(#"{"type":"safe_list"}"#) } }
                                .buttonStyle(.bordered)
                            Button("Test sign") { Task { await drive.testSign() } }
                                .buttonStyle(.bordered)
                        }
                        TextField("a JSON request", text: $line, axis: .vertical)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Send this") { Task { await drive.send(line) } }
                    }
                }

                Section("Log") {
                    if drive.log.isEmpty { Text("nothing yet").foregroundStyle(.secondary) }
                    ForEach(drive.log) { l in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(l.at.formatted(date: .omitted, time: .standard)) · \(label(l.kind))")
                                .font(.caption).foregroundStyle(color(l.kind))
                            Text(l.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                }

                if drive.state == .here {
                    Section {
                        ForEach(drive.files) { f in
                            Button { Task { await drive.open(f.name) } } label: {
                                HStack {
                                    Text(f.name).font(.system(.body, design: .monospaced))
                                        .foregroundStyle(f.junk ? .secondary : .primary)
                                    Spacer()
                                    Text("\(f.size) B").foregroundStyle(.secondary)
                                }
                            }
                            .disabled(f.name.hasSuffix("/"))
                        }
                    } header: {
                        HStack {
                            Text("On the drive")
                            Spacer()
                            Button("Refresh") { Task { await drive.refreshFiles() } }.font(.caption)
                        }
                    } footer: {
                        let junk = drive.files.filter(\.junk).count
                        if junk > 0 { Text("\(junk) hidden file\(junk == 1 ? "" : "s") from iOS") }
                    }
                }

            }
            .navigationTitle("WEDGIE drive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { r in
                switch r {
                case .success(let url): drive.picked(url)
                case .failure(let e): drive.note(.error, "picker: \(e.localizedDescription)")
                }
            }
        }
    }

    private var status: String {
        switch drive.state {
        case .unpicked: return "No drive picked yet"
        case .away: return "Plug in your wedgie"
        case .here: return "Wedgie plugged in" + (drive.name.isEmpty ? "" : " (\(drive.name))")
        }
    }

    private func label(_ k: LogLine.Kind) -> String {
        switch k { case .sent: "sent"; case .answer: "answer"; case .info: "info"; case .error: "error" }
    }

    private func color(_ k: LogLine.Kind) -> Color {
        switch k { case .sent: .blue; case .answer: .green; case .info: .secondary; case .error: .red }
    }
}
