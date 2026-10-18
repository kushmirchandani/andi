import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    @State private var showBreathe = false
    @State private var showCheckIn = false
    @State private var confirmSlip = false
    @State private var slipMessage: String?
    @State private var showSlipMessage = false
    @State private var callStatus: String?
    @State private var isCalling = false
    private let router = AndiRouter.shared

    var body: some View {
        ScrollView {
            if let me = model.me {
                content(me)
            } else if let error = model.lastError {
                ContentUnavailableView {
                    Label("can't load your day", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("try again") { Task { await model.refresh() } }
                        .buttonStyle(.andiSecondary)
                        .fixedSize()
                }
                .padding(.top, 80)
                CrisisFooter().padding(.top, 24)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 120)
                    .accessibilityLabel("loading")
            }
        }
        .background { AndiGlow(tint: glowTint, anchor: 0.40) }
        .refreshable { await model.refresh() }
        .navigationTitle("andi")
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .principal) {
                AndiWordmark()
            }
            ToolbarItem(placement: .navigation) {
                NavigationLink {
                    PlacesView()
                } label: {
                    Label("places", systemImage: "mappin.and.ellipse")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("settings", systemImage: "gearshape")
                }
            }
        }
        .andiFullScreen(isPresented: $showBreathe) {
            BreatheView().environment(model)
        }
        .sheet(isPresented: $showCheckIn) {
            CheckInSheet().environment(model)
        }
        .confirmationDialog("did you have a drink?", isPresented: $confirmSlip, titleVisibility: .visible) {
            Button("yes, i slipped") { reportSlip() }
            Button("not right now", role: .cancel) {}
        } message: {
            Text("it's okay. telling andi is a good step, and your progress still counts.")
        }
        .alert("you don't have to carry this alone", isPresented: safetyAlertShown) {
            Button("call 988") {
                model.safetyMessage = nil
                if let call = CrisisLine.call988 { openURL(call) }
            }
            Button("text 988") {
                model.safetyMessage = nil
                if let text = CrisisLine.text988 { openURL(text) }
            }
            Button("okay", role: .cancel) { model.safetyMessage = nil }
        } message: {
            Text(model.safetyMessage ?? "")
        }
        .alert("thank you for telling me", isPresented: $showSlipMessage) {
            Button("okay", role: .cancel) {}
        } message: {
            Text(slipMessage ?? "")
        }
        .andiHaptic(.success, trigger: callStatus)
        // Action Button, controls, widgets, Siri and the Live Activity all land here.
        .onChange(of: router.pending, initial: true) { _, route in
            guard route != nil else { return }
            handle(router.consume())
        }
        #if DEBUG
        // `-ANDI_DEMO_SHEET checkin | breathe`: open a sheet at launch, for UI work.
        .task {
            guard model.isDemo else { return }
            switch UserDefaults.standard.string(forKey: "ANDI_DEMO_SHEET") {
            case "checkin": showCheckIn = true
            case "breathe": showBreathe = true
            default: break
            }
        }
        #endif
    }

    private func handle(_ route: AndiRoute?) {
        switch route {
        case .breathe:
            showBreathe = true
        case .text:
            if let url = model.textAndiURL() { openURL(url) }
        case .home, .none:
            break
        }
    }

    private var safetyAlertShown: Binding<Bool> {
        Binding(get: { model.safetyMessage != nil }, set: { if !$0 { model.safetyMessage = nil } })
    }

    private var glowTint: Color {
        switch model.me?.risk?.level {
        case .high: Theme.riskHigh
        case .elevated: Theme.riskElevated
        default: Theme.glowCool
        }
    }

    // MARK: Content

    @ViewBuilder private func content(_ me: Me) -> some View {
        VStack(spacing: 0) {
            hero(me)
                .containerRelativeFrame(.vertical) { height, _ in height + 20 } // fills the screen; the next card just peeks in

            more(me)
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, Theme.gutter)
        }
        .frame(maxWidth: .infinity)
    }

    /// The first screen: the day count, one way to reach out, and two quiet tools. Nothing else.
    private func hero(_ me: Me) -> some View {
        let urgent = me.risk?.level == .high
        return VStack(spacing: 0) {
            if !me.imessageLinked {
                linkBanner
                    .padding(.horizontal, Theme.gutter)
                    .padding(.top, 8)
            }

            Spacer(minLength: 24)

            VStack(spacing: 6) {
                DayCount(day: me.day)
                Text(me.day == 1 ? "day" : "days").andiLabel()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(me.day) \(me.day == 1 ? "day" : "days")")
            .accessibilityValue(riskLine(me.risk?.level))
            .accessibilityAddTraits(.isHeader)

            Text(riskLine(me.risk?.level))
                .font(Theme.body)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.top, 18)
                .accessibilityHidden(true) // read as the day count's value

            Spacer(minLength: 24)

            VStack(spacing: 16) {
                if urgent, let sponsor = me.sponsor {
                    // Today looks hard: reaching their person is the loudest thing on screen.
                    callButton(sponsor, urgent: true)
                    talkButton(style: .secondary)
                } else {
                    talkButton(style: .primary)
                }

                HStack(spacing: 0) {
                    QuietAction(symbol: "wind", title: "breathe") { showBreathe = true }
                    Rectangle().fill(Theme.hairline).frame(width: 1, height: 20)
                    QuietAction(symbol: "heart.text.square", title: "check in") { showCheckIn = true }
                }

                if urgent, let callStatus {
                    Text(callStatus)
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, Theme.gutter)

        }
    }

    /// One swipe down: your person, what you've built, your why.
    private func more(_ me: Me) -> some View {
        VStack(spacing: 28) {
            stats(me)

            section("your person") { personCard(me) }

            if let why = me.why?.andiTrimmed, !why.isEmpty {
                section("your why") {
                    Text("\u{201C}\(why)\u{201D}")
                        .font(.system(.title3, design: .serif).italic())
                        .foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .andiCard(padding: 20)
                }
            }

            if let error = model.lastError {
                ErrorBanner(message: error) {
                    model.lastError = nil
                    Task { await model.refresh() }
                }
            }

            VStack(spacing: 14) {
                Button("i slipped") { confirmSlip = true }
                    .font(Theme.caption.weight(.medium))
                    .foregroundStyle(Theme.muted)
                    .accessibilityHint("tell andi you had a drink. no judgment.")
                CrisisFooter()
            }
            .padding(.top, 4)
        }
    }

    private enum TalkStyle { case primary, secondary }

    @ViewBuilder private func talkButton(style: TalkStyle) -> some View {
        let button = Button {
            if let url = model.textAndiURL() { openURL(url) }
        } label: {
            HStack(spacing: 8) {
                Text("talk to andi")
                Image(systemName: "arrow.right")
                    .font(.subheadline.weight(.semibold))
            }
        }
        .disabled(model.textAndiURL() == nil)
        .accessibilityHint("opens your conversation with andi in messages")

        switch style {
        case .primary: button.buttonStyle(.andiPrimary)
        case .secondary: button.buttonStyle(.andiSecondary)
        }
    }

    private func callButton(_ sponsor: Sponsor, urgent: Bool) -> some View {
        Button {
            callPerson()
        } label: {
            if isCalling {
                ProgressView().tint(urgent ? Theme.onEmber : Theme.onPrimary)
            } else {
                Label("call \(sponsor.name)", systemImage: "phone.fill")
            }
        }
        .modifier(CallButtonStyle(urgent: urgent))
        .disabled(isCalling)
        .accessibilityLabel(isCalling ? "reaching your person" : "call \(sponsor.name)")
    }

    private func stats(_ me: Me) -> some View {
        HStack(spacing: 12) {
            StatTile(
                value: Text(me.moneySaved, format: .currency(code: currencyCode).precision(.fractionLength(0))),
                label: "saved"
            )
            StatTile(value: Text(dayOne(me.soberSince)), label: "day one")
        }
    }

    @ViewBuilder private func personCard(_ me: Me) -> some View {
        if let sponsor = me.sponsor {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Text(String(sponsor.name.prefix(1)).uppercased())
                        .font(.title3.weight(.semibold))
                        .frame(width: 48, height: 48)
                        .background(Circle().fill(Theme.cardRaised))
                        .overlay(Circle().strokeBorder(Theme.hairline))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(sponsor.name)
                            .font(Theme.headline)
                        HStack(spacing: 6) {
                            Circle()
                                .fill(sponsor.linked ? Theme.riskLow : Theme.faint)
                                .frame(width: 6, height: 6)
                            Text(sponsor.linked ? "connected with andi" : "not connected yet")
                                .font(Theme.caption)
                                .foregroundStyle(Theme.muted)
                        }
                    }
                    Spacer()
                }
                .accessibilityElement(children: .combine)

                callButton(sponsor, urgent: me.risk?.level == .high)

                if let callStatus {
                    Text(callStatus)
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                        .transition(.opacity)
                }
                if !sponsor.linked, let invite = model.sponsorInviteURL() {
                    // Andi can only reach their person after that person texts Andi once.
                    Button("invite \(sponsor.name) to connect") { openURL(invite) }
                        .font(Theme.caption.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .accessibilityHint("opens messages with an invite for \(sponsor.name)")
                }
            }
            .andiCard()
        } else {
            NavigationLink {
                SettingsView()
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.title2)
                        .foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("add your person")
                            .font(Theme.headline)
                            .foregroundStyle(Theme.text)
                        Text("someone andi can call with you on hard days.")
                            .font(Theme.caption)
                            .foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.faint)
                        .accessibilityHidden(true)
                }
                .andiCard()
            }
            .buttonStyle(.plain)
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).andiLabel()
                .padding(.leading, 4)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private var linkBanner: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: "message.badge")
                .font(.title2)
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("finish setting up")
                    .font(Theme.headline)
                Text("send andi one text so andi can be in your messages.")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if let url = model.smsURL() {
                Button("text") { openURL(url) }
                    .font(Theme.caption.weight(.semibold))
                    .foregroundStyle(Theme.onPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Theme.primary))
                    .accessibilityLabel("text andi")
            }
        }
        .andiCard()
    }

    private func dayOne(_ soberSince: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: String(soberSince.prefix(10))) else { return soberSince }
        let sameYear = Calendar.current.isDate(date, equalTo: .now, toGranularity: .year)
        return date.formatted(sameYear ? .dateTime.month(.abbreviated).day() : .dateTime.month(.abbreviated).day().year())
    }

    // MARK: Actions

    private func callPerson() {
        isCalling = true
        Task {
            let status = await model.callPerson()
            withAnimation {
                callStatus = status
                isCalling = false
            }
        }
    }

    private func reportSlip() {
        Task {
            if let message = await model.reportSlip(note: nil), !message.isEmpty {
                slipMessage = message
                showSlipMessage = true
            }
        }
    }

    // MARK: Copy

    private func riskLine(_ level: RiskLevel?) -> String {
        switch level {
        case .high: "today looks hard. andi's right here."
        case .elevated: "a little wobbly today. go gently."
        case .low, .none: "steady. one day at a time."
        }
    }

    private var currencyCode: String {
        Locale.current.currency?.identifier ?? "USD"
    }
}

// MARK: - Day count

private struct DayCount: View {
    let day: Int
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 168

    init(day: Int) {
        self.day = day
    }

    var body: some View {
        Text("\(day)")
            .font(.system(size: size, weight: .ultraLight))
            .monospacedDigit()
            .shadow(color: .white.opacity(0.25), radius: 24)
            .contentTransition(.numericText())
            .minimumScaleFactor(0.5)
            .lineLimit(1)
    }
}

// MARK: - Quiet actions

/// A small icon + word action, for the tools under the main button.
private struct QuietAction: View {
    let symbol: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(TilePressStyle())
    }
}

// MARK: - Tiles

private struct StatTile: View {
    let value: Text
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            value
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label).andiLabel()
        }
        .andiCard()
        .accessibilityElement(children: .combine)
    }
}

private struct TilePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// Cream normally; ember when today looks hard, so reaching out is the loudest thing on screen.
private struct CallButtonStyle: ViewModifier {
    let urgent: Bool

    func body(content: Content) -> some View {
        if urgent {
            content.buttonStyle(.andiUrgent)
        } else {
            content.buttonStyle(.andiPrimary)
        }
    }
}

// MARK: - Previews

#Preview("home · low") {
    NavigationStack { HomeView() }
        .environment(AppModel.preview())
        .preferredColorScheme(.dark)
}

#Preview("home · high, no person") {
    let model = AppModel.preview(me: {
        var me = MockData.sample(risk: .high)
        me.sponsor = nil
        return me
    }())
    return NavigationStack { HomeView() }
        .environment(model)
        .preferredColorScheme(.dark)
}

#Preview("home · not linked") {
    NavigationStack { HomeView() }
        .environment(AppModel.preview(me: MockData.newcomer, onboard: MockData.onboardResponse()))
        .preferredColorScheme(.dark)
}

#Preview("home · error") {
    let model = AppModel.preview(me: nil)
    model.lastError = APIError.offline.message
    return NavigationStack { HomeView() }
        .environment(model)
        .preferredColorScheme(.dark)
}
