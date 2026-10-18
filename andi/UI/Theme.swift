import SwiftUI

// Base design tokens. Intentionally small so the whole look can be restyled from here.
//
// The look: true black, one soft glow, glass cards with hairline edges, a cream pill for the main
// action, quiet caps labels. Ember orange is reserved for "i need help now" so it always stands out.

enum Theme {
    // MARK: Colors
    static let background = Color.black
    static let card = Color.white.opacity(0.06)       // glass
    static let cardRaised = Color.white.opacity(0.10)
    static let hairline = Color.white.opacity(0.09)
    static let text = rgb(0xF5F2EC)                   // warm off-white
    static let muted = rgb(0x8F8A84)
    static let faint = rgb(0x55514D)

    /// The main action: a cream pill with near-black text.
    static let primary = rgb(0xF2EDE4)
    static let onPrimary = rgb(0x0B0A09)

    /// Calm mint for links, toggles and selection. Not a risk signal.
    static let accent = rgb(0x9FE3CB)
    /// Urgent help only (crisis lines, "call my person" when today looks hard).
    static let ember = rgb(0xFF6A2B)
    static let onEmber = rgb(0x1A0E08)

    /// The two colors the background glow drifts between.
    static let glowCool = rgb(0x2E8F7A)
    static let glowWarm = rgb(0xB8542A)

    static let riskLow = rgb(0x6FD6B4)       // calm teal-green
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
    static let largeTitle = Font.system(.largeTitle).weight(.semibold)
    /// A screen's one big heading (onboarding questions, "hi, i'm andi.").
    static let screenTitle = Font.system(.title).weight(.semibold)
    static let title = Font.system(.title2).weight(.semibold)
    static let headline = Font.headline
    static let body = Font.body
    static let caption = Font.footnote
    /// Small caps section labels ("YOUR PERSON"). Use with `.andiLabel()` for the tracking.
    static let label = Font.caption.weight(.medium)

    // MARK: Spacing
    static let gutter: CGFloat = 20
    static let corner: CGFloat = 22

    private static func rgb(_ hex: UInt32) -> Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

// MARK: - Button styles

/// Cream pill: the one main action on a screen.
struct AndiPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 17)
            .padding(.horizontal, 20)
            .foregroundStyle(Theme.onPrimary.opacity(isEnabled ? 1 : 0.5))
            .background(
                Capsule().fill(Theme.primary.opacity(isEnabled ? 1 : 0.25))
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

/// Glass pill: secondary actions.
struct AndiSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 17)
            .padding(.horizontal, 20)
            .foregroundStyle(Theme.text.opacity(isEnabled ? 1 : 0.4))
            .background(
                Capsule().fill(configuration.isPressed ? Theme.cardRaised : Theme.card)
            )
            .overlay(Capsule().strokeBorder(Theme.hairline))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

/// Ember pill: urgent help only.
struct AndiUrgentButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 17)
            .padding(.horizontal, 20)
            .foregroundStyle(Theme.onEmber)
            .background(
                Capsule().fill(Theme.ember.opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.35))
            )
            .shadow(color: Theme.ember.opacity(isEnabled ? 0.35 : 0), radius: 18, y: 4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == AndiPrimaryButtonStyle {
    static var andiPrimary: AndiPrimaryButtonStyle { AndiPrimaryButtonStyle() }
}

extension ButtonStyle where Self == AndiSecondaryButtonStyle {
    static var andiSecondary: AndiSecondaryButtonStyle { AndiSecondaryButtonStyle() }
}

extension ButtonStyle where Self == AndiUrgentButtonStyle {
    static var andiUrgent: AndiUrgentButtonStyle { AndiUrgentButtonStyle() }
}

// MARK: - Background glow

/// True black with one soft, slowly drifting glow. `tint` overrides the cool glow (e.g. a risk color).
struct AndiGlow: View {
    var tint: Color = Theme.glowCool
    var warm: Color = Theme.glowWarm
    /// 0 = top of the screen, 1 = bottom.
    var anchor: CGFloat = 0.0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            blobs(w: w, h: h, phase: drift)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 7).repeatForever(autoreverses: true)) { drift = true }
        }
        .background(Theme.background)
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func blobs(w: CGFloat, h: CGFloat, phase: Bool) -> some View {
        ZStack {
            Theme.background
            Ellipse()
                .fill(tint.opacity(0.55))
                .frame(width: w * 1.1, height: w * 0.8)
                .position(x: w * (phase ? 0.30 : 0.42), y: h * anchor + (phase ? 10 : -30))
                .blur(radius: 90)
            Ellipse()
                .fill(warm.opacity(0.30))
                .frame(width: w * 0.8, height: w * 0.6)
                .position(x: w * (phase ? 0.88 : 0.75), y: h * anchor + w * 0.25 + (phase ? -20 : 20))
                .blur(radius: 100)
        }
    }
}

// MARK: - View helpers

extension View {
    /// A glass card: faint white fill and a hairline edge.
    func andiCard(padding: CGFloat = 18) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.corner, style: .continuous).fill(Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.corner, style: .continuous).strokeBorder(Theme.hairline)
            )
    }

    /// Small caps label style ("YOUR PERSON").
    func andiLabel() -> some View {
        font(Theme.label)
            .textCase(.uppercase)
            .tracking(1.4)
            .foregroundStyle(Theme.muted)
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
