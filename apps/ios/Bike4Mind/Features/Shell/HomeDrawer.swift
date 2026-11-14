import B4MKit
import SwiftUI

/// The leading drawer over the start-of-chat home: opened by the home menu button or a drag from the left
/// edge, closed by a scrim tap or a leftward drag. Every row routes through `AppNavigator`, whose `apply`
/// closes the drawer, so a row never has to dismiss it by hand.
struct HomeDrawer: View {
  @Environment(AppServices.self) private var services
  /// Horizontal finger travel of the drag in flight; zero when idle.
  @State private var dragOffset: CGFloat = 0

  private static let widthFraction: CGFloat = 0.85
  private static let edgeGrabWidth: CGFloat = 20
  private static let commitFraction: CGFloat = 0.3

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width * Self.widthFraction
      let progress = openFraction(width: width)
      ZStack(alignment: .leading) {
        if progress > 0 {
          Color.black.opacity(0.4 * progress)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { setOpen(false) }
            .gesture(dragGesture(width: width))
            .accessibilityLabel("Close menu")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("home-drawer-scrim")
          DrawerContent(api: services.api, cache: services.sessionListCache)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(Tokens.Palette.sidebar.ignoresSafeArea())
            .offset(x: -width * (1 - progress))
            .gesture(dragGesture(width: width))
            .accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("home-drawer")
        }
        // Kept in the tree for the whole opening drag: swapping it out mid-gesture would cancel the drag.
        if canOpenByEdgeDrag && !services.navigator.isDrawerOpen {
          Color.clear
            .frame(width: Self.edgeGrabWidth)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(dragGesture(width: width))
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
    .animation(.snappy(duration: 0.28), value: services.navigator.isDrawerOpen)
  }

  /// The edge grab strip would sit on top of pushed screens, where the left edge belongs to Back.
  private var canOpenByEdgeDrag: Bool {
    services.navigator.sessionPath.isEmpty
  }

  private func openFraction(width: CGFloat) -> CGFloat {
    let base: CGFloat = services.navigator.isDrawerOpen ? 1 : 0
    return min(1, max(0, base + dragOffset / width))
  }

  private func setOpen(_ isOpen: Bool) {
    services.navigator.isDrawerOpen = isOpen
  }

  private func dragGesture(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 10)
      .onChanged { value in dragOffset = value.translation.width }
      .onEnded { value in
        let travelled = value.predictedEndTranslation.width
        let isOpen = services.navigator.isDrawerOpen
        withAnimation(.snappy(duration: 0.28)) {
          dragOffset = 0
          if isOpen {
            if travelled < -width * Self.commitFraction { setOpen(false) }
          } else if travelled > width * Self.commitFraction {
            setOpen(true)
          }
        }
      }
  }
}

private struct DrawerContent: View {
  @Environment(AppServices.self) private var services
  @State private var recents: SessionsViewModel
  @State private var profile: AccountProfile?

  init(api: any B4MAPI, cache: any SessionListCache) {
    _recents = State(initialValue: SessionsViewModel(api: api, cache: cache))
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
          row("New chat", symbol: "square.and.pencil", id: "drawer-newchat-btn") {
            services.navigator.apply(.compose(ComposeRequest(target: .newConversation)))
          }
          row("Voice chat", symbol: "waveform", id: "drawer-voice-btn") {
            services.navigator.startVoiceConversation(.newConversation)
          }
          row("Studio", symbol: "wand.and.stars", id: "drawer-studio-btn") { services.navigator.apply(.media) }
          notebooks
        }
        .padding(.horizontal, Tokens.Spacing.s + Tokens.Spacing.xs / 2)
        .padding(.top, Tokens.Spacing.m)
      }
      Rectangle().fill(Tokens.Palette.divider).frame(height: 1)
      accountRow
    }
    .task { await recents.load() }
    .task { profile = await services.accountProfile() }
  }

  private var notebooks: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      Text("Notebooks")
        .font(Tokens.Typography.caption.weight(.semibold))
        .foregroundStyle(Tokens.Palette.secondaryText)
        .padding(.horizontal, Tokens.Spacing.s + Tokens.Spacing.xs)
        .padding(.top, Tokens.Spacing.m)
        .accessibilityAddTraits(.isHeader)
      ForEach(recents.drawerRecents) { session in
        Button {
          services.navigator.openSession(session)
        } label: {
          Text(session.title)
            .lineLimit(1)
        }
        .buttonStyle(DrawerRowStyle())
        .accessibilityIdentifier("drawer-notebook-row")
      }
      row("All notebooks", symbol: "clock.arrow.circlepath", id: "drawer-all-notebooks-btn") {
        services.navigator.apply(.sessions)
      }
    }
  }

  private func row(_ title: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol)
    }
    .buttonStyle(DrawerRowStyle())
    .accessibilityIdentifier(id)
  }

  private var accountRow: some View {
    Button {
      services.navigator.apply(.settings)
    } label: {
      HStack(spacing: Tokens.Spacing.s) {
        AccountAvatar(initial: profile?.initial, diameter: 36)
        VStack(alignment: .leading, spacing: 0) {
          Text(profile?.displayName ?? "Your account")
            .font(Tokens.Typography.row.weight(.semibold))
            .foregroundStyle(Tokens.Palette.primaryText)
            .lineLimit(1)
          if let email = profile?.email {
            Text(email)
              .font(Tokens.Typography.caption)
              .foregroundStyle(Tokens.Palette.secondaryText)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .frame(minHeight: 44)
      .padding(.horizontal, Tokens.Spacing.m)
      .padding(.vertical, Tokens.Spacing.s)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("drawer-account-btn")
  }
}

/// A drawer row styled like the web sidenav row (SidenavItem, Notebook/Sidenav/kit): body-sm ink,
/// 12pt side padding, radius md, the web's focused background while pressed. The row keeps the
/// 44pt iOS touch target where the web uses 36px.
private struct DrawerRowStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Tokens.Typography.row)
      .foregroundStyle(Tokens.Palette.sidebarText)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .padding(.horizontal, Tokens.Spacing.s + Tokens.Spacing.xs)
      .background(
        configuration.isPressed ? Tokens.Palette.sidebarSelected : .clear,
        in: RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
      )
      .contentShape(Rectangle())
  }
}
