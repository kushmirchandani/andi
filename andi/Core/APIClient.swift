import Foundation

/// Errors surfaced to the UI. `message` is safe to show as-is.
nonisolated enum APIError: Error, LocalizedError, Equatable {
    case signedOut
    case offline
    case timedOut
    case unreachable
    case insecureServer
    /// `code` / `message` come from the backend's `{ "error": "<code>", "message": "<text>" }`.
    case server(status: Int, code: String?, message: String?)
    case decoding

    var message: String {
        switch self {
        case .signedOut: return "you've been signed out. set andi up again to keep going."
        case .offline: return "you're offline. check your connection and try again."
        case .timedOut: return "andi took too long to answer. try again in a moment."
        case .unreachable: return "can't reach andi's server right now. try again in a bit."
        case .insecureServer: return "that server isn't using https, so iOS blocked it."
        case .server(let status, _, let message):
            if let message, !message.isEmpty { return message }
            switch status {
            case 400: return "andi couldn't use that. check the details and try again."
            case 404: return "andi couldn't find that. pull to refresh and try again."
            case 409: return "that didn't go through. pull to refresh and try again."
            case 429: return "that's a lot at once. give it a minute and try again."
            default: return "andi's having a moment on our side. try again in a bit."
            }
        case .decoding: return "andi sent something unexpected. try again in a bit."
        }
    }

    /// Worth retrying automatically (idempotent requests only).
    var isTransient: Bool {
        switch self {
        case .timedOut, .unreachable: return true
        case .server(let status, _, _): return status >= 500
        default: return false
        }
    }

    var errorDescription: String? { message }
}

/// Small JSON client for the Andi backend. Value type, safe to create per call.
nonisolated struct APIClient: Sendable {
    var baseURL: URL
    var token: String?
    var session: URLSession

    init(baseURL: URL, token: String?, session: URLSession = APIClient.defaultSession) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    static let defaultSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 45
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    // MARK: Endpoints

    func onboard(_ req: OnboardRequest) async throws -> OnboardResponse {
        try await send("POST", "api/onboard", body: req, auth: false)
    }

    func me() async throws -> Me { try await send("GET", "api/me") }

    /// DELETE /api/me -> 204. Permanently deletes the account.
    func deleteAccount() async throws {
        _ = try await raw("DELETE", "api/me", body: nil, auth: true)
    }

    func updateConsents(_ c: Consents) async throws -> Me { try await send("PUT", "api/consents", body: c) }

    func updateSponsor(name: String, phone: String) async throws -> Me {
        try await send("PUT", "api/sponsor", body: SponsorInput(name: name, phone: phone))
    }

    /// DELETE /api/sponsor -> Me
    func removeSponsor() async throws -> Me { try await send("DELETE", "api/sponsor") }

    func places() async throws -> [Place] { try await send("GET", "api/places") }

    func addPlace(_ p: PlaceInput) async throws -> Place { try await send("POST", "api/places", body: p) }

    func deletePlace(id: String) async throws {
        _ = try await raw("DELETE", "api/places/\(id)", body: nil, auth: true)
    }

    func location(placeId: String, entered: Bool) async throws -> LocationEventResponse {
        try await send("POST", "api/location", body: LocationEventRequest(placeId: placeId, event: entered ? "enter" : "exit"))
    }

    func checkIn(_ c: CheckIn) async throws -> RiskResponse { try await send("POST", "api/checkin", body: c) }

    func saveWhy(_ text: String) async throws -> OKResponse { try await send("POST", "api/why", body: WhyRequest(text: text)) }

    func call() async throws -> CallResponse { try await send("POST", "api/call", body: EmptyBody()) }

    func breathe() async throws -> OKResponse { try await send("POST", "api/breathe", body: EmptyBody()) }

    func slip(note: String?) async throws -> SlipResponse { try await send("POST", "api/slip", body: SlipRequest(note: note)) }

    func risk() async throws -> Risk { try await send("GET", "api/risk") }

    func pairChip() async throws -> ChipPairResponse { try await send("POST", "api/chip/pair", body: EmptyBody()) }

    // MARK: Generic helpers

    private static let decoder = JSONDecoder() // dates are plain strings in the wire types
    private static let encoder = JSONEncoder()

    /// Request with a JSON body, decoding a JSON response.
    func send<Body: Encodable, Response: Decodable>(_ method: String, _ path: String, body: Body, auth: Bool = true) async throws -> Response {
        let data: Data
        do { data = try Self.encoder.encode(body) } catch { throw APIError.decoding }
        return try decode(try await raw(method, path, body: data, auth: auth))
    }

    /// Request without a body, decoding a JSON response.
    func send<Response: Decodable>(_ method: String, _ path: String, auth: Bool = true) async throws -> Response {
        try decode(try await raw(method, path, body: nil, auth: auth))
    }

    private func decode<Response: Decodable>(_ data: Data) throws -> Response {
        do { return try Self.decoder.decode(Response.self, from: data) } catch { throw APIError.decoding }
    }

    /// Performs the request (GETs retry once on transient failures) and returns the body on 2xx.
    /// Throws `APIError`, or `CancellationError` if the calling task was cancelled.
    func raw(_ method: String, _ path: String, body: Data?, auth: Bool) async throws -> Data {
        do {
            return try await rawOnce(method, path, body: body, auth: auth)
        } catch let error as APIError where method == "GET" && error.isTransient {
            try await Task.sleep(for: .milliseconds(800))
            return try await rawOnce(method, path, body: body, auth: auth)
        }
    }

    private func rawOnce(_ method: String, _ path: String, body: Data?, auth: Bool) async throws -> Data {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var request = URLRequest(url: baseURL.appending(path: trimmed))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Lets the server count days and quiet hours in the person's own time zone (and follow travel).
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "X-Timezone")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth {
            guard let token, !token.isEmpty else { throw APIError.signedOut }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw Self.map(error)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unreachable }
        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            throw APIError.signedOut
        default:
            // Backend errors look like { "error": "<code>", "message": "<safe to show>" }.
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError.server(status: http.statusCode,
                                  code: json?["error"] as? String,
                                  message: json?["message"] as? String)
        }
    }

    private static func map(_ error: URLError) -> any Error {
        switch error.code {
        case .cancelled:
            return CancellationError()
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            return APIError.offline
        case .timedOut:
            return APIError.timedOut
        case .appTransportSecurityRequiresSecureConnection:
            return APIError.insecureServer
        default:
            return APIError.unreachable
        }
    }
}
