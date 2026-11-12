import B4MKit
import SwiftUI

/// The first-launch welcome: what the app is, why notifications help, then on to sign-in.
struct OnboardingView: View {
  let onFinish: () -> Void

  @State private var pageID = Onboarding.pages.first?.id

  private var isLastPage: Bool { pageID == Onboarding.pages.last?.id }

  var body: some View {
    VStack(spacing: Tokens.Spacing.l) {
      TabView(selection: $pageID) {
        ForEach(Onboarding.pages) { page in
          OnboardingPageView(page: page)
            .tag(Optional(page.id))
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .always))
      .indexViewStyle(.page(backgroundDisplayMode: .interactive))

      Button(action: advance) {
        Text(isLastPage ? "Continue" : "Next")
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .buttonBorderShape(.roundedRectangle(radius: Tokens.Radius.control))
      .accessibilityIdentifier("onboarding-next-btn")
    }
    .padding(Tokens.Spacing.l)
    .frame(maxWidth: Tokens.Layout.readableWidth)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Tokens.Palette.background)
  }

  private func advance() {
    guard !isLastPage, let index = Onboarding.pages.firstIndex(where: { $0.id == pageID }) else {
      onFinish()
      return
    }
    withAnimation { pageID = Onboarding.pages[index + 1].id }
  }
}

private struct OnboardingPageView: View {
  let page: OnboardingPage

  var body: some View {
    ScrollView {
      VStack(spacing: Tokens.Spacing.l) {
        Image(systemName: page.systemImage)
          .font(.largeTitle)
          .imageScale(.large)
          .foregroundStyle(Tokens.Palette.brand)
          .accessibilityHidden(true)
        Text(page.title)
          .font(.title.bold())
          .foregroundStyle(Tokens.Palette.primaryText)
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        Text(page.message)
          .font(.body)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .multilineTextAlignment(.center)
      }
      .padding(.top, Tokens.Spacing.xxl)
      .padding(.bottom, Tokens.Spacing.xxl)
      .frame(maxWidth: .infinity)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("onboarding-page-\(page.id)")
  }
}
