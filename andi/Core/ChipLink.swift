import Foundation
import CoreBluetooth
import Observation

/// Pairs the ESP32 "Andi Chip" over BLE: scan -> connect -> discover -> subscribe to status
/// -> write Wi-Fi + websocket config -> wait for {"state":"ws_ok"}.
@Observable
final class ChipLink: NSObject {
    enum State: Equatable { case idle, scanning, connecting, sending, waitingForWifi, paired, failed(String) }

    var state: State = .idle

    // Bluetooth contract (firmware matches these).
    static let serviceUUID = CBUUID(string: "A11D0001-5A1E-4C0D-9E8F-0A1B2C3D4E5F")
    static let configUUID = CBUUID(string: "A11D0002-5A1E-4C0D-9E8F-0A1B2C3D4E5F")
    static let statusUUID = CBUUID(string: "A11D0003-5A1E-4C0D-9E8F-0A1B2C3D4E5F")

    private static let scanTimeout: Duration = .seconds(20)
    private static let connectTimeout: Duration = .seconds(20)
    private static let wifiTimeout: Duration = .seconds(30)

    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var peripheral: CBPeripheral?
    @ObservationIgnored private var configChar: CBCharacteristic?
    @ObservationIgnored private var statusChar: CBCharacteristic?
    @ObservationIgnored private var payload: Data?
    @ObservationIgnored private var wantsScan = false
    @ObservationIgnored private var timeout: Task<Void, Never>?

    /// Starts pairing. Safe to call again; any attempt in progress is cancelled first.
    func pair(ssid: String, password: String, wsUrl: String) {
        cleanUp()
        let config: [String: String] = ["ssid": ssid, "password": password, "ws": wsUrl]
        guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.withoutEscapingSlashes]) else {
            state = .failed("couldn't prepare the wifi details")
            return
        }
        payload = data
        state = .scanning
        wantsScan = true
        if let central {
            if central.state == .poweredOn { startScan() } else { handlePowerState(central.state) }
        } else {
            // Scanning starts from centralManagerDidUpdateState once Bluetooth is ready.
            central = CBCentralManager(delegate: self, queue: nil) // nil = main queue
        }
    }

    /// Stops everything and returns to idle.
    func cancel() {
        cleanUp()
        state = .idle
    }

    /// Demo mode: walks through the states without Bluetooth.
    func simulatePairing() async {
        cleanUp()
        for step in [State.scanning, .connecting, .sending, .waitingForWifi] {
            state = step
            do { try await Task.sleep(for: .milliseconds(700)) } catch { state = .idle; return }
            guard state == step else { return } // cancelled meanwhile
        }
        state = .paired
    }

    // MARK: Steps

    private func startScan() {
        guard let central, wantsScan else { return }
        wantsScan = false
        state = .scanning
        central.scanForPeripherals(withServices: [Self.serviceUUID], options: nil)
        arm(Self.scanTimeout, "couldn't find your chip. make sure it's on and nearby.")
    }

    private func handlePowerState(_ s: CBManagerState) {
        switch s {
        case .poweredOn:
            startScan()
        case .poweredOff:
            if isActive { fail("bluetooth is off. turn it on and try again.") }
        case .unauthorized:
            if isActive { fail("andi needs bluetooth permission to pair the chip.") }
        case .unsupported:
            if isActive { fail("this device doesn't support bluetooth pairing.") }
        default:
            break // .unknown / .resetting: wait for the next update
        }
    }

    private var isActive: Bool {
        switch state {
        case .scanning, .connecting, .sending, .waitingForWifi: return true
        default: return false
        }
    }

    private func discovered(_ p: CBPeripheral) {
        guard state == .scanning, peripheral == nil else { return }
        central?.stopScan()
        peripheral = p // must be retained or CoreBluetooth drops it
        p.delegate = self
        state = .connecting
        arm(Self.connectTimeout, "couldn't connect to your chip. try again.")
        central?.connect(p, options: nil)
    }

    private func connected(_ p: CBPeripheral) {
        guard p == peripheral else { return }
        p.discoverServices([Self.serviceUUID])
    }

    private func servicesDiscovered(_ p: CBPeripheral, error: (any Error)?) {
        guard p == peripheral else { return }
        guard error == nil, let service = p.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            fail("that doesn't look like an andi chip.")
            return
        }
        p.discoverCharacteristics([Self.configUUID, Self.statusUUID], for: service)
    }

    private func characteristicsDiscovered(_ p: CBPeripheral, service: CBService, error: (any Error)?) {
        guard p == peripheral else { return }
        let chars = service.characteristics ?? []
        configChar = chars.first { $0.uuid == Self.configUUID }
        statusChar = chars.first { $0.uuid == Self.statusUUID }
        guard error == nil, configChar != nil, let statusChar else {
            fail("your chip needs a firmware update.")
            return
        }
        // Subscribe first so we never miss a status update; write once notifications are on.
        p.setNotifyValue(true, for: statusChar)
    }

    private func notifyStateChanged(_ p: CBPeripheral, characteristic: CBCharacteristic, error: (any Error)?) {
        guard p == peripheral, characteristic.uuid == Self.statusUUID else { return }
        if error != nil {
            fail("couldn't listen to your chip. try again.")
            return
        }
        writeConfig()
    }

    private func writeConfig() {
        guard let peripheral, let configChar, let payload, state == .connecting else { return }
        // Long writes (with response) top out at 512 bytes per the ATT spec.
        guard payload.count <= 512 else {
            fail("those wi-fi details are too long for the chip.")
            return
        }
        state = .sending
        peripheral.writeValue(payload, for: configChar, type: .withResponse)
    }

    private func wrote(_ p: CBPeripheral, characteristic: CBCharacteristic, error: (any Error)?) {
        guard p == peripheral, characteristic.uuid == Self.configUUID else { return }
        if error != nil {
            fail("couldn't send the wifi details to your chip.")
            return
        }
        if state == .sending { state = .waitingForWifi }
        arm(Self.wifiTimeout, "your chip couldn't join that wifi. check the name and password.")
    }

    private func statusReceived(_ p: CBPeripheral, characteristic: CBCharacteristic, error: (any Error)?) {
        guard p == peripheral, characteristic.uuid == Self.statusUUID, error == nil,
              let data = characteristic.value,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let status = json["state"] as? String else { return }
        let detail = json["detail"] as? String

        switch status {
        case "ws_ok":
            timeout?.cancel()
            state = .paired
            disconnect() // config is saved on the chip; it talks to the backend over wifi now
        case "error":
            fail(detail.map { $0.isEmpty ? "your chip hit a problem." : $0 } ?? "your chip hit a problem.")
        case "wifi_ok":
            // On wi-fi; give it a fresh window to reach the backend websocket.
            state = .waitingForWifi
            arm(Self.wifiTimeout, "your chip joined wi-fi but couldn't reach andi. try again in a bit.")
        case "wifi_connecting":
            // Still working; the wifi timer armed after the write keeps running.
            if state == .sending || state == .connecting { state = .waitingForWifi }
        default:
            break
        }
    }

    private func disconnectedUnexpectedly(_ p: CBPeripheral) {
        guard p == peripheral else { return }
        peripheral = nil
        if isActive { fail("lost the connection to your chip. try again.") }
    }

    // MARK: Helpers

    private func arm(_ duration: Duration, _ message: String) {
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled, let self, self.isActive else { return }
            self.fail(message)
        }
    }

    private func fail(_ message: String) {
        cleanUp()
        state = .failed(message)
    }

    private func disconnect() {
        if let central, let peripheral { central.cancelPeripheralConnection(peripheral) }
        peripheral = nil
        configChar = nil
        statusChar = nil
    }

    /// Stops scanning, drops the connection and timers. Does not change `state`.
    private func cleanUp() {
        timeout?.cancel()
        timeout = nil
        wantsScan = false
        payload = nil
        if let central, central.state == .poweredOn, central.isScanning { central.stopScan() }
        disconnect()
    }
}

// MARK: - CoreBluetooth delegates
// The central uses the main queue, so callbacks already run on the main thread;
// they're nonisolated to satisfy the ObjC protocols and step onto the main actor.

extension ChipLink: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let power = central.state
        MainActor.assumeIsolated { self.handlePowerState(power) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated { self.discovered(peripheral) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated { self.connected(peripheral) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: (any Error)?) {
        MainActor.assumeIsolated {
            guard peripheral == self.peripheral else { return }
            self.fail("couldn't connect to your chip. try again.")
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: (any Error)?) {
        MainActor.assumeIsolated { self.disconnectedUnexpectedly(peripheral) }
    }
}

extension ChipLink: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: (any Error)?) {
        MainActor.assumeIsolated { self.servicesDiscovered(peripheral, error: error) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: (any Error)?) {
        MainActor.assumeIsolated { self.characteristicsDiscovered(peripheral, service: service, error: error) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: (any Error)?) {
        MainActor.assumeIsolated { self.notifyStateChanged(peripheral, characteristic: characteristic, error: error) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: (any Error)?) {
        MainActor.assumeIsolated { self.wrote(peripheral, characteristic: characteristic, error: error) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: (any Error)?) {
        MainActor.assumeIsolated { self.statusReceived(peripheral, characteristic: characteristic, error: error) }
    }
}
