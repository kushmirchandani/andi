import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    // consents (local draft, saved on change)
    @State private var consents = Consents.defaults
    @State private var loaded = false
    // your person
    @State private var personName = ""
    @State private var personPhone = ""
    @State private var personSaved = false
    @State private var confirmRemovePerson = false
    // your why
    @State private var why = ""
    @State private var whySaved = false
    // chip
    @State private var ssid = ""
    @State private var wifiPassword = ""
    // account
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var isDeleting = false
    @State private var showServer = false

    private enum Field: Hashable { case personName, personPhone, why, ssid, password }
    @FocusState private var focus: Field?

    var body: some View {
        Form {
            crisisSection
            if let error = model.lastError {
                Section {
                    ErrorBanner(message: error) {
                        model.lastError = nil
                        Task { await model.refresh() }
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            consentsSection
            personSection
            whySection
            chipSection
            developerSection
            accountSection
        }
        .formStyle(.grouped)
        .andiScreenBackground()
        .scrollDismissesKeyboard(.interactively)
        .keyboardDoneButton { focus = nil }
        .navigationTitle("settings")
        .onAppear(perform: load)
        .onChange(of: model.me) { _, newValue in
            // Keep the draft in step with the server (e.g. after a refresh or a failed save).
            guard let newValue else { return }
            if newValue.consents != consents { consents = newValue.consents }
            if !loaded { load() }
        }
        .onChange(of: consents) { _, newValue in
            guard loaded, let current = model.me?.consents, newValue != current else { return }
            Task {
                await model.updateConsents(newValue)
                // If the save failed, snap the toggles back to what the server has.
                if model.lastError != nil, let saved = model.me?.consents { consents = saved }
            }
        }
        .onChange(of: model.chip.state) { _, newState in
            if newState == .paired { Task { await model.refresh() } }
        }
        .confirmationDialog("sign out of andi?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("sign out", role: .destructive) { model.signOut() }
            Button("stay", role: .cancel) {}
        } message: {
            Text("andi will stop texting this phone until you set it up again.")
        }
        .confirmationDialog("delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("delete my account", role: .destructive) { deleteAccount() }
            Button("keep my account", role: .cancel) {}
        } message: {
            Text("this permanently deletes your days, check-ins, places and your person from andi. it can't be undone.")
        }
        .confirmationDialog("remove your person?", isPresented: $confirmRemovePerson, titleVisibility: .visible) {
            Button("remove", role: .destructive) { removePerson() }
            Button("keep", role: .cancel) {}
        } message: {
            Text("andi won't reach out to them anymore. you can add someone again any time.")
        }
        .sheet(isPresented: $showServer) {
            ServerSheet().environment(model)
        }
    }

    // MARK: Sections

    private var crisisSection: some View {
        Section {
            Text("In crisis? Call or text 988.")
                .font(Theme.headline)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 12) {
                if let call = CrisisLine.call988 {
                    Link(destination: call) {
                        Label("call 988", systemImage: "phone.fill")
                    }
                    .buttonStyle(.andiPrimary)
                }
                if let text = CrisisLine.text988 {
                    Link(destination: text) {
                        Label("text 988", systemImage: "message.fill")
                    }
                    .buttonStyle(.andiSecondary)
                }
            }
            if let samhsa = CrisisLine.samhsa {
                Link("SAMHSA helpline: 1-800-662-4357", destination: samhsa)
                    .font(Theme.caption)
            }
        } footer: {
            Text("free, confidential, any time. andi is a companion, not a replacement for medical care.")
        }
        .listRowBackground(Theme.card)
    }

    private var consentsSection: some View {
        Section {
            Toggle("notice when i'm near places i mark as risky", isOn: $consents.location)
            Toggle("notice drink purchases", isOn: $consents.purchases)
        } header: {
            Text("what andi can use")
        } footer: {
            Text("changes save right away.")
        }
        .listRowBackground(Theme.card)
        .disabled(model.me == nil)
    }

    private var personSection: some View {
        Section {
            if let sponsor = model.me?.sponsor {
                LabeledContent("status", value: sponsor.linked ? "connected" : "not connected yet")
                if !sponsor.linked, let invite = model.sponsorInviteURL() {
                    Button("invite \(sponsor.name) to connect") { openURL(invite) }
                }
            }
            TextField("their name", text: $personName)
                .nameInput()
                .focused($focus, equals: .personName)
                .submitLabel(.next)
                .onSubmit { focus = .personPhone }
            TextField("their phone", text: $personPhone)
                .phoneInput()
                .focused($focus, equals: .personPhone)
            Button(personSaved ? "saved" : "save my person") {
                focus = nil
                Task {
                    await model.updateSponsor(name: personName.andiTrimmed, phone: personPhone)
                    personSaved = model.lastError == nil
                    if personSaved, let saved = model.me?.sponsor { personPhone = saved.phone }
                }
            }
            .disabled(!canSavePerson || model.isBusy)

            if model.me?.sponsor != nil {
                Button("remove my person", role: .destructive) { confirmRemovePerson = true }
                    .disabled(model.isBusy)
            }

            Picker("what they can see", selection: $consents.shareWithSponsor) {
                ForEach(ShareLevel.allCases, id: \.self) { level in
                    Text(level.uiLabel).tag(level)
                }
            }
            Toggle("let them know when things look hard", isOn: $consents.sponsorAlerts)
        } header: {
            Text("your person")
        } footer: {
            if !personPhone.andiTrimmed.isEmpty, PhoneNumber.normalize(personPhone) == nil {
                Text("that phone number doesn't look right. include the area code.")
            } else {
                Text("your person texts \"hi andi\" once so andi can reach them. andi never shares your messages or where you are.")
            }
        }
        .listRowBackground(Theme.card)
        .onChange(of: personName) { personSaved = false }
        .onChange(of: personPhone) { personSaved = false }
    }

    private var whySection: some View {
        Section {
            TextField("what are you doing this for?", text: $why, axis: .vertical)
                .lineLimit(2...6)
                .focused($focus, equals: .why)
            Button(whySaved ? "saved" : "save my why") {
                focus = nil
                Task {
                    await model.saveWhy(why.andiTrimmed)
                    whySaved = model.lastError == nil
                }
            }
            .disabled(why.andiTrimmed.isEmpty || why.count > 1000 || model.isBusy)
        } header: {
            Text("your why")
        } footer: {
            Text(why.count > 1000 ? "keep it under 1000 characters." : "andi brings this up on the hard days.")
        }
        .listRowBackground(Theme.card)
        .onChange(of: why) { whySaved = false }
    }

    private var chipSection: some View {
        Section {
            LabeledContent("status", value: chipStatus)
                .accessibilityElement(children: .combine)
            TextField("wi-fi name", text: $ssid)
                .plainInput()
                .focused($focus, equals: .ssid)
                .submitLabel(.next)
                .onSubmit { focus = .password }
            SecureField("wi-fi password", text: $wifiPassword)
                .focused($focus, equals: .password)
            if chipIsWorking {
                Button("cancel pairing", role: .cancel) { model.chip.cancel() }
            } else {
                Button(model.me?.chipPaired == true ? "pair again" : "pair chip") {
                    focus = nil
                    Task { await model.pairChip(ssid: ssid.andiTrimmed, password: wifiPassword) }
                }
                .disabled(ssid.andiTrimmed.isEmpty || model.isBusy)
            }
        } header: {
            Text("andi chip")
        } footer: {
            Text("hold your chip close to your phone. it glows with how you're doing. use a 2.4 GHz wi-fi network.")
        }
        .listRowBackground(Theme.card)
    }

    private var developerSection: some View {
        Section {
            Button {
                showServer = true
            } label: {
                LabeledContent("server", value: model.baseURL.host() ?? model.baseURL.absoluteString)
            }
            .foregroundStyle(Theme.text)
            if model.isDemo {
                LabeledContent("mode", value: "sample data")
            }
        } header: {
            Text("developer")
        } footer: {
            if model.isDemo {
                Text("you're looking at sample data. sign out to leave demo mode.")
            }
        }
        .listRowBackground(Theme.card)
    }

    private var accountSection: some View {
        Section {
            Button("sign out", role: .destructive) { confirmSignOut = true }
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                HStack {
                    Text("delete my account")
                    if isDeleting {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isDeleting)
        } footer: {
            Text("deleting removes everything andi knows about you from the server.")
        }
        .listRowBackground(Theme.card)
    }

    // MARK: Helpers

    private var canSavePerson: Bool {
        guard !personName.andiTrimmed.isEmpty, let phone = PhoneNumber.normalize(personPhone) else { return false }
        if let sponsor = model.me?.sponsor {
            return sponsor.name != personName.andiTrimmed || PhoneNumber.normalize(sponsor.phone) != phone
        }
        return true
    }

    private var chipIsWorking: Bool {
        switch model.chip.state {
        case .scanning, .connecting, .sending, .waitingForWifi: true
        case .idle, .paired, .failed: false
        }
    }

    private var chipStatus: String {
        switch model.chip.state {
        case .idle:
            if model.me?.chipPaired == true {
                return model.me?.chipOnline == true ? "paired and online" : "paired, offline"
            }
            return "not paired"
        case .scanning: return "looking for your chip…"
        case .connecting: return "connecting…"
        case .sending: return "sending wi-fi details…"
        case .waitingForWifi: return "waiting for your chip to join wi-fi…"
        case .paired: return "paired"
        case .failed(let reason): return "couldn't pair: \(reason)"
        }
    }

    private func load() {
        guard !loaded, let me = model.me else { return }
        consents = me.consents
        personName = me.sponsor?.name ?? ""
        personPhone = me.sponsor?.phone ?? ""
        why = me.why ?? ""
        loaded = true
    }

    private func removePerson() {
        Task {
            await model.removeSponsor()
            if model.lastError == nil {
                personName = ""
                personPhone = ""
                personSaved = false
            }
        }
    }

    private func deleteAccount() {
        isDeleting = true
        Task {
            _ = await model.deleteAccount() // on success the app returns to onboarding
            isDeleting = false
        }
    }
}

#Preview {
    NavigationStack { SettingsView() }
        .environment(AppModel.preview())
        .preferredColorScheme(.dark)
}
