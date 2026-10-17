import Foundation
import CoreLocation
import Observation

/// Geofences around the person's risk places (CLMonitor, iOS 17+) plus a one-shot
/// current-location helper. Only "arrived"/"left" for a place id leaves this class.
@Observable
final class LocationMonitor: NSObject {
    /// "notDetermined" | "whenInUse" | "always" | "denied"
    var authorization: String = "notDetermined"
    /// Last one-shot fix, used by "add this place".
    var lastKnown: (lat: Double, lng: Double)?
    /// Wired by AppModel to POST /api/location.
    @ObservationIgnored var onEvent: ((_ placeId: String, _ entered: Bool) -> Void)?

    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private var wantsAlways = false
    @ObservationIgnored private var locationContinuation: CheckedContinuation<(lat: Double, lng: Double)?, Never>?
    @ObservationIgnored private var locationTimeout: Task<Void, Never>?

    /// CLMonitor supports at most 20 conditions per app; the server enforces the same cap.
    static let maxPlaces = 20

    #if os(iOS)
    static let monitorName = "andi-places"
    private static let fingerprintsKey = "andi.geofences"
    @ObservationIgnored private var monitor: CLMonitor?
    @ObservationIgnored private var monitorSetup: Task<CLMonitor, Never>?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    /// "lat,lng,radius" we last registered per identifier (persisted, so a relaunch doesn't re-add
    /// unchanged places and lose CLMonitor's current state).
    @ObservationIgnored private var fingerprints: [String: String] =
        (UserDefaults.standard.dictionary(forKey: LocationMonitor.fingerprintsKey) as? [String: String]) ?? [:]
    /// Last state reported per identifier, to drop duplicate events.
    @ObservationIgnored private var lastState: [String: Bool] = [:]
    /// Conditions added this session whose first "outside" event should be swallowed (see `apply`).
    @ObservationIgnored private var justAdded: Set<String> = []
    #endif

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        authorization = Self.describe(manager.authorizationStatus)
    }

    // MARK: Authorization

    /// Asks for When In Use first, then upgrades to Always once that's granted.
    func requestAuthorization() {
        wantsAlways = true
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            requestAlwaysIfPossible()
        default:
            break
        }
    }

    private func requestAlwaysIfPossible() {
        #if os(iOS)
        wantsAlways = false
        manager.requestAlwaysAuthorization()
        #endif
    }

    private func authorizationChanged(_ status: CLAuthorizationStatus) {
        authorization = Self.describe(status)
        if status == .authorizedWhenInUse, wantsAlways {
            requestAlwaysIfPossible()
        }
        // A pending one-shot request can proceed (or give up) now that we know.
        if locationContinuation != nil {
            switch authorization {
            case "whenInUse", "always": manager.requestLocation()
            case "denied": finishLocation(nil)
            default: break
            }
        }
    }

    private static func describe(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied, .restricted: return "denied"
        default: return "notDetermined"
        }
    }

    // MARK: One-shot location

    /// Returns the current coordinate, or nil if unavailable/denied/timed out (15s).
    func requestCurrentLocation() async -> (lat: Double, lng: Double)? {
        if authorization == "denied" { return nil }
        // Only one request in flight; a second caller supersedes the first.
        finishLocation(nil)
        return await withCheckedContinuation { continuation in
            locationContinuation = continuation
            locationTimeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                self?.finishLocation(nil)
            }
            manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            if manager.authorizationStatus == .notDetermined {
                manager.requestWhenInUseAuthorization() // requestLocation runs once authorized
            } else {
                manager.requestLocation()
            }
        }
    }

    private func finishLocation(_ value: (lat: Double, lng: Double)?) {
        locationTimeout?.cancel()
        locationTimeout = nil
        if let value { lastKnown = value }
        guard let continuation = locationContinuation else { return }
        locationContinuation = nil
        continuation.resume(returning: value)
    }

    // MARK: Geofences

    /// Replace the monitored conditions with these places (identifier = place.id).
    func sync(places: [Place]) {
        #if os(iOS)
        let previous = syncTask
        syncTask = Task { [weak self] in
            await previous?.value // keep syncs ordered
            await self?.apply(places)
        }
        #endif
    }

    /// Starts the monitor (and its event loop) without changing conditions.
    /// Call early on launch so background geofence wakes are delivered.
    func start() {
        #if os(iOS)
        Task { [weak self] in _ = await self?.ensureMonitor() }
        #endif
    }

    #if os(iOS)
    private func ensureMonitor() async -> CLMonitor {
        if let monitor { return monitor }
        if let monitorSetup { return await monitorSetup.value }
        let setup = Task { await CLMonitor(Self.monitorName) }
        monitorSetup = setup
        let created = await setup.value
        monitor = created
        startEvents(created)
        return created
    }

    private func startEvents(_ monitor: CLMonitor) {
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in
            do {
                for try await event in await monitor.events {
                    if Task.isCancelled { break }
                    self?.handle(identifier: event.identifier, state: event.state)
                }
            } catch {
                // The stream ended; it is recreated on the next launch.
            }
        }
    }

    private func handle(identifier: String, state: CLMonitor.Event.State) {
        let entered: Bool
        switch state {
        case .satisfied: entered = true
        case .unsatisfied: entered = false
        default: return // .unknown / .unmonitored carry no enter/exit meaning
        }
        if justAdded.remove(identifier) != nil, !entered {
            // A new condition is assumed "inside"; the first "outside" just corrects that.
            lastState[identifier] = false
            return
        }
        guard lastState[identifier] != entered else { return }
        lastState[identifier] = entered
        onEvent?(identifier, entered)
    }

    private static func fingerprint(_ place: Place) -> String {
        "\(place.lat),\(place.lng),\(place.radiusM)"
    }

    private func apply(_ places: [Place]) async {
        let monitor = await ensureMonitor()
        var wanted: [String: Place] = [:]
        for place in places.prefix(Self.maxPlaces) where wanted[place.id] == nil {
            wanted[place.id] = place
        }
        let existing = Set(await monitor.identifiers)

        for id in existing where wanted[id] == nil {
            await monitor.remove(id)
            fingerprints[id] = nil
            lastState[id] = nil
            justAdded.remove(id)
        }
        for place in wanted.values {
            let geometry = Self.fingerprint(place)
            // Same geometry as before (including from a previous launch): leave it alone so
            // CLMonitor keeps its current state and we don't re-fire "enter".
            if existing.contains(place.id), fingerprints[place.id] == geometry { continue }
            if existing.contains(place.id) { await monitor.remove(place.id) }
            let condition = CLMonitor.CircularGeographicCondition(
                center: CLLocationCoordinate2D(latitude: place.lat, longitude: place.lng),
                radius: place.radiusM
            )
            // Assume "inside": people often add a place while standing at it, and that
            // shouldn't trigger a "do you want to be here?" text. If they're actually outside,
            // the first unsatisfied event is swallowed in `handle`, so only real arrivals post.
            justAdded.insert(place.id)
            lastState[place.id] = true
            await monitor.add(condition, identifier: place.id, assuming: .satisfied)
            fingerprints[place.id] = geometry
        }
        UserDefaults.standard.set(fingerprints, forKey: Self.fingerprintsKey)
    }
    #endif
}

// MARK: - CLLocationManagerDelegate
// Callbacks are nonisolated; we copy out Sendable values and hop to the main actor.

extension LocationMonitor: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor [weak self] in self?.authorizationChanged(status) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let coordinate = locations.last?.coordinate else { return }
        let lat = coordinate.latitude, lng = coordinate.longitude
        Task { @MainActor [weak self] in self?.finishLocation((lat: lat, lng: lng)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        // kCLErrorLocationUnknown is transient; CoreLocation keeps trying until the timeout.
        if let clError = error as? CLError, clError.code == .locationUnknown { return }
        Task { @MainActor [weak self] in self?.finishLocation(nil) }
    }
}
