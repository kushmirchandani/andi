import SwiftUI

// andi's visual persona: a living orb drawn by `andiPersona` in AndiPersona.metal.
//
// Drop `AndiPersona()` anywhere to show the look picked in the persona lab (saved on this phone).
// Pass `style:` to force a specific look, and `mood:` to make it react.

// MARK: - Style

enum PersonaMaterial: String, Codable, CaseIterable, Identifiable {
    case pearl, chrome, plasma, glass, nebula

    var id: String { rawValue }

    var label: String {
        switch self {
        case .pearl: "pearl"
        case .chrome: "liquid metal"
        case .plasma: "plasma"
        case .glass: "glass"
        case .nebula: "nebula"
        }
    }

    /// Must match the `material` switch in AndiPersona.metal.
    fileprivate var shaderIndex: Float {
        switch self {
        case .pearl: 0
        case .chrome: 1
        case .plasma: 2
        case .glass: 3
        case .nebula: 4
        }
    }
}

/// An sRGB color that can be saved (SwiftUI's `Color` isn't Codable).
struct PersonaRGB: Codable, Equatable {
    var r: Double
    var g: Double
    var b: Double

    init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }

    init(hex: UInt32) {
        self.init(
            r: Double((hex >> 16) & 0xFF) / 255,
            g: Double((hex >> 8) & 0xFF) / 255,
            b: Double(hex & 0xFF) / 255
        )
    }

    init(_ color: Color) {
        // `resolve` hands back linear values; store gamma-encoded sRGB so hex round-trips.
        let c = color.resolve(in: EnvironmentValues())
        func encode(_ v: Float) -> Double {
            let x = Double(min(max(v, 0), 1))
            return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
        }
        self.init(r: encode(c.linearRed), g: encode(c.linearGreen), b: encode(c.linearBlue))
    }

    var color: Color { Color(.sRGB, red: r, green: g, blue: b) }

    var hex: String {
        String(format: "0x%02X%02X%02X", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
}

struct PersonaStyle: Codable, Equatable {
    var name: String
    var material: PersonaMaterial
    /// Halo, highlights, the brightest parts.
    var glow: PersonaRGB
    /// The main body color.
    var body: PersonaRGB
    /// Shadows, rim and the darkest parts.
    var depth: PersonaRGB
    /// Motion speed, 0.2...3.
    var speed: Double = 1
    /// How much the surface churns, 0...1.5.
    var turbulence: Double = 0.6
    /// Halo strength, 0...1.5.
    var halo: Double = 0.7
    /// Orb size inside its frame, 0.6...1.15.
    var size: Double = 1

    static let presets: [PersonaStyle] = [
        PersonaStyle(name: "moonstone", material: .pearl,
                     glow: .init(hex: 0x9FE3CB), body: .init(hex: 0xC9C2FF), depth: .init(hex: 0xF2EDE4),
                     speed: 0.8, turbulence: 0.6, halo: 0.6),
        PersonaStyle(name: "mercury", material: .chrome,
                     glow: .init(hex: 0xF5F2EC), body: .init(hex: 0x7A8896), depth: .init(hex: 0x1A1D22),
                     speed: 0.7, turbulence: 0.7, halo: 0.35),
        PersonaStyle(name: "aura", material: .plasma,
                     glow: .init(hex: 0x9FE3CB), body: .init(hex: 0x2E8F7A), depth: .init(hex: 0x06140F),
                     speed: 0.9, turbulence: 0.7, halo: 0.8),
        PersonaStyle(name: "tide", material: .glass,
                     glow: .init(hex: 0x9FE3CB), body: .init(hex: 0x4B7BFF), depth: .init(hex: 0xE8FFF8),
                     speed: 1, turbulence: 0.5, halo: 0.5),
        PersonaStyle(name: "deep space", material: .nebula,
                     glow: .init(hex: 0xFFE9C7), body: .init(hex: 0x5B4BD6), depth: .init(hex: 0x2E8F7A),
                     speed: 0.8, turbulence: 0.8, halo: 0.6),
        PersonaStyle(name: "sunrise", material: .plasma,
                     glow: .init(hex: 0xFFD9A0), body: .init(hex: 0xB8542A), depth: .init(hex: 0x1A0A12),
                     speed: 0.7, turbulence: 0.9, halo: 0.7),
    ]

    static let standard = presets[0]

    // MARK: Saving

    static let storageKey = "andi.persona"

    init(name: String, material: PersonaMaterial, glow: PersonaRGB, body: PersonaRGB, depth: PersonaRGB,
         speed: Double = 1, turbulence: Double = 0.6, halo: Double = 0.7, size: Double = 1) {
        self.name = name
        self.material = material
        self.glow = glow
        self.body = body
        self.depth = depth
        self.speed = speed
        self.turbulence = turbulence
        self.halo = halo
        self.size = size
    }

    init?(json: String) {
        guard let data = json.data(using: .utf8),
              let style = try? JSONDecoder().decode(PersonaStyle.self, from: data) else { return nil }
        self = style
    }

    var json: String {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    /// The look picked in the persona lab, or the standard one.
    static var saved: PersonaStyle {
        UserDefaults.standard.string(forKey: storageKey).flatMap(PersonaStyle.init(json:)) ?? .standard
    }

    /// Paste-able Swift, for promoting a look into `presets` or the code.
    var swiftLiteral: String {
        func num(_ v: Double) -> String { String(format: "%.2f", v) }
        return """
        PersonaStyle(name: "\(name)", material: .\(material.rawValue),
                     glow: .init(hex: \(glow.hex)), body: .init(hex: \(body.hex)), depth: .init(hex: \(depth.hex)),
                     speed: \(num(speed)), turbulence: \(num(turbulence)), halo: \(num(halo)), size: \(num(size))),
        """
    }

    /// A random look with colors that belong together.
    static func shuffled() -> PersonaStyle {
        let hue = Double.random(in: 0...1)
        let spread = Double.random(in: 0.06...0.4) * (Bool.random() ? 1 : -1)
        func hsb(_ h: Double, _ s: Double, _ b: Double) -> PersonaRGB {
            PersonaRGB(Color(hue: (h + 1).truncatingRemainder(dividingBy: 1), saturation: s, brightness: b))
        }
        return PersonaStyle(
            name: "custom",
            material: PersonaMaterial.allCases.randomElement() ?? .pearl,
            glow: hsb(hue, .random(in: 0.15...0.5), .random(in: 0.9...1)),
            body: hsb(hue + spread, .random(in: 0.45...0.9), .random(in: 0.5...0.9)),
            depth: hsb(hue + spread * 2, .random(in: 0.3...0.9), .random(in: 0.08...0.9)),
            speed: .random(in: 0.5...1.5),
            turbulence: .random(in: 0.3...1.1),
            halo: .random(in: 0.3...1)
        )
    }
}

// MARK: - Mood

/// What andi is doing. Each mood nudges motion, energy and size; changes ease in, never pop.
enum PersonaMood: String, CaseIterable, Identifiable {
    case idle, listening, thinking, speaking

    var id: String { rawValue }

    fileprivate struct Targets {
        var speed: Double
        var energy: Double
        var scale: Double
        var halo: Double
        var turbulence: Double
        var voice: Double
    }

    fileprivate var targets: Targets {
        switch self {
        case .idle: Targets(speed: 1, energy: 0.1, scale: 1, halo: 1, turbulence: 0, voice: 0)
        case .listening: Targets(speed: 0.8, energy: 0.25, scale: 1.06, halo: 1.35, turbulence: -0.1, voice: 0)
        case .thinking: Targets(speed: 2.4, energy: 0.35, scale: 0.94, halo: 0.9, turbulence: 0.4, voice: 0)
        case .speaking: Targets(speed: 1.3, energy: 0.3, scale: 1, halo: 1.1, turbulence: 0.1, voice: 1)
        }
    }
}

// MARK: - Driver

/// Per-frame values for the shader. Eases toward the mood's targets so switching moods is smooth,
/// and accumulates time so changing speed doesn't make the animation jump.
final class PersonaDriver {
    struct Frame {
        var time: Double
        var energy: Double
        var scale: Double
        var halo: Double
        var turbulence: Double
        var touch: Double
    }

    var touching = false

    private var last: Date?
    private var time: Double = 0
    private var current = PersonaMood.idle.targets
    private var touch: Double = 0

    func advance(to date: Date, style: PersonaStyle, mood: PersonaMood, reduceMotion: Bool) -> Frame {
        let dt = min(last.map { date.timeIntervalSince($0) } ?? 0, 1.0 / 20)
        last = date

        let target = mood.targets
        let k = 1 - exp(-dt * 4)
        current.speed += (target.speed - current.speed) * k
        current.energy += (target.energy - current.energy) * k
        current.scale += (target.scale - current.scale) * k
        current.halo += (target.halo - current.halo) * k
        current.turbulence += (target.turbulence - current.turbulence) * k
        current.voice += (target.voice - current.voice) * k
        touch += ((touching ? 1 : 0) - touch) * (1 - exp(-dt * (touching ? 10 : 2.5)))

        time += dt * style.speed * current.speed * (reduceMotion ? 0.25 : 1)

        // A fake voice envelope: two beating sines read like syllables.
        let wall = date.timeIntervalSinceReferenceDate
        let voice = current.voice * abs(sin(wall * 7.3) * sin(wall * 2.1 + 1))
        let breath = reduceMotion ? 0 : sin(wall * 1.3) * 0.015

        return Frame(
            time: time,
            energy: current.energy + voice * 0.6,
            scale: style.size * current.scale * (1 + breath + voice * 0.05),
            halo: style.halo * current.halo * (1 + voice * 0.4),
            turbulence: max(0, style.turbulence + current.turbulence),
            touch: touch
        )
    }
}

// MARK: - View

struct AndiPersona: View {
    /// nil shows the look saved from the persona lab.
    var style: PersonaStyle? = nil
    var mood: PersonaMood = .idle
    /// Lets a finger push and ripple the orb.
    var interactive = false

    @AppStorage(PersonaStyle.storageKey) private var savedJSON = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var driver = PersonaDriver()
    @State private var touchPoint: CGPoint?

    private var resolved: PersonaStyle { style ?? PersonaStyle(json: savedJSON) ?? .standard }

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation) { timeline in
                let look = resolved
                let frame = driver.advance(to: timeline.date, style: look, mood: mood, reduceMotion: reduceMotion)
                Rectangle()
                    .fill(.white)
                    .colorEffect(ShaderLibrary.andiPersona(
                        .float2(geo.size),
                        .float(frame.time),
                        .float(look.material.shaderIndex),
                        .color(look.glow.color),
                        .color(look.body.color),
                        .color(look.depth.color),
                        .float(frame.turbulence),
                        .float(frame.halo),
                        .float(frame.energy),
                        .float2(touchPoint ?? CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)),
                        .float(frame.touch),
                        .float(frame.scale)
                    ))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        touchPoint = value.location
                        driver.touching = true
                    }
                    .onEnded { _ in driver.touching = false },
                including: interactive ? .all : .none
            )
        }
        .accessibilityHidden(true)
    }
}

#Preview {
    AndiPersona(style: .standard, mood: .speaking, interactive: true)
        .frame(width: 320, height: 320)
        .background(Theme.background)
}
