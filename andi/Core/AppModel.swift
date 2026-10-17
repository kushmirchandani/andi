import Foundation
import Observation

// MARK: - App configuration (server URL + demo mode)

/// Where the app talks to, and whether it runs on sample data.
///
/// Server URL, highest priority first:
/// 1. `ANDI_BASE_URL` in the scheme's environment, or the launch argument `-ANDI_BASE_URL https://…`
/// 2. the URL saved from the in-app server sheet (UserDefaults "andi.baseURL")
/// 3. `defaultBaseURL`
///
/// Demo mode (sample data, no network): `ANDI_DEMO=1` in the environment, the launch argument
/// `-ANDI_DEMO YES`, Xcode previews, or "try with sample data" in the DEBUG server sheet.
enum AppConfig {
    static let defaultBaseURLString = "https://andi-backend.fly.dev"
    static let savedBaseURLKey = "andi.baseURL"

    static var defaultBaseURL: URL {
        URL(string: defaultBaseURLString) ?? URL(fileURLWithPath: "/")
    }

    /// Set from the scheme/launch arguments; when present it wins over the saved URL.
    static var overrideBaseURL: URL? {
        let env = ProcessInfo.processInfo.environment["ANDI_BASE_URL"]
        let arg = UserDefaults.standard.string(forKey: "ANDI_BASE_URL") // `-ANDI_BASE_URL <url>`
        return (env ?? arg).flatMap(parseServerURL)
    }

    static func resolvedBaseURL() -> URL {
        if let overrideBaseURL { return overrideBaseURL }
        if let saved = UserDefaults.standard.string(forKey: savedBaseURLKey), let url = parseServerURL(saved) {
            return url
        }
        return defaultBaseURL
    }

    static var isRunningForPreviews: Bool {
        ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
    }

    static var demoRequested: Bool {
        if isRunningForPreviews { return true }
        if ProcessInfo.processInfo.environment["ANDI_DEMO"] == "1" { return true }
        return UserDefaults.standard.bool(forKey: "ANDI_DEMO") // `-ANDI_DEMO YES`
    }

    /// Accepts "andi.example.com", "https://andi.example.com/", "http://192.168.1.5:8080".
    /// Returns nil unless it's an http(s) URL with a host.
    static func parseServerURL(_ text: String) -> URL? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if !value.contains("://") { value = "https://" + value }
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host(), !host.isEmpty else { return nil }
        return url
    }
}

// MARK: - AppModel

/// Single source of truth the UI observes. Main-actor isolated (project default).
@Observable
final class AppModel {
    enum Phase: Equatable { case onboarding, linking, ready } // linking = account made, waiting for first iMessage

    private static let linkedKey = "andi.linked" // last known imessageLinked, for offline launches

    var phase: Phase
    var me: Me? = nil
    var onboardResult: OnboardResponse? = nil
    var isBusy = false
    var lastError: String? = nil
    /// Crisis guidance the server returned for something the person wrote (shown with 988).
    var safetyMessage: String? = nil
    /// Change with `setBaseURL(_:)`; persisted in UserDefaults "andi.baseURL".
    private(set) var baseURL: URL
    /// True when running on sample data with no network (previews, ANDI_DEMO, or the DEBUG sheet).
    private(set) var isDemo: Bool
    let location: LocationMonitor
    let chip: ChipLink

    @ObservationIgnored private var token: String? = nil
    @ObservationIgnored private var busyCount = 0

    private var api: APIClient { APIClient(baseURL: baseURL, token: token) }

    /// Live model. Reads the Keychain token and resumes geofence monitoring.
    /// No network happens here; call `bootstrap()`.
    init(demo: Bool = false) {
        baseURL = AppConfig.resolvedBaseURL()
        location = LocationMonitor()
        chip = ChipLink()
        isDemo = demo

        if demo {
            phase = .ready
            me = MockData.me
            return
        }

        let savedToken = Keychain.load()
        token = savedToken
        if savedToken == nil {
            phase = .onboarding
        } else {
            phase = UserDefaults.standard.bool(forKey: Self.linkedKey) ? .ready : .linking
        }

        // Geofence enter/exit -> backend. Only the place id and direction are sent.
        location.onEvent = { [weak self] placeId, entered in
            Task { await self?.postLocation(placeId: placeId, entered: entered) }
        }
        // Resume the monitor at launch (also on background relaunches) so geofence events are delivered.
        if savedToken != nil { location.start() }
    }

    // MARK: Lifecycle

    func bootstrap() async {
        guard !isDemo else { return }
        token = Keychain.load()
        guard token != nil else {
            phase = .onboarding
            return
        }
        location.start()
        await refresh()
    }

    func onboard(_ req: OnboardRequest) async -> Bool {
        if isDemo {
            await demoPause()
            onboardResult = MockData.onboardResponse(for: req)
            me = onboardResult?.me
            phase = .linking
            return true
        }
        beginBusy()
        lastError = nil
        defer { endBusy() }
        do {
            let result = try await api.onboard(req)
            guard Keychain.save(result.apiToken) else {
                lastError = "couldn't save your sign-in on this phone. try again."
                return false
            }
            token = result.apiToken
            onboardResult = result
            me = result.me
            phase = .linking
            syncLocation()
            return true
        } catch is CancellationError {
            return false
        } catch {
            lastError = Self.message(for: error)
            return false
        }
    }

    func refresh() async {
        await refresh(reportErrors: true)
    }

    /// GET /api/me. Signs out on 401; moves .linking -> .ready once iMessage is linked.
    private func refresh(reportErrors: Bool) async {
        if isDemo { return }
        guard token != nil else { return }
        do {
            let fresh = try await api.me()
            if reportErrors { lastError = nil }
            apply(fresh)
        } catch APIError.signedOut {
            signOut(reason: APIError.signedOut.message)
        } catch is CancellationError {
            // View went away (pull-to-refresh released, task cancelled). Nothing to report.
        } catch {
            if reportErrors { lastError = Self.message(for: error) }
        }
    }

    private func apply(_ fresh: Me) {
        me = fresh
        UserDefaults.standard.set(fresh.imessageLinked, forKey: Self.linkedKey)
        if fresh.imessageLinked {
            if phase != .ready { phase = .ready }
        } else if phase == .onboarding {
            phase = .linking
        }
        syncLocation()
    }

    /// Refreshes every 3s until iMessage is linked or the task is cancelled.
    func pollUntilLinked() async {
        if isDemo {
            // Simulate the person texting Andi a few seconds later.
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            me?.imessageLinked = true
            me?.linkCode = nil
            if phase == .linking { phase = .ready }
            return
        }
        while !Task.isCancelled {
            await refresh(reportErrors: false)
            if me?.imessageLinked == true || phase != .linking { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return } // cancelled
        }
    }

    /// `sms:<agentHandle>&body=<firstText> <linkCode>` — the `&body=` form is what iOS Messages accepts.
    func smsURL() -> URL? {
        guard let handle = me?.agentHandle ?? onboardResult?.agentHandle else { return nil }
        let firstText = onboardResult?.firstText ?? "hi andi"
        let code = me?.linkCode ?? onboardResult?.linkCode
        let body = [firstText, code].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        return Self.smsURL(to: handle, body: body)
    }

    /// Opens Messages to the person's sponsor with an invite: their person texts "hi andi" to the
    /// number Andi assigned them, once, so Andi can reach them. Nil if there's no sponsor or number yet.
    func sponsorInviteURL() -> URL? {
        guard let sponsor = me?.sponsor, !sponsor.linked,
              let number = sponsor.andiNumber, !number.isEmpty else { return nil }
        let first = (me?.name ?? "").split(separator: " ").first.map(String.init) ?? ""
        let from = first.isEmpty ? "i" : "it's \(first). i"
        let body = "hey \(sponsor.name), \(from) picked you as my person in andi, a recovery companion that lives in my texts. could you text \"hi andi\" to \(number) once? andi will only reach out if i might need you, and you'll never see my private messages."
        return Self.smsURL(to: sponsor.phone, body: body)
    }

    /// `sms:<handle>&body=<text>`, percent-encoded the way iOS Messages expects.
    static func smsURL(to rawHandle: String, body: String) -> URL? {
        let handle = rawHandle.filter { !$0.isWhitespace }
        guard !handle.isEmpty else { return nil }
        // RFC 3986 unreserved (ASCII only); everything else, including accents and emoji, is %-encoded.
        let bodyAllowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        var handleAllowed = bodyAllowed
        handleAllowed.insert(charactersIn: "+@")
        guard let encodedBody = body.addingPercentEncoding(withAllowedCharacters: bodyAllowed),
              let encodedHandle = handle.addingPercentEncoding(withAllowedCharacters: handleAllowed) else { return nil }
        return URL(string: "sms:\(encodedHandle)&body=\(encodedBody)")
    }

    // MARK: Actions

    func checkIn(_ c: CheckIn) async {
        if isDemo {
            await demoPause()
            me?.risk = MockData.risk(after: c)
            return
        }
        if let result = await perform({ try await $0.checkIn(c) }), let safety = result.safety {
            safetyMessage = safety.message
        }
    }

    /// Returns a short status line to show under the button.
    func callPerson() async -> String? {
        let name = me?.sponsor.flatMap { $0.name.isEmpty ? nil : $0.name } ?? "your person"
        let via: String
        if isDemo {
            await demoPause()
            via = me?.sponsor == nil ? "none" : "text"
        } else {
            guard let result = await perform({ try await $0.call() }) else { return nil }
            via = result.via
        }
        switch via {
        case "voice": return "calling \(name)…"
        case "text": return "texted \(name) to call you"
        case "cooldown": return "andi already asked \(name) to call. hang tight."
        case "none": return "add your person in settings so andi can reach them."
        default: return "andi's on it."
        }
    }

    func breathe() async {
        if isDemo { return }
        await perform { try await $0.breathe() }
    }

    func reportSlip(note: String?) async -> String? {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let clean = (trimmed?.isEmpty ?? true) ? nil : trimmed.map { String($0.prefix(500)) }
        if isDemo {
            await demoPause()
            me?.risk = Risk(score: 0.7, level: .elevated, reasons: ["you told andi about a slip"], source: "local", at: nil)
            return "thank you for telling andi. one night doesn't erase your days."
        }
        let result = await perform { try await $0.slip(note: clean) }
        return result?.message
    }

    func updateConsents(_ c: Consents) async {
        if isDemo {
            me?.consents = c
            return
        }
        if let updated = await perform(refreshAfter: false, { try await $0.updateConsents(c) }) {
            apply(updated)
        }
    }

    func updateSponsor(name: String, phone: String) async {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, let cleanPhone = PhoneNumber.normalize(phone) else {
            lastError = "add their name and a phone number we can text."
            return
        }
        if isDemo {
            await demoPause()
            me?.sponsor = Sponsor(name: cleanName, phone: cleanPhone, linked: false)
            return
        }
        if let updated = await perform(refreshAfter: false, { try await $0.updateSponsor(name: cleanName, phone: cleanPhone) }) {
            apply(updated)
        }
    }

    /// DELETE /api/sponsor
    func removeSponsor() async {
        if isDemo {
            me?.sponsor = nil
            return
        }
        if let updated = await perform(refreshAfter: false, { try await $0.removeSponsor() }) {
            apply(updated)
        }
    }

    func saveWhy(_ text: String) async {
        let trimmed = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))
        guard !trimmed.isEmpty else { return }
        if isDemo {
            await demoPause()
            me?.why = trimmed
            return
        }
        await perform { try await $0.saveWhy(trimmed) }
    }

    /// Returns true when the place was saved (the server caps it at 20 places).
    @discardableResult
    func addPlace(name: String, lat: Double, lng: Double, radiusM: Double, kind: PlaceKind, alternative: String?) async -> Bool {
        let alt = alternative?.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = PlaceInput(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                               lat: lat, lng: lng, radiusM: min(max(radiusM, 50), 2000), kind: kind,
                               alternative: (alt?.isEmpty ?? true) ? nil : alt)
        if isDemo {
            await demoPause()
            guard (me?.places.count ?? 0) < LocationMonitor.maxPlaces else {
                lastError = "you can keep up to \(LocationMonitor.maxPlaces) places. remove one to add another."
                return false
            }
            me?.places.append(Place(id: "demo-\(UUID().uuidString)", name: input.name, lat: lat, lng: lng,
                                    radiusM: input.radiusM, kind: kind, alternative: input.alternative))
            return true
        }
        let saved: Place? = await perform { try await $0.addPlace(input) }
        return saved != nil
    }

    func deletePlace(_ place: Place) async {
        if isDemo {
            me?.places.removeAll { $0.id == place.id }
            return
        }
        await perform { try await $0.deletePlace(id: place.id) }
    }

    /// POST /api/chip/pair, then hand the websocket URL to the chip over Bluetooth.
    func pairChip(ssid: String, password: String) async {
        if isDemo {
            await chip.simulatePairing()
            if chip.state == .paired { me?.chipPaired = true; me?.chipOnline = true }
            return
        }
        if let pairing = await perform(refreshAfter: false, { try await $0.pairChip() }) {
            chip.pair(ssid: ssid, password: password, wsUrl: pairing.wsUrl)
        }
    }

    /// DELETE /api/me, then sign out. Returns false (with `lastError`) if it didn't go through.
    func deleteAccount() async -> Bool {
        if isDemo {
            signOut()
            return true
        }
        beginBusy()
        lastError = nil
        defer { endBusy() }
        do {
            try await api.deleteAccount()
            signOut()
            return true
        } catch APIError.signedOut {
            signOut() // already gone on the server
            return true
        } catch is CancellationError {
            return false
        } catch {
            lastError = Self.message(for: error)
            return false
        }
    }

    func signOut() {
        signOut(reason: nil)
    }

    /// Clears Keychain + state and returns to onboarding. `reason` is shown on the welcome step.
    func signOut(reason: String?) {
        let wasDemo = isDemo
        isDemo = false
        if !wasDemo {
            Keychain.delete()
            location.sync(places: [])
        }
        UserDefaults.standard.removeObject(forKey: Self.linkedKey)
        token = nil
        me = nil
        onboardResult = nil
        chip.cancel()
        lastError = reason
        phase = .onboarding
    }

    // MARK: Developer

    /// Points the app at another backend and remembers it. An env/launch-argument override still wins.
    func setBaseURL(_ url: URL) {
        UserDefaults.standard.set(url.absoluteString, forKey: AppConfig.savedBaseURLKey)
        baseURL = AppConfig.overrideBaseURL ?? url
    }

    /// Forgets the saved server and goes back to the default (or the env override).
    func resetBaseURL() {
        UserDefaults.standard.removeObject(forKey: AppConfig.savedBaseURLKey)
        baseURL = AppConfig.resolvedBaseURL()
    }

    /// Switches to sample data with no network (for design reviews). Sign out to leave.
    func startDemo() {
        isDemo = true
        lastError = nil
        onboardResult = nil
        me = MockData.me
        phase = .ready
    }

    // MARK: Helpers

    private func postLocation(placeId: String, entered: Bool) async {
        guard !isDemo, token != nil else { return }
        do {
            _ = try await api.location(placeId: placeId, entered: entered)
            await refresh(reportErrors: false)
        } catch APIError.signedOut {
            signOut(reason: APIError.signedOut.message)
        } catch {
            // Background event; nothing useful to show.
        }
    }

    /// Monitor geofences only while the person has location consent on.
    private func syncLocation() {
        guard !isDemo, let me else { return }
        location.sync(places: me.consents.location ? me.places : [])
    }

    private func beginBusy() {
        busyCount += 1
        isBusy = true
    }

    private func endBusy() {
        busyCount = max(0, busyCount - 1)
        isBusy = busyCount > 0
    }

    private func demoPause() async {
        try? await Task.sleep(for: .milliseconds(400))
    }

    /// Runs one API call with isBusy/lastError handling, then (optionally) refreshes `me`.
    @discardableResult
    private func perform<T>(refreshAfter: Bool = true, _ work: (APIClient) async throws -> T) async -> T? {
        beginBusy()
        lastError = nil
        defer { endBusy() }
        do {
            let value = try await work(api)
            if refreshAfter { await refresh(reportErrors: false) }
            return value
        } catch APIError.signedOut {
            signOut(reason: APIError.signedOut.message)
            return nil
        } catch is CancellationError {
            return nil
        } catch {
            lastError = Self.message(for: error)
            return nil
        }
    }

    private static func message(for error: any Error) -> String {
        if let apiError = error as? APIError { return apiError.message }
        return APIError.unreachable.message
    }
}
