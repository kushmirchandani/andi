import Foundation

/// Sample data for SwiftUI previews and demo mode. Never touches the network.
enum MockData {
    static let places: [Place] = [
        Place(id: "demo-1", name: "The Anchor", lat: 42.3736, lng: -71.1190, radiusM: 150, kind: .bar,
              alternative: "Tatte Bakery across the street"),
        Place(id: "demo-2", name: "Harvard Square Liquors", lat: 42.3730, lng: -71.1201, radiusM: 200,
              kind: .liquor_store, alternative: nil),
    ]

    static let sponsor = Sponsor(name: "Sam", phone: "+15555550123", linked: true, andiNumber: "+15555550102")

    static let me = Me(
        id: "per_demo",
        name: "Alex",
        day: 42,
        soberSince: "2026-09-05",
        moneySaved: 360,
        risk: Risk(score: 0.18, level: .low, reasons: ["checked in today"], source: "local", at: nil),
        consents: .defaults,
        places: MockData.places,
        sponsor: MockData.sponsor,
        imessageLinked: true,
        agentHandle: "+15555550100",
        voiceNumber: "+15555550101",
        chipPaired: false,
        chipOnline: false,
        medicalFirst: false,
        portalUrl: nil,
        linkCode: nil
    )

    /// `me` with a different risk level, for previewing the glow colors.
    static func sample(risk level: RiskLevel) -> Me {
        var copy = MockData.me
        copy.risk = Risk(score: level == .high ? 0.85 : (level == .elevated ? 0.55 : 0.15),
                         level: level, reasons: [], source: "local", at: nil)
        return copy
    }

    /// A freshly onboarded, not-yet-linked person.
    static let newcomer: Me = {
        var copy = MockData.me
        copy.day = 0
        copy.moneySaved = 0
        copy.places = []
        copy.sponsor = nil
        copy.imessageLinked = false
        copy.linkCode = "482913"
        return copy
    }()

    static let medicalFirstMessage = "Before you stop, please talk to a doctor. For some people, stopping alcohol suddenly can cause dangerous withdrawal, and a doctor can help you do it safely. SAMHSA's free, confidential helpline is 1-800-662-4357, 24/7. Andi will be with you the whole way."

    static func onboardResponse(medicalFirst: Bool = false) -> OnboardResponse {
        OnboardResponse(
            apiToken: "demo",
            screening: ScreeningResult(
                medicalFirst: medicalFirst,
                message: medicalFirst ? medicalFirstMessage : "You're all set. Andi will check in with you and be there on the hard nights."
            ),
            agentHandle: MockData.newcomer.agentHandle,
            voiceNumber: MockData.newcomer.voiceNumber,
            firstText: "hi andi",
            linkCode: MockData.newcomer.linkCode,
            me: MockData.newcomer
        )
    }

    /// Mirrors the backend's screening rule so demo onboarding shows the right safety screen.
    static func onboardResponse(for req: OnboardRequest) -> OnboardResponse {
        let s = req.screening
        let medicalFirst = s.pastWithdrawal || s.drinksPerDay >= 8 || (s.drinksDaily && s.morningDrinking)
        var person = MockData.newcomer
        person.name = req.name
        person.soberSince = req.soberSince
        person.consents = req.consents ?? .defaults
        person.medicalFirst = medicalFirst
        if let sponsor = req.sponsor { person.sponsor = Sponsor(name: sponsor.name, phone: sponsor.phone, linked: false) }
        let base = onboardResponse(medicalFirst: medicalFirst)
        return OnboardResponse(apiToken: base.apiToken, screening: base.screening, agentHandle: base.agentHandle,
                               voiceNumber: base.voiceNumber, firstText: base.firstText, linkCode: base.linkCode, me: person)
    }

    static func risk(after checkIn: CheckIn) -> Risk {
        let flags = [checkIn.hungry, checkIn.angry, checkIn.lonely, checkIn.tired].filter { $0 }.count
        let lowMood = (checkIn.mood ?? 3) <= 2
        let level: RiskLevel = flags >= 3 || (flags >= 2 && lowMood) ? .high : (flags >= 1 || lowMood ? .elevated : .low)
        return Risk(score: Double(flags) / 4, level: level, reasons: ["you checked in"], source: "local", at: nil)
    }
}

extension AppModel {
    /// A model on sample data for `#Preview` blocks. No Keychain, no network, no location.
    static func preview(_ phase: Phase = .ready, me: Me? = MockData.me, onboard: OnboardResponse? = nil) -> AppModel {
        let model = AppModel(demo: true)
        model.phase = phase
        model.me = me
        model.onboardResult = onboard
        return model
    }
}
