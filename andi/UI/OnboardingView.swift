import SwiftUI

// MARK: - Onboarding (paged steps)

struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    private enum Step: Int, CaseIterable {
        case welcome, basics, safety, person, share, why
    }

    @State private var step: Step = .welcome

    // basics
    @State private var name = ""
    @State private var phone = ""
    @State private var soberSince = Date.now
    @State private var weeklySpend = ""
    // safety
    @State private var drinksPerDay = 0
    @State private var drinksDaily = false
    @State private var morningDrinking = false
    @State private var pastWithdrawal = false
    // your person
    @State private var personName = ""
    @State private var personPhone = ""
    // sharing + why
    @State private var consents = Consents.defaults
    @State private var why = ""

    @State private var validationMessage: String?
    @State private var showServer = false

    private enum Field: Hashable { case name, phone, spend, personName, personPhone, why }
    @FocusState private var focus: Field?

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        VStack(spacing: 0) {
            ProgressDots(count: Step.allCases.count, current: step.rawValue)
                .padding(.top, 12)
                .padding(.bottom, 8)

            ScrollView {
                stepContent
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.gutter)
                    .id(step)
                    .transition(.opacity)
            }
            .scrollDismissesKeyboard(.interactively)

            footer
        }
        .background(Theme.background.ignoresSafeArea())
        .keyboardDoneButton { focus = nil }
        .sheet(isPresented: $showServer) {
            ServerSheet().environment(model)
        }
    }

    // MARK: Steps

    @ViewBuilder private var stepContent: some View {
        switch step {
        case .welcome: welcome
        case .basics: basics
        case .safety: safety
        case .person: person
        case .share: share
        case .why: whyStep
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "sparkle")
                .font(.largeTitle)
                .foregroundStyle(Theme.accent)
                .padding(.top, 40)
                .accessibilityHidden(true)
            Text("hi, i'm andi.")
                .font(Theme.largeTitle)
            Text("i live in your messages. text me any time, day or night: when it's hard, when it's good, or when you just need someone.")
                .font(Theme.body)
                .foregroundStyle(Theme.muted)
            Text("a few quick questions and we're set.")
                .font(Theme.body)
                .foregroundStyle(Theme.muted)

            #if DEBUG
            Button {
                showServer = true
            } label: {
                Label("server: \(model.baseURL.host() ?? model.baseURL.absoluteString)", systemImage: "server.rack")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
            }
            .buttonStyle(.plain)
            .padding(.top, 24)
            .accessibilityHint("developer setting: change which server andi uses")
            #endif
        }
    }

    private var basics: some View {
        VStack(alignment: .leading, spacing: 20) {
            StepHeader(title: "the basics", subtitle: "so andi knows who it's talking to.")

            FieldGroup(label: "what should andi call you?") {
                TextField("first name", text: $name)
                    .nameInput()
                    .focused($focus, equals: .name)
                    .submitLabel(.next)
                    .onSubmit { focus = .phone }
            }
            FieldGroup(label: "your phone number") {
                TextField("phone", text: $phone)
                    .phoneInput()
                    .focused($focus, equals: .phone)
            }
            FieldGroup(label: "sober since") {
                DatePicker("sober since", selection: $soberSince, in: ...Date.now, displayedComponents: .date)
                    .labelsHidden()
            }
            FieldGroup(label: "about how much did you spend on drinks a week?",
                       footnote: "optional. andi uses it to show what you're saving.") {
                TextField("e.g. 60", text: $weeklySpend)
                    .decimalInput()
                    .focused($focus, equals: .spend)
            }
        }
    }

    private var safety: some View {
        VStack(alignment: .leading, spacing: 20) {
            StepHeader(
                title: "keeping you safe",
                subtitle: "stopping suddenly can be hard on your body. this helps andi know if you should talk to a doctor first. there are no wrong answers."
            )

            VStack(spacing: 16) {
                Stepper(value: $drinksPerDay, in: 0...40) {
                    Text(drinksPerDay == 1 ? "about 1 drink a day" : "about \(drinksPerDay) drinks a day")
                }
                Divider()
                Toggle("i drink most days or every day", isOn: $drinksDaily)
                Divider()
                Toggle("i sometimes need a drink in the morning", isOn: $morningDrinking)
                Divider()
                Toggle("i've had shakes, sweats, or seizures when i stopped before", isOn: $pastWithdrawal)
            }
            .andiCard()
        }
    }

    private var person: some View {
        VStack(alignment: .leading, spacing: 20) {
            StepHeader(
                title: "your person",
                subtitle: "someone you trust: a sponsor, friend, or family member. andi can reach out to them when you want it to. you can skip this."
            )
            FieldGroup(label: "their name") {
                TextField("name", text: $personName)
                    .nameInput()
                    .focused($focus, equals: .personName)
                    .submitLabel(.next)
                    .onSubmit { focus = .personPhone }
            }
            FieldGroup(label: "their phone") {
                TextField("phone", text: $personPhone)
                    .phoneInput()
                    .focused($focus, equals: .personPhone)
            }
        }
    }

    private var share: some View {
        VStack(alignment: .leading, spacing: 20) {
            StepHeader(title: "what andi can use", subtitle: "you're in charge. change any of this later in settings.")

            VStack(spacing: 16) {
                Toggle("notice when i'm near places i mark as risky", isOn: $consents.location)
                Divider()
                Toggle("notice drink purchases", isOn: $consents.purchases)
                Divider()
                Toggle("let my person know when things look hard", isOn: $consents.sponsorAlerts)
            }
            .andiCard()

            FieldGroup(label: "what your person can see") {
                Picker("what your person can see", selection: $consents.shareWithSponsor) {
                    ForEach(ShareLevel.allCases, id: \.self) { level in
                        Text(level.uiLabel).tag(level)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
        }
    }

    private var whyStep: some View {
        VStack(alignment: .leading, spacing: 20) {
            StepHeader(
                title: "your why",
                subtitle: "what are you doing this for? andi will remind you on the hard days. optional."
            )
            TextField("for my kids, for my mornings, for me…", text: $why, axis: .vertical)
                .lineLimit(4...8)
                .focused($focus, equals: .why)
                .andiCard()
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 12) {
            if let message = validationMessage ?? model.lastError {
                Text(message)
                    .font(Theme.caption)
                    .foregroundStyle(Theme.riskElevated)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }

            HStack(spacing: 12) {
                if step != .welcome {
                    Button("back") { go(to: step.rawValue - 1) }
                        .buttonStyle(.andiSecondary)
                        .disabled(model.isBusy)
                }
                Button {
                    next()
                } label: {
                    if model.isBusy {
                        ProgressView().tint(Theme.onAccent)
                    } else {
                        Text(primaryTitle)
                    }
                }
                .buttonStyle(.andiPrimary)
                .disabled(model.isBusy)
            }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, 16)
        .background(Theme.background)
    }

    private var primaryTitle: String {
        switch step {
        case .welcome: "let's start"
        case .person: (personName.andiTrimmed.isEmpty && personPhone.andiTrimmed.isEmpty) ? "skip for now" : "next"
        case .why: "finish"
        default: "next"
        }
    }

    // MARK: Navigation + validation

    private func go(to raw: Int) {
        guard let target = Step(rawValue: raw) else { return }
        validationMessage = nil
        model.lastError = nil
        withAnimation(.easeInOut(duration: 0.25)) { step = target }
    }

    private func next() {
        focus = nil
        if let problem = validate(step) {
            validationMessage = problem
            return
        }
        if step == .why {
            Task { await submit() }
        } else {
            go(to: step.rawValue + 1)
        }
    }

    private func validate(_ step: Step) -> String? {
        switch step {
        case .basics:
            if name.andiTrimmed.isEmpty { return "what should andi call you?" }
            if PhoneNumber.normalize(phone) == nil { return "that phone number doesn't look right. include the area code." }
            if Calendar.current.startOfDay(for: soberSince) > Calendar.current.startOfDay(for: .now) {
                return "pick today or a day before."
            }
            if !weeklySpend.andiTrimmed.isEmpty && parsedSpend == nil {
                return "that spend amount doesn't look like a number."
            }
            if let spend = parsedSpend, spend > 10_000 {
                return "that weekly spend looks too high. check the number."
            }
        case .person:
            let hasName = !personName.andiTrimmed.isEmpty
            let hasPhoneText = !personPhone.andiTrimmed.isEmpty
            guard hasName || hasPhoneText else { break } // skipping is fine
            if !hasName { return "add their name too, or clear both to skip." }
            guard let theirs = PhoneNumber.normalize(personPhone) else {
                return hasPhoneText ? "their phone number doesn't look right. include the area code." : "add their phone too, or clear both to skip."
            }
            if theirs == PhoneNumber.normalize(phone) { return "your person needs a different number from yours." }
        default:
            break
        }
        return nil
    }

    /// Accepts "60", "$60", "60.50", "60,50" and "1,200". Nil if it isn't a non-negative number.
    private var parsedSpend: Double? {
        var cleaned = weeklySpend.andiTrimmed.filter { !$0.isWhitespace && !$0.isCurrencySymbol }
        if cleaned.contains(".") {
            cleaned = cleaned.replacingOccurrences(of: ",", with: "") // "1,200.50"
        } else if let comma = cleaned.lastIndex(of: ","), cleaned.distance(from: comma, to: cleaned.endIndex) <= 3 {
            cleaned.replaceSubrange(comma...comma, with: ".")        // "60,50"
            cleaned = cleaned.replacingOccurrences(of: ",", with: "")
        } else {
            cleaned = cleaned.replacingOccurrences(of: ",", with: "") // "1,200"
        }
        guard let value = Double(cleaned), value.isFinite, value >= 0 else { return nil }
        return value
    }

    private func submit() async {
        validationMessage = nil
        model.lastError = nil

        let sponsor: SponsorInput? = PhoneNumber.normalize(personPhone).flatMap { theirPhone in
            personName.andiTrimmed.isEmpty ? nil : SponsorInput(name: personName.andiTrimmed, phone: theirPhone)
        }
        let whyText = why.andiTrimmed

        let request = OnboardRequest(
            name: name.andiTrimmed,
            phone: PhoneNumber.normalize(phone) ?? phone.andiTrimmed,
            soberSince: Self.dayFormatter.string(from: soberSince),
            weeklyDrinkSpend: parsedSpend ?? 0,
            screening: Screening(
                drinksPerDay: Double(drinksPerDay),
                drinksDaily: drinksDaily,
                morningDrinking: morningDrinking,
                pastWithdrawal: pastWithdrawal
            ),
            sponsor: sponsor,
            consents: consents,
            why: whyText.isEmpty ? nil : String(whyText.prefix(1000))
        )

        let ok = await model.onboard(request)
        if !ok && model.lastError == nil {
            validationMessage = "something went wrong. try again in a moment."
        }
    }
}

// MARK: - Linking (account made, waiting for the first iMessage)

struct LinkingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var acknowledgedSafety = false
    @State private var confirmStartOver = false

    var body: some View {
        Group {
            if let screening = model.onboardResult?.screening, screening.medicalFirst, !acknowledgedSafety {
                MedicalFirstView(message: screening.message) {
                    withAnimation { acknowledgedSafety = true }
                }
            } else {
                linking
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private var agentHandle: String? { model.onboardResult?.agentHandle ?? model.me?.agentHandle }
    private var voiceNumber: String? { model.onboardResult?.voiceNumber ?? model.me?.voiceNumber }
    private var linkCode: String? { model.me?.linkCode ?? model.onboardResult?.linkCode }

    private var linking: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "message.fill")
                    .font(.largeTitle)
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 40)
                    .accessibilityHidden(true)

                StepHeader(
                    title: "text andi to finish",
                    subtitle: "send the first message and andi takes it from there. texting also confirms this is your number."
                )

                if let url = model.smsURL() {
                    Button {
                        openURL(url)
                    } label: {
                        Label("text andi", systemImage: "paperplane.fill")
                    }
                    .buttonStyle(.andiPrimary)
                } else {
                    ErrorBanner(message: "andi's number isn't set up on this server yet. once it is, you'll be able to text andi from here.") {
                        Task { await model.refresh() }
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    if let agentHandle {
                        InfoRow(label: "andi's number", value: agentHandle)
                    }
                    if let linkCode {
                        InfoRow(label: "your code", value: linkCode, monospaced: true)
                    }
                }
                .andiCard()

                HStack(spacing: 10) {
                    ProgressView()
                    Text("waiting for your text…")
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                }
                .accessibilityElement(children: .combine)

                if let error = model.lastError {
                    ErrorBanner(message: error) { Task { await model.refresh() } }
                }

                if let voiceNumber {
                    Text("andi can also call from \(voiceNumber). save andi to your contacts later so you know it's them.")
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                }

                Button("start over") { confirmStartOver = true }
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 8)

                CrisisFooter()
                    .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.gutter)
        }
        .task { await model.pollUntilLinked() }
        .confirmationDialog("start over?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("start over", role: .destructive) { model.signOut() }
            Button("keep going", role: .cancel) {}
        } message: {
            Text("you'll set things up again from the beginning.")
        }
    }
}

// MARK: - Medical-first safety screen

private struct MedicalFirstView: View {
    let message: String
    let onContinue: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "heart.text.square.fill")
                    .font(.largeTitle)
                    .foregroundStyle(Theme.riskElevated)
                    .padding(.top, 40)
                    .accessibilityHidden(true)

                Text("one thing first")
                    .font(Theme.largeTitle)

                Text(message)
                    .font(.title3)
                    .andiCard()

                if let samhsa = CrisisLine.samhsa {
                    Link(destination: samhsa) {
                        Label("call SAMHSA (free, 24/7)", systemImage: "phone.fill")
                    }
                    .buttonStyle(.andiPrimary)
                    .accessibilityHint("calls 1-800-662-4357")
                }

                Text("they're confidential and can help you find a doctor or a safe place to stop.")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)

                Button("i understand, continue", action: onContinue)
                    .buttonStyle(.andiSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.gutter)
        }
    }
}

// MARK: - Small building blocks

private struct ProgressDots: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index <= current ? Theme.accent : Theme.cardRaised)
                    .frame(width: index == current ? 20 : 8, height: 8)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: current)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("step \(current + 1) of \(count)")
    }
}

private struct StepHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Theme.title)
            Text(subtitle)
                .font(Theme.body)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct FieldGroup<Content: View>: View {
    let label: String
    var footnote: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(Theme.caption.weight(.medium))
                .foregroundStyle(Theme.muted)
            content
                .textFieldStyle(.plain)
                .andiCard()
            if let footnote {
                Text(footnote)
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
            }
        }
    }
}

private struct InfoRow: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(Theme.caption)
                .foregroundStyle(Theme.muted)
            Text(value)
                .font(monospaced ? Font.title3.monospaced() : Font.title3)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Previews

#Preview("onboarding") {
    OnboardingView()
        .environment(AppModel.preview(.onboarding, me: nil))
        .preferredColorScheme(.dark)
}

#Preview("linking") {
    LinkingView()
        .environment(AppModel.preview(.linking, me: MockData.newcomer, onboard: MockData.onboardResponse()))
        .preferredColorScheme(.dark)
}

#Preview("medical first") {
    LinkingView()
        .environment(AppModel.preview(.linking, me: MockData.newcomer, onboard: MockData.onboardResponse(medicalFirst: true)))
        .preferredColorScheme(.dark)
}
