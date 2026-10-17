import SwiftUI

// Base design tokens. Intentionally small so the whole look can be restyled from here.

enum Theme {
    // MARK: Colors
    static let background = rgb(0x0E0D0C)    // warm near-black
    static let card = rgb(0x1A1817)
    static let cardRaised = rgb(0x24211F)
    static let text = rgb(0xF4EFE8)          // warm off-white
    static let muted = rgb(0xA39C93)
    static let accent = rgb(0xFF6A2B)        // ember orange
    static let onAccent = rgb(0x1A0E08)

    static let riskLow = rgb(0x4FC6A8)       // calm teal-green
    static let riskElevated = rgb(0xF2B33D)  // amber
    static let riskHigh = rgb(0xE5482E)      // ember red

    static func riskColor(_ level: RiskLevel?) -> Color {
        switch level {
        case .low, .none: riskLow
        case .elevated: riskElevated
        case .high: riskHigh
        }
    }

    // MARK: Type (all text styles, so Dynamic Type just works)
    static let largeTitle = Font.system(.largeTitle, design: .rounded).weight(.semibold)
    static let title = Font.system(.title2, design: .rounded).weight(.semibold)
    static let headline = Font.headline
    static let body = Font.body
    static let caption = Font.footnote

    // MARK: Spacing
    static let gutter: CGFloat = 20
    static let corner: CGFloat = 18

    private static func rgb(_ hex: UInt32) -> Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

// MARK: - Button styles

struct AndiPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, 20)
            .foregroundStyle(Theme.onAccent)
            .background(
                Capsule().fill(Theme.accent.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.35))
            )
            .contentShape(Capsule())
    }
}

struct AndiSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, 20)
            .foregroundStyle(Theme.text.opacity(isEnabled ? 1 : 0.4))
            .background(
                Capsule().fill(Theme.cardRaised.opacity(configuration.isPressed ? 0.7 : 1))
            )
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == AndiPrimaryButtonStyle {
    static var andiPrimary: AndiPrimaryButtonStyle { AndiPrimaryButtonStyle() }
}

extension ButtonStyle where Self == AndiSecondaryButtonStyle {
    static var andiSecondary: AndiSecondaryButtonStyle { AndiSecondaryButtonStyle() }
}

// MARK: - View helpers

extension View {
    /// A soft rounded card surface.
    func andiCard() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.corner, style: .continuous).fill(Theme.card)
            )
    }

    /// Hides the default Form/List background so the theme shows through.
    func andiScreenBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
    }

    /// Phone-number keyboard + autofill on iOS; no-op elsewhere.
    @ViewBuilder func phoneInput() -> some View {
        #if os(iOS)
        keyboardType(.phonePad).textContentType(.telephoneNumber)
        #else
        self
        #endif
    }

    /// First-name autofill on iOS; no-op elsewhere.
    @ViewBuilder func nameInput() -> some View {
        #if os(iOS)
        textContentType(.givenName).textInputAutocapitalization(.words)
        #else
        self
        #endif
    }

    /// Decimal keyboard on iOS; no-op elsewhere.
    @ViewBuilder func decimalInput() -> some View {
        #if os(iOS)
        keyboardType(.decimalPad)
        #else
        self
        #endif
    }

    /// URL keyboard, no autocaps/autocorrect.
    @ViewBuilder func urlInput() -> some View {
        #if os(iOS)
        keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    /// Plain text with no autocaps (wi-fi names, etc).
    @ViewBuilder func plainInput() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    /// Inline navigation title on iOS.
    @ViewBuilder func inlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// Full-screen cover on iOS, sheet elsewhere.
    @ViewBuilder func andiFullScreen<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        #if os(iOS)
        fullScreenCover(isPresented: isPresented, content: content)
        #else
        sheet(isPresented: isPresented, content: content)
        #endif
    }
}

// MARK: - Readable labels for Core enums (UI-only)

extension ShareLevel {
    var uiLabel: String {
        switch self {
        case .none: "nothing"
        case .status: "how i'm doing"
        case .status_and_reason: "how i'm doing and why"
        }
    }
}

extension PlaceKind {
    var uiLabel: String {
        switch self {
        case .bar: "bar"
        case .liquor_store: "liquor store"
        case .other: "somewhere else"
        }
    }

    var uiSymbol: String {
        switch self {
        case .bar: "wineglass"
        case .liquor_store: "storefront"
        case .other: "mappin"
        }
    }
}

extension String {
    var andiTrimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
