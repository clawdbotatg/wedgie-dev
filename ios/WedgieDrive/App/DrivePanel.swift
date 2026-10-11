// The drive panel: one simple screen in wedgie.dev's look (find the drive, plugged in or not). Its details (test
// buttons, files, the log, Forget) are one tap away in DriveDetails.
import SwiftUI

private let paper = Color(red: 0.957, green: 0.957, blue: 0.945)      // --paper #f4f4f1
private let ink = Color(red: 0.102, green: 0.106, blue: 0.102)        // --ink #1a1b1a
private let muted = Color(red: 0.42, green: 0.43, blue: 0.42)         // --muted #6b6e6b
private let green = LinearGradient(colors: [Color(red: 0.275, green: 0.804, blue: 0.392), Color(red: 0.086, green: 0.549, blue: 0.204)],
                                   startPoint: .top, endPoint: .bottom)   // --green-fill
private let greenEdge = Color(red: 0.059, green: 0.431, blue: 0.157)  // #0f6e28

/// wedgie.dev's big green pill button.
struct PillButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 22, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.2), radius: 0, y: 1)
                .frame(maxWidth: .infinity, minHeight: 64)
                .background(Capsule().fill(green))
                .background(Capsule().fill(greenEdge).offset(y: 4))
                .shadow(color: Color(red: 0.086, green: 0.549, blue: 0.204).opacity(0.45), radius: 12, y: 8)
        }
        .buttonStyle(.plain)
    }
}

struct DrivePanel: View {
    @EnvironmentObject var drive: Drive
    @Environment(\.dismiss) private var dismiss
    @State private var picking = false
    @State private var details = false

    var body: some View {
        ZStack {
            paper.ignoresSafeArea()
            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 17, weight: .heavy)).foregroundStyle(muted)
                            .frame(width: 40, height: 40).background(Circle().fill(.white))
                    }
                }
                Spacer()
                if drive.state != .unpicked { ZStack(alignment: .topTrailing) {
                    Image("Underwear").resizable().scaledToFit().frame(width: 150, height: 150)
                    Circle().fill(drive.state == .here ? Color(red: 0.133, green: 0.769, blue: 0.322) : Color.gray.opacity(0.5))
                        .frame(width: 26, height: 26).overlay(Circle().stroke(paper, lineWidth: 4)).offset(x: 6, y: 10)
                } }
                Text(title)
                    .font(.system(size: 34, weight: .heavy, design: .rounded)).foregroundStyle(ink)
                    .multilineTextAlignment(.center).padding(.top, drive.state == .unpicked ? 0 : 28)
                Text(subtitle)
                    .font(.system(size: 19, weight: .medium, design: .rounded)).foregroundStyle(muted)
                    .multilineTextAlignment(.center).padding(.top, 10)
                if drive.state == .unpicked { PickerHint().padding(.top, 30) }
                Spacer()
                switch drive.state {
                case .unpicked: PillButton(title: "Find my wedgie") { picking = true }
                case .here: PillButton(title: "Done") { dismiss() }
                case .away: EmptyView()
                }
                Button("Details") { details = true }
                    .font(.system(size: 16, weight: .bold, design: .rounded)).foregroundStyle(muted)
                    .padding(.top, 22)
            }
            .padding(.horizontal, 28).padding(.vertical, 20)
        }
        .sheet(isPresented: $picking) { FolderPicker { drive.picked($0) }.ignoresSafeArea() }
        .sheet(isPresented: $details) { DriveDetails() }
    }

    private var title: String {
        switch drive.state {
        case .unpicked: return "Find your wedgie"
        case .away: return "Plug in your wedgie"
        case .here: return "Connected"
        }
    }

    private var subtitle: String {
        switch drive.state {
        case .unpicked: return "Plug it in. On the next screen, tap Open."
        case .away: return "It connects by itself."
        case .here: return "Your wedgie is plugged in."
        }
    }
}

/// Everything else: test requests, the drive's files, the log, Forget the drive.
struct DriveDetails: View {
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
            .navigationTitle("Details")
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

/// Apple's folder picker, started at the WEDGIE drive when we know where it mounts (directoryURL), so nobody has
/// to go back out of iCloud Drive and find it under Locations.
struct FolderPicker: UIViewControllerRepresentable {
    let done: (URL) -> Void
    func makeCoordinator() -> Coord { Coord(done) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        if let path = UserDefaults.standard.string(forKey: DriveIO.pathKey) { p.directoryURL = URL(fileURLWithPath: path) }
        p.delegate = context.coordinator
        return p
    }
    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}
    final class Coord: NSObject, UIDocumentPickerDelegate {
        let done: (URL) -> Void
        init(_ d: @escaping (URL) -> Void) { done = d }
        func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { if let u = urls.first { done(u) } }
    }
}

/// What Apple's picker will look like: the top of it, WEDGIE, and its blue Open with an arrow at it.
struct PickerHint: View {
    @State private var bob = false
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundStyle(.primary)
                    .frame(width: 44, height: 44).background(Circle().fill(Color(white: 0.95)))
                Text("WEDGIE").font(.system(size: 20, weight: .semibold))
                Spacer()
                Text("Open").font(.system(size: 19, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 20).frame(height: 44).background(Capsule().fill(Color.blue))
                    .overlay(Capsule().stroke(Color(red: 0.89, green: 0.19, blue: 0.17), lineWidth: 3).padding(-6))
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 26).fill(.white).shadow(color: .black.opacity(0.12), radius: 10, y: 4))
            HStack {
                Spacer()
                VStack(spacing: 2) {
                    Image(systemName: "arrow.up").font(.system(size: 34, weight: .black))
                    Text("tap Open").font(.system(size: 17, weight: .heavy, design: .rounded))
                }
                .foregroundStyle(Color(red: 0.89, green: 0.19, blue: 0.17))
                .offset(y: bob ? 4 : -2)
                .padding(.trailing, 18)
            }
            .padding(.top, 6)
        }
        .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever()) { bob = true } }
    }
}
