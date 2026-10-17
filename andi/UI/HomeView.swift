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

    var body: some View {
        ScrollView {
            if let me = model.me {
                content(me)
                    .padding(Theme.gutter)
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
        .background(Theme.background.ignoresSafeArea())
        .refreshable { await model.refresh() }
        .navigationTitle("andi")
        .inlineTitle()
        .toolbar {
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
    }

    private var safetyAlertShown: Binding<Bool> {
        Binding(get: { model.safetyMessage != nil }, set: { if !$0 { model.safetyMessage = nil } })
    }

    // MARK: Content

    @ViewBuilder private func content(_ me: Me) -> some View {
        VStack(spacing: 28) {
            if !me.imessageLinked {
                linkBanner
            }

            RiskGlow(level: me.risk?.level) {
                VStack(spacing: 0) {
                    DayCount(day: me.day)
                    Text(me.day == 1 ? "day" : "days")
                        .font(Theme.title)
                        .foregroundStyle(Theme.muted)
                }
            }
            .padding(.top, 12)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(me.day) \(me.day == 1 ? "day" : "days")")
            .accessibilityValue(riskLine(me.risk?.level))
            .accessibilityAddTraits(.isHeader)

            VStack(spacing: 6) {
                Text(riskLine(me.risk?.level))
                    .font(Theme.body)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .accessibilityHidden(true) // read as the day count's value
                if me.moneySaved > 0 {
                    Text("\(Text(me.moneySaved, format: .currency(code: currencyCode).precision(.fractionLength(0))).foregroundStyle(Theme.text)) saved so far")
                        .font(Theme.headline)
                        .foregroundStyle(Theme.muted)
                }
            }

            actions(me)

            if let error = model.lastError {
                ErrorBanner(message: error) {
                    model.lastError = nil
                    Task { await model.refresh() }
                }
            }

            Button("i slipped") { confirmSlip = true }
                .font(Theme.caption)
                .foregroundStyle(Theme.muted)
                .padding(.top, 8)
                .accessibilityHint("tell andi you had a drink. no judgment.")

            CrisisFooter()
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
    }

    private func actions(_ me: Me) -> some View {
        VStack(spacing: 12) {
            Button {
                callPerson()
            } label: {
                if isCalling {
                    ProgressView().tint(Theme.onAccent)
                } else {
                    Label(me.sponsor.map { "call \($0.name)" } ?? "call my person", systemImage: "phone.fill")
                }
            }
            .buttonStyle(.andiPrimary)
            .disabled(me.sponsor == nil || isCalling)
            .accessibilityLabel(isCalling ? "reaching your person" : (me.sponsor.map { "call \($0.name)" } ?? "call my person"))

            if me.sponsor == nil {
                Text("add your person in settings to call them from here.")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
            } else {
                if let callStatus {
                    Text(callStatus)
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                        .transition(.opacity)
                }
                if let sponsor = me.sponsor, !sponsor.linked, let invite = model.sponsorInviteURL() {
                    // Andi can only reach their person after that person texts Andi once.
                    Button("\(sponsor.name) isn't connected yet · invite them") { openURL(invite) }
                        .font(Theme.caption)
                        .foregroundStyle(Theme.accent)
                        .accessibilityHint("opens messages with an invite for \(sponsor.name)")
                }
            }

            HStack(spacing: 12) {
                Button {
                    showBreathe = true
                } label: {
                    Label("breathe", systemImage: "wind")
                }
                .buttonStyle(.andiSecondary)

                Button {
                    showCheckIn = true
                } label: {
                    Label("check in", systemImage: "heart.text.square")
                }
                .buttonStyle(.andiSecondary)
            }
        }
    }

    private var linkBanner: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "message.badge")
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text("andi isn't in your messages yet")
                    .font(Theme.headline)
                Text("send andi a text to finish setting up.")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
                if let url = model.smsURL() {
                    Button("text andi") { openURL(url) }
                        .font(Theme.caption.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                }
            }
        }
        .andiCard()
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
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 96

    init(day: Int) {
        self.day = day
    }

    var body: some View {
        Text("\(day)")
            .font(.system(size: size, weight: .light, design: .rounded))
            .monospacedDigit()
            .contentTransition(.numericText())
            .minimumScaleFactor(0.5)
            .lineLimit(1)
    }
}

// MARK: - Risk glow ring

private struct RiskGlow<Content: View>: View {
    let level: RiskLevel?
    let content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var diameter: CGFloat = 240

    init(level: RiskLevel?, @ViewBuilder content: () -> Content) {
        self.level = level
        self.content = content()
    }

    var body: some View {
        let size = min(diameter, 320) // keep the ring on screen at the largest text sizes
        Group {
            if reduceMotion {
                ring(glowing: false)
            } else {
                PhaseAnimator([false, true]) { glowing in
                    ring(glowing: glowing)
                } animation: { _ in
                    .easeInOut(duration: 3)
                }
            }
        }
        .frame(width: size, height: size)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: level)
    }

    private func ring(glowing: Bool) -> some View {
        let color = Theme.riskColor(level)
        return ZStack {
            Circle()
                .fill(color.opacity(0.08))
            Circle()
                .strokeBorder(color.opacity(0.85), lineWidth: 3)
                .shadow(color: color.opacity(glowing ? 0.7 : 0.35), radius: glowing ? 36 : 18)
            content
                .padding(24)
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
