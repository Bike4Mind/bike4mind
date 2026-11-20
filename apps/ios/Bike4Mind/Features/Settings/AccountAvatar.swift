import SwiftUI

/// The signed-in account as a circle with its initial, or a generic person symbol when the token carries no
/// name. Shared by the home profile button and the Settings header so the two always match.
struct AccountAvatar: View {
  let initial: String?
  let diameter: CGFloat

  var body: some View {
    Group {
      if let initial {
        Text(initial)
          .font(.system(size: diameter * 0.45, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
          .frame(width: diameter, height: diameter)
          .background(Tokens.Palette.brand, in: Circle())
      } else {
        Image(systemName: "person.crop.circle")
          .resizable()
          .scaledToFit()
          .foregroundStyle(Tokens.Palette.brand)
          .frame(width: diameter, height: diameter)
      }
    }
    .accessibilityHidden(true)
  }
}
