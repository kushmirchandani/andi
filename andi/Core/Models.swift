import Foundation

// Wire types for the Andi backend. All are `nonisolated` so they can be
// encoded/decoded off the main actor (the target defaults to MainActor isolation).
// Decoding is tolerant: unknown enum values and missing optional fields never fail
// a whole response (RiskLevel stays strict on purpose: a risk we can't read is dropped).

nonisolated enum RiskLevel: String, Codable, Sendable { case low, elevated, high }

nonisolated enum ShareLevel: String, Codable, Sendable, CaseIterable {
    case none, status, status_and_reason

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ShareLevel(rawValue: raw) ?? .status
    }
}

nonisolated enum PlaceKind: String, Codable, Sendable, CaseIterable {
    case bar, liquor_store, other

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlaceKind(rawValue: raw) ?? .other
    }
}

nonisolated struct Consents: Codable, Sendable, Equatable {
    var location: Bool
    var purchases: Bool
    var shareWithSponsor: ShareLevel
    var sponsorAlerts: Bool

    static let defaults = Consents(location: true, purchases: true, shareWithSponsor: .status, sponsorAlerts: true)
}

nonisolated struct Risk: Codable, Sendable, Equatable {
    let score: Double
    let level: RiskLevel
    let reasons: [String]
    let source: String
    /// ISO-8601 timestamp string (absent on GET /api/risk).
    let at: String?

    init(score: Double, level: RiskLevel, reasons: [String], source: String, at: String?) {
        self.score = score
        self.level = level
        self.reasons = reasons
        self.source = source
        self.at = at
    }

    nonisolated enum CodingKeys: String, CodingKey { case score, level, reasons, source, at }

    // Tolerant: only `level` is required.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = try c.decode(RiskLevel.self, forKey: .level)
        score = (try? c.decodeIfPresent(Double.self, forKey: .score)) ?? 0
        reasons = (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
        at = try? c.decodeIfPresent(String.self, forKey: .at)
    }
}

nonisolated struct Place: Codable, Sendable, Identifiable, Equatable {
    let id: String
    var name: String
    var lat: Double
    var lng: Double
    var radiusM: Double
    var kind: PlaceKind
    var alternative: String?
}

nonisolated struct Sponsor: Codable, Sendable, Equatable {
    let name: String
    let phone: String
    let linked: Bool
    /// The number their person texts to connect with Andi (each handle gets its own Photon line).
    let andiNumber: String?

    init(name: String, phone: String, linked: Bool, andiNumber: String? = nil) {
        self.name = name
        self.phone = phone
        self.linked = linked
        self.andiNumber = andiNumber
    }

    nonisolated enum CodingKeys: String, CodingKey { case name, phone, linked, andiNumber }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        phone = (try? c.decodeIfPresent(String.self, forKey: .phone)) ?? ""
        linked = (try? c.decodeIfPresent(Bool.self, forKey: .linked)) ?? false
        andiNumber = (try? c.decodeIfPresent(String.self, forKey: .andiNumber)) ?? nil
    }
}

/// GET /api/me. Fields are `var` so demo mode can update a local copy.
nonisolated struct Me: Codable, Sendable, Equatable {
    var id: String
    var name: String
    var day: Int
    var soberSince: String
    var moneySaved: Double
    var risk: Risk?
    var consents: Consents
    var places: [Place]
    var sponsor: Sponsor?
    var imessageLinked: Bool
    var agentHandle: String?
    var voiceNumber: String?
    var chipPaired: Bool
    var chipOnline: Bool
    var medicalFirst: Bool
    var portalUrl: String?
    var linkCode: String?
    /// The person's saved "why" (for prefilling Settings).
    var why: String?

    init(id: String, name: String, day: Int, soberSince: String, moneySaved: Double, risk: Risk?,
         consents: Consents, places: [Place], sponsor: Sponsor?, imessageLinked: Bool,
         agentHandle: String?, voiceNumber: String?, chipPaired: Bool, chipOnline: Bool,
         medicalFirst: Bool, portalUrl: String?, linkCode: String?, why: String? = nil) {
        self.id = id
        self.name = name
        self.day = day
        self.soberSince = soberSince
        self.moneySaved = moneySaved
        self.risk = risk
        self.consents = consents
        self.places = places
        self.sponsor = sponsor
        self.imessageLinked = imessageLinked
        self.agentHandle = agentHandle
        self.voiceNumber = voiceNumber
        self.chipPaired = chipPaired
        self.chipOnline = chipOnline
        self.medicalFirst = medicalFirst
        self.portalUrl = portalUrl
        self.linkCode = linkCode
        self.why = why
    }

    nonisolated enum CodingKeys: String, CodingKey {
        case id, name, day, soberSince, moneySaved, risk, consents, places, sponsor, imessageLinked
        case agentHandle, voiceNumber, chipPaired, chipOnline, medicalFirst, portalUrl, linkCode, why
    }

    // Tolerant: `id` is the only hard requirement; everything else falls back to a sensible default.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        day = (try? c.decodeIfPresent(Int.self, forKey: .day)) ?? 0
        soberSince = (try? c.decodeIfPresent(String.self, forKey: .soberSince)) ?? ""
        moneySaved = (try? c.decodeIfPresent(Double.self, forKey: .moneySaved)) ?? 0
        risk = (try? c.decodeIfPresent(Risk.self, forKey: .risk)) ?? nil
        consents = (try? c.decodeIfPresent(Consents.self, forKey: .consents)) ?? .defaults
        places = (try? c.decodeIfPresent([Place].self, forKey: .places)) ?? []
        sponsor = (try? c.decodeIfPresent(Sponsor.self, forKey: .sponsor)) ?? nil
        imessageLinked = (try? c.decodeIfPresent(Bool.self, forKey: .imessageLinked)) ?? false
        agentHandle = (try? c.decodeIfPresent(String.self, forKey: .agentHandle)) ?? nil
        voiceNumber = (try? c.decodeIfPresent(String.self, forKey: .voiceNumber)) ?? nil
        chipPaired = (try? c.decodeIfPresent(Bool.self, forKey: .chipPaired)) ?? false
        chipOnline = (try? c.decodeIfPresent(Bool.self, forKey: .chipOnline)) ?? false
        medicalFirst = (try? c.decodeIfPresent(Bool.self, forKey: .medicalFirst)) ?? false
        portalUrl = (try? c.decodeIfPresent(String.self, forKey: .portalUrl)) ?? nil
        linkCode = (try? c.decodeIfPresent(String.self, forKey: .linkCode)) ?? nil
        why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? nil
    }
}

nonisolated struct Screening: Codable, Sendable {
    var drinksPerDay: Double
    var drinksDaily: Bool
    var morningDrinking: Bool
    var pastWithdrawal: Bool
}

nonisolated struct SponsorInput: Codable, Sendable {
    var name: String
    var phone: String
}

nonisolated struct OnboardRequest: Codable, Sendable {
    var name: String
    var phone: String
    /// "YYYY-MM-DD"
    var soberSince: String
    var weeklyDrinkSpend: Double
    var screening: Screening
    var sponsor: SponsorInput?
    var consents: Consents?
    var why: String?
    /// IANA time zone ("America/New_York"), so day counts flip at the person's midnight.
    var timezone: String? = TimeZone.current.identifier
}

nonisolated struct ScreeningResult: Codable, Sendable, Equatable {
    let medicalFirst: Bool
    let message: String

    init(medicalFirst: Bool, message: String) {
        self.medicalFirst = medicalFirst
        self.message = message
    }

    nonisolated enum CodingKeys: String, CodingKey { case medicalFirst, message }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        medicalFirst = (try? c.decodeIfPresent(Bool.self, forKey: .medicalFirst)) ?? false
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
    }
}

nonisolated struct OnboardResponse: Codable, Sendable, Equatable {
    let apiToken: String
    let screening: ScreeningResult
    let agentHandle: String?
    let voiceNumber: String?
    let firstText: String
    /// Digits as a string (currently 6). Never assume a length.
    let linkCode: String?
    let me: Me

    init(apiToken: String, screening: ScreeningResult, agentHandle: String?, voiceNumber: String?,
         firstText: String, linkCode: String?, me: Me) {
        self.apiToken = apiToken
        self.screening = screening
        self.agentHandle = agentHandle
        self.voiceNumber = voiceNumber
        self.firstText = firstText
        self.linkCode = linkCode
        self.me = me
    }

    nonisolated enum CodingKeys: String, CodingKey { case apiToken, screening, agentHandle, voiceNumber, firstText, linkCode, me }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        apiToken = try c.decode(String.self, forKey: .apiToken)
        me = try c.decode(Me.self, forKey: .me)
        screening = (try? c.decodeIfPresent(ScreeningResult.self, forKey: .screening))
            ?? ScreeningResult(medicalFirst: me.medicalFirst, message: "")
        agentHandle = (try? c.decodeIfPresent(String.self, forKey: .agentHandle)) ?? nil
        voiceNumber = (try? c.decodeIfPresent(String.self, forKey: .voiceNumber)) ?? nil
        firstText = (try? c.decodeIfPresent(String.self, forKey: .firstText)) ?? "hi andi"
        linkCode = (try? c.decodeIfPresent(String.self, forKey: .linkCode)) ?? nil
    }
}

nonisolated struct CheckIn: Codable, Sendable, Equatable {
    var hungry = false
    var angry = false
    var lonely = false
    var tired = false
    /// 1-5, omitted from the JSON when nil.
    var mood: Int? = nil
    /// Max 500 characters on the server; omitted when nil.
    var note: String? = nil
}

// MARK: - Extra request/response bodies (not in the shared interface, used by APIClient)

nonisolated struct PlaceInput: Codable, Sendable {
    var name: String
    var lat: Double
    var lng: Double
    var radiusM: Double
    var kind: PlaceKind
    var alternative: String?
}

nonisolated struct LocationEventRequest: Codable, Sendable {
    var placeId: String
    var event: String // "enter" | "exit"
}

nonisolated struct LocationEventResponse: Codable, Sendable {
    let risk: Risk?

    nonisolated enum CodingKeys: String, CodingKey { case risk }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        risk = (try? c.decodeIfPresent(Risk.self, forKey: .risk)) ?? nil
    }
}

/// Present when something the person wrote (a check-in or slip note) needs crisis guidance.
nonisolated struct SafetyNotice: Codable, Sendable, Equatable {
    let kind: String
    let message: String
}

nonisolated struct RiskResponse: Codable, Sendable {
    let risk: Risk?
    let safety: SafetyNotice?

    nonisolated enum CodingKeys: String, CodingKey { case risk, safety }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        risk = (try? c.decodeIfPresent(Risk.self, forKey: .risk)) ?? nil
        safety = (try? c.decodeIfPresent(SafetyNotice.self, forKey: .safety)) ?? nil
    }
}

nonisolated struct WhyRequest: Codable, Sendable { var text: String }

nonisolated struct SlipRequest: Codable, Sendable { var note: String? }

nonisolated struct SlipResponse: Codable, Sendable {
    let risk: Risk?
    let message: String

    nonisolated enum CodingKeys: String, CodingKey { case risk, message }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        risk = (try? c.decodeIfPresent(Risk.self, forKey: .risk)) ?? nil
        message = (try? c.decodeIfPresent(String.self, forKey: .message))
            ?? "thank you for telling andi. one night doesn't erase your days."
    }
}

/// `{ ok }` bodies. Any 2xx counts as success, so every field is optional.
nonisolated struct OKResponse: Codable, Sendable { let ok: Bool? }

nonisolated struct CallResponse: Codable, Sendable {
    let ok: Bool
    /// "voice" | "text" | "none" | "cooldown" — kept as a String so new values never fail decoding.
    let via: String

    nonisolated enum CodingKeys: String, CodingKey { case ok, via }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        via = (try? c.decodeIfPresent(String.self, forKey: .via)) ?? "none"
    }
}

nonisolated struct ChipPairResponse: Codable, Sendable {
    let chipToken: String
    let wsUrl: String
}

/// Used as the body type for requests that send nothing.
nonisolated struct EmptyBody: Codable, Sendable {}

// MARK: - Phone numbers

nonisolated enum PhoneNumber {
    /// Normalizes user input to an E.164-style string ("+15551234567").
    /// 10 digits are treated as US/Canada. Returns nil if it can't be a phone number.
    static func normalize(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // "ext 2", "x12", "#" or "," mean an extension; dialing those digits would reach someone else.
        if trimmed.contains(where: { $0.isLetter || $0 == "#" || $0 == "," || $0 == ";" }) { return nil }
        let hasPlus = trimmed.hasPrefix("+") || trimmed.hasPrefix("00")
        var digits = trimmed.filter(\.isASCII).filter(\.isNumber)
        if trimmed.hasPrefix("00") { digits = String(digits.dropFirst(2)) }
        if !hasPlus {
            if digits.count == 10 { return "+1" + digits }
            if digits.count == 11, digits.hasPrefix("1") { return "+" + digits }
        }
        guard (8...15).contains(digits.count), !digits.hasPrefix("0") else { return nil }
        return "+" + digits
    }
}
