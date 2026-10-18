import SwiftUI

// MARK: - Onboarding (paged steps)

struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    private enum Step: Int, CaseIterable {
        case basics, safety, person, share, why
    }

    @State private var step: Step = {
        #if DEBUG
        // `-ANDI_DEMO_STEP 1`: open on a later step, for UI work.
        if let step = Step(rawValue: UserDefaults.standard.integer(forKey: "ANDI_DEMO_STEP")) { return step }
        #endif
        return .basics
    }()

    // basics (the phone number came from the sign-in screen)
    @State private var name = ""
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

    private enum Field: Hashable { case name, spend, personName, personPhone, why }
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
        ZStack {
            AndiGlow(anchor: -0.05)

            VStack(spacing: 0) {
                topBar
                    .padding(.horizontal, Theme.gutter)
                    .padding(.top, 8)

                ScrollView {
                    stepContent
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Theme.gutter)
                        .padding(.top, 28)
                        .padding(.bottom, Theme.gutter)
                        .id(step)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity
                        ))
                }
                .scrollDismissesKeyboard(.interactively)

                footer
            }
        }
        .keyboardDoneButton { focus = nil }
    }

    private var topBar: some View {
        HStack(spacing: 14) {
            if step != .basics {
                CircleIconButton(symbol: "chevron.left", label: "back") { go(to: step.rawValue - 1) }
                    .disabled(model.isBusy)
            } else if !model.signInVerified {
                // Skipped the text: let them go back and send it after all.
                CircleIconButton(symbol: "chevron.left", label: "back") { model.phase = .signIn }
                    .disabled(model.isBusy)
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
            StepBars(count: Step.allCases.count, current: step.rawValue)
            Color.clear.frame(width: 44, height: 44)
        }
    }

    // MARK: Steps

    @ViewBuilder private var stepContent: some View {
        switch step {
        case .basics: basics
        case .safety: safety
        case .person: person
        case .share: share
        case .why: whyStep
        }
    }

    private var basics: some View {
        VStack(alignment: .leading, spacing: 24) {
            StepHeader(
                title: "let's start with you",
                subtitle: model.signInVerified
                    ? "you're verified, and andi's in your messages. a few quick questions and you're set."
                    : "so andi knows who it's talking to. a few quick questions and you're set."
            )

            FieldGroup(label: "what should andi call you?") {
                TextField("first name", text: $name)
                    .font(.title3)
                    .nameInput()
                    .focused($focus, equals: .name)
                    .submitLabel(.done)
            }
            FieldGroup(label: "sober since") {
                HStack {
                    Text("my day one")
                        .foregroundStyle(Theme.muted)
                    Spacer()
                    DatePicker("sober since", selection: $soberSince, in: ...Date.now, displayedComponents: .date)
                        .labelsHidden()
                }
            }
            FieldGroup(label: "weekly drink spend",
                       footnote: "optional. andi uses it to show what you're saving.") {
                HStack(spacing: 4) {
                    Text(currencySymbol)
                        .font(.title3)
                        .foregroundStyle(Theme.muted)
                    TextField("60", text: $weeklySpend)
                        .font(.title3)
                        .decimalInput()
                        .focused($focus, equals: .spend)
                }
            }
        }
    }

    private var safety: some View {
        VStack(alignment: .leading, spacing: 24) {
            StepHeader(
                title: "keeping you safe",
                subtitle: "stopping suddenly can be hard on your body. this helps andi know if you should talk to a doctor first. there are no wrong answers."
            )

            DrinkCounter(value: $drinksPerDay)

            VStack(spacing: 10) {
                Text("tap any that are true").andiLabel()
                    .frame(maxWidth: .infinity, alignment: .leading)
                OptionRow(title: "i drink most days or every day", selected: drinksDaily) { drinksDaily.toggle() }
                OptionRow(title: "i sometimes need a drink in the morning", selected: morningDrinking) { morningDrinking.toggle() }
                OptionRow(title: "i've had shakes, sweats, or seizures when i stopped before", selected: pastWithdrawal) { pastWithdrawal.toggle() }
            }
        }
    }

    private var person: some View {
        VStack(alignment: .leading, spacing: 24) {
            StepHeader(
                title: "who's your person?",
                subtitle: "someone you trust: a sponsor, friend, or family member. andi can reach out to them when you want it to. you can skip this."
            )
            FieldGroup(label: "their name") {
                TextField("name", text: $personName)
                    .font(.title3)
                    .nameInput()
                    .focused($focus, equals: .personName)
                    .submitLabel(.next)
                    .onSubmit { focus = .personPhone }
            }
            FieldGroup(label: "their phone") {
                TextField("phone", text: $personPhone)
                    .font(.title3)
                    .phoneInput()
                    .focused($focus, equals: .personPhone)
            }
        }
    }

    private var share: some View {
        VStack(alignment: .leading, spacing: 24) {
            StepHeader(title: "what andi can use", subtitle: "you're in charge. change any of this later in settings.")

            VStack(spacing: 10) {
                Text("andi can").andiLabel()
                    .frame(maxWidth: .infinity, alignment: .leading)
                OptionRow(title: "notice when i'm near places i mark as risky", selected: consents.location) { consents.location.toggle() }
                OptionRow(title: "notice drink purchases", selected: consents.purchases) { consents.purchases.toggle() }
                OptionRow(title: "let my person know when things look hard", selected: consents.sponsorAlerts) { consents.sponsorAlerts.toggle() }
            }

            VStack(spacing: 10) {
                Text("what your person can see").andiLabel()
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(ShareLevel.allCases, id: \.self) { level in
                    OptionRow(title: level.uiLabel, selected: consents.shareWithSponsor == level) {
                        consents.shareWithSponsor = level
                    }
                }
            }
        }
    }

    private var whyStep: some View {
        VStack(alignment: .leading, spacing: 24) {
            StepHeader(
                title: "what's your why?",
                subtitle: "what are you doing this for? andi will remind you on the hard days. optional."
            )
            TextField("for my kids, for my mornings, for me…", text: $why, axis: .vertical)
                .font(.title3)
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

            Button {
                next()
            } label: {
                if model.isBusy {
                    ProgressView().tint(Theme.onPrimary)
                } else {
                    Text(primaryTitle)
                }
            }
            .buttonStyle(.andiPrimary)
            .disabled(model.isBusy)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private var currencySymbol: String {
        Locale.current.currencySymbol ?? "$"
    }

    private var primaryTitle: String {
        switch step {
        case .person: (personName.andiTrimmed.isEmpty && personPhone.andiTrimmed.isEmpty) ? "skip for now" : "continue"
        case .why: why.andiTrimmed.isEmpty ? "skip and finish" : "finish"
        default: "continue"
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
            if theirs == model.signInPhone { return "your person needs a different number from yours." }
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
            phone: model.signInPhone, // the model sends the sign-in instead when it has one
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

// MARK: - Sign in (the first screen)

/// Phone number, then "text andi". The server answers the same way for every number; Andi's reply
/// to the text (and this screen moving on) is the only place an existing account shows.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var phone = ""
    @State private var validationMessage: String?
    @State private var showServer = false
    @FocusState private var phoneFocused: Bool

    var body: some View {
        ZStack {
            AndiGlow(anchor: model.signIn == nil ? 0.05 : 0.18)

            VStack(spacing: 0) {
                topBar
                    .padding(.horizontal, Theme.gutter)
                    .padding(.top, 8)

                ScrollView {
                    Group {
                        if let signIn = model.signIn {
                            textAndi(signIn)
                        } else {
                            enterNumber
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, Theme.gutter)
                    .transition(.opacity)
                }
                .scrollDismissesKeyboard(.interactively)

                footer
            }
        }
        .animation(.easeInOut(duration: 0.3), value: model.signIn)
        .keyboardDoneButton { phoneFocused = false }
        .sheet(isPresented: $showServer) {
            ServerSheet().environment(model)
        }
    }

    private var topBar: some View {
        ZStack {
            AndiWordmark()
            HStack {
                if model.signIn != nil {
                    CircleIconButton(symbol: "chevron.left", label: "use a different number") { model.cancelSignIn() }
                }
                Spacer()
                #if DEBUG
                if model.signIn == nil {
                    CircleIconButton(symbol: "server.rack", label: "server: \(model.baseURL.host() ?? model.baseURL.absoluteString)") {
                        showServer = true
                    }
                    .opacity(0.6)
                    .accessibilityHint("developer setting: change which server andi uses")
                }
                #endif
            }
        }
        .frame(height: 44)
    }

    private var enterNumber: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("hi, i'm andi.")
                .font(Theme.largeTitle)
                .padding(.top, 56)
            Text("i live in your messages. text me any time, day or night: when it's hard, when it's good, or when you just need someone.")
                .font(Theme.body)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 10) {
                Text("your number").andiLabel()
                TextField("(555) 555-0123", text: $phone)
                    .font(.system(.title, design: .default).weight(.medium))
                    .monospacedDigit()
                    .phoneInput()
                    .focused($phoneFocused)
                    .submitLabel(.continue)
                    .onSubmit(submit)
                    .padding(.vertical, 4)
                    .andiCard()
                Label("new or coming back, start here. andi texts you to check it's yours, and never shares your number.", systemImage: "lock.fill")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
                    .labelStyle(TopAlignedLabelStyle())
            }
            .padding(.top, 28)
        }
    }

    private func textAndi(_ signIn: SignInStart) -> some View {
        VStack(spacing: 22) {
            GlowIcon(symbol: "message.fill")
                .padding(.top, 36)

            VStack(spacing: 10) {
                Text("text andi to continue")
                    .font(Theme.screenTitle)
                Text("hit send on the message below. andi texts you back, and that's how andi knows this number is yours.")
                    .font(Theme.body)
                    .foregroundStyle(Theme.muted)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)

            MessagePreview(to: signIn.agentHandle, text: "\(signIn.firstText) \(signIn.linkCode)")

            if model.signInSMSURL() == nil {
                ErrorBanner(message: "andi's number isn't set up on this server yet. you can skip this and text andi later.") {
                    model.cancelSignIn()
                }
            }

            WaitingIndicator(text: "waiting for your text…")

            if let error = model.lastError {
                Text(error)
                    .font(Theme.caption)
                    .foregroundStyle(Theme.riskElevated)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .task(id: signIn.signInToken) { await model.pollSignIn() }
    }

    @ViewBuilder private var footer: some View {
        VStack(spacing: 14) {
            if model.signIn != nil {
                if let url = model.signInSMSURL() {
                    Button {
                        openURL(url)
                    } label: {
                        Label("open messages", systemImage: "arrow.up.message.fill")
                    }
                    .buttonStyle(.andiPrimary)
                }
                Button("new here? skip for now and text later") { model.skipSignIn() }
                    .font(Theme.caption.weight(.medium))
                    .foregroundStyle(Theme.text)
            } else {
                if let message = validationMessage ?? model.lastError {
                    Text(message)
                        .font(Theme.caption)
                        .foregroundStyle(Theme.riskElevated)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                Button {
                    submit()
                } label: {
                    if model.isBusy {
                        ProgressView().tint(Theme.onPrimary)
                    } else {
                        Text("continue")
                    }
                }
                .buttonStyle(.andiPrimary)
                .disabled(model.isBusy || phone.andiTrimmed.isEmpty)
            }
            CrisisFooter()
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private func submit() {
        phoneFocused = false
        validationMessage = nil
        guard PhoneNumber.normalize(phone) != nil else {
            validationMessage = "that phone number doesn't look right. include the area code."
            return
        }
        Task { _ = await model.startSignIn(phone: phone) }
    }
}

// MARK: - Linking (account made; text andi now or later)

struct LinkingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            AndiGlow(anchor: 0.15)
            if model.needsMedicalAck, let screening = model.onboardResult?.screening {
                MedicalFirstView(message: screening.message) {
                    withAnimation {
                        model.needsMedicalAck = false
                        if model.me?.imessageLinked == true { model.finishLinking() }
                    }
                }
            } else {
                linking
            }
        }
    }

    private var agentHandle: String? { model.onboardResult?.agentHandle ?? model.me?.agentHandle }
    private var voiceNumber: String? { model.onboardResult?.voiceNumber ?? model.me?.voiceNumber }
    private var linkCode: String? { model.me?.linkCode ?? model.onboardResult?.linkCode }

    private var linking: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 22) {
                    GlowIcon(symbol: "message.fill")
                        .padding(.top, 60)

                    VStack(spacing: 10) {
                        Text("last step: text andi")
                            .font(Theme.screenTitle)
                        Text("send one text so andi can be in your messages. it also confirms this is your number.")
                            .font(Theme.body)
                            .foregroundStyle(Theme.muted)
                    }
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                    if let linkCode {
                        MessagePreview(to: agentHandle, text: "hi andi \(linkCode)")
                    }

                    if model.smsURL() == nil {
                        ErrorBanner(message: "andi's number isn't set up on this server yet. once it is, you'll be able to text andi from here.") {
                            Task { await model.refresh() }
                        }
                    }

                    WaitingIndicator(text: "waiting for your text…")

                    if let error = model.lastError {
                        ErrorBanner(message: error) { Task { await model.refresh() } }
                    }

                    if let voiceNumber {
                        Text("andi can also call from \(PhoneNumber.display(voiceNumber)). save andi to your contacts later so you know it's them.")
                            .font(Theme.caption)
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, Theme.gutter)
            }

            VStack(spacing: 14) {
                if let url = model.smsURL() {
                    Button {
                        openURL(url)
                    } label: {
                        Label("open messages", systemImage: "arrow.up.message.fill")
                    }
                    .buttonStyle(.andiPrimary)
                }
                Button("i'll do this later") { model.finishLinking() }
                    .font(Theme.caption.weight(.medium))
                    .foregroundStyle(Theme.text)
                    .accessibilityHint("you'll find this on your home screen and in settings until you do.")
                CrisisFooter()
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 12)
            .padding(.bottom, 8)
        }
        .task {
            // Verified on the sign-in screen: nothing to text.
            if model.me?.imessageLinked == true {
                model.finishLinking()
                return
            }
            await model.pollUntilLinked()
        }
    }
}

// MARK: - Medical-first safety screen

private struct MedicalFirstView: View {
    let message: String
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 22) {
                    GlowIcon(symbol: "heart.text.square.fill", color: Theme.riskElevated)
                        .padding(.top, 60)

                    Text("one thing first")
                        .font(Theme.screenTitle)

                    Text(message)
                        .font(.title3)
                        .fixedSize(horizontal: false, vertical: true)
                        .andiCard()

                    Text("SAMHSA is confidential and can help you find a doctor or a safe place to stop.")
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Theme.gutter)
            }

            VStack(spacing: 12) {
                if let samhsa = CrisisLine.samhsa {
                    Link(destination: samhsa) {
                        Label("call SAMHSA (free, 24/7)", systemImage: "phone.fill")
                    }
                    .buttonStyle(.andiUrgent)
                    .accessibilityHint("calls 1-800-662-4357")
                }
                Button("i understand, continue", action: onContinue)
                    .buttonStyle(.andiSecondary)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 12)
            .padding(.bottom, 8)
        }
    }
}

// MARK: - Small building blocks

private struct StepHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(Theme.screenTitle)
                .accessibilityAddTraits(.isHeader)
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
        VStack(alignment: .leading, spacing: 10) {
            Text(label).andiLabel()
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

/// One big number with minus/plus, like a dial. Drinks on a typical day.
private struct DrinkCounter: View {
    @Binding var value: Int
    private let range = 0...40

    var body: some View {
        VStack(spacing: 6) {
            Text("\(value)\(value == range.upperBound ? "+" : "")")
                .font(.system(size: 76, weight: .thin))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(value)))
            Text(value == 1 ? "drink on a typical day" : "drinks on a typical day")
                .font(Theme.caption)
                .foregroundStyle(Theme.muted)

            HStack(spacing: 14) {
                CircleIconButton(symbol: "minus", label: "fewer") { change(-1) }
                    .disabled(value <= range.lowerBound)
                Slider(
                    value: Binding(get: { Double(value) }, set: { value = Int($0.rounded()) }),
                    in: Double(range.lowerBound)...Double(range.upperBound),
                    step: 1
                )
                .tint(Theme.text)
                .accessibilityHidden(true) // the whole counter is one adjustable control below
                CircleIconButton(symbol: "plus", label: "more") { change(1) }
                    .disabled(value >= range.upperBound)
            }
            .padding(.top, 10)
        }
        .frame(maxWidth: .infinity)
        .andiCard(padding: 20)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("drinks on a typical day")
        .accessibilityValue("\(value)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: change(1)
            case .decrement: change(-1)
            @unknown default: break
            }
        }
        .andiHaptic(.light, trigger: value)
    }

    private func change(_ delta: Int) {
        withAnimation(.snappy) { value = min(max(value + delta, range.lowerBound), range.upperBound) }
    }
}

/// Icon aligned with the first line of a multi-line label.
private struct TopAlignedLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.icon.font(.caption2)
            configuration.title.fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Previews

#Preview("sign in") {
    SignInView()
        .environment(AppModel.preview(.signIn, me: nil))
        .preferredColorScheme(.dark)
}

#Preview("sign in: text andi") {
    SignInView()
        .environment(AppModel.preview(.signIn, me: nil, signIn: MockData.signInStart))
        .preferredColorScheme(.dark)
}

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
