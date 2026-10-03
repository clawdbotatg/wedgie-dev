// wedgie: the site in an app, plus the WEDGIE drive (an iPhone's only way to a wedgie).
// docs/PLAN-IPHONE-APP.md is the plan; ios/WedgieDrive/README.md is build + install.
import SwiftUI

@main
struct WedgieApp: App {
    @StateObject private var drive = Drive.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ZStack(alignment: .bottomTrailing) {
                WebView()
                    .ignoresSafeArea(edges: .bottom)
                DriveButton()
                    .padding(.trailing, 16)
                    .padding(.bottom, 28)
            }
            .sheet(isPresented: $drive.showPanel) { DrivePanel() }
            .environmentObject(drive)
            .onChange(of: phase, initial: true) { _, p in
                if p == .active { drive.start() } else { drive.stop() }
            }
        }
    }
}

/// The underwear in the corner: opens the drive panel. Green dot = a wedgie is plugged in.
struct DriveButton: View {
    @EnvironmentObject var drive: Drive

    var body: some View {
        Button { drive.showPanel = true } label: {
            Image("Underwear")
                .resizable()
                .scaledToFit()
                .frame(width: 34, height: 34)
                .padding(8)
                .background(Circle().fill(.white).shadow(color: .black.opacity(0.25), radius: 6, y: 2))
                .overlay(alignment: .topTrailing) {
                    Circle()
                        .fill(drive.state == .here ? Color.green : Color.gray)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(.white, lineWidth: 2))
                }
        }
        .accessibilityLabel("WEDGIE drive")
    }
}
