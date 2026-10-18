import SwiftUI

/// A playground for andi's look: try materials, colors and motion on a live orb, see how it reacts
/// to each mood, then save the one you like. Saved looks show wherever `AndiPersona()` is used.
struct PersonaLabView: View {
    @AppStorage(PersonaStyle.storageKey) private var savedJSON = ""
    @State private var draft = PersonaStyle.saved
    @State private var mood: PersonaMood = .idle
    @State private var savedCount = 0
    @State private var copiedCount = 0

    private var saved: PersonaStyle { PersonaStyle(json: savedJSON) ?? .standard }
    private var isSaved: Bool { draft == saved }

    var body: some View {
        VStack(spacing: 0) {
            stage
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    presetsSection
                    materialSection
                    colorsSection
                    feelSection
                    HStack(spacing: 12) {
                        Button {
                            draft = .shuffled()
                        } label: {
                            Label("shuffle", systemImage: "dice")
                        }
                        .buttonStyle(.andiSecondary)
                        Button("back to saved") { draft = saved }
                            .buttonStyle(.andiSecondary)
                            .disabled(isSaved)
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 24)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom) { saveBar }
        .background(Theme.background.ignoresSafeArea())
        .foregroundStyle(Theme.text)
        .navigationTitle("andi's look")
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    copyAsCode()
                } label: {
                    Label("copy as code", systemImage: "chevron.left.forwardslash.chevron.right")
                }
            }
        }
        .andiHaptic(.success, trigger: savedCount)
        .andiHaptic(.light, trigger: copiedCount)
        .andiHaptic(.light, trigger: mood)
    }

    // MARK: Stage

    private var stage: some View {
        VStack(spacing: 0) {
            AndiPersona(style: draft, mood: mood, interactive: true)
                .frame(maxWidth: .infinity)
                .frame(height: 310)
                .overlay(alignment: .top) {
                    Text("touch and drag")
                        .font(Theme.caption)
                        .foregroundStyle(Theme.faint)
                        .allowsHitTesting(false)
                }

            Picker("mood", selection: $mood) {
                ForEach(PersonaMood.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 14)
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
    }

    // MARK: Controls

    private var presetsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("presets").andiLabel()
            ScrollView(.horizontal) {
                HStack(spacing: 14) {
                    ForEach(PersonaStyle.presets, id: \.name) { preset in
                        Button {
                            draft = preset
                        } label: {
                            VStack(spacing: 6) {
                                AndiPersona(style: preset)
                                    .frame(width: 72, height: 72)
                                    .background(
                                        Circle().strokeBorder(
                                            draft.name == preset.name ? Theme.text : .clear, lineWidth: 1.5
                                        )
                                    )
                                Text(preset.name)
                                    .font(Theme.caption)
                                    .foregroundStyle(draft.name == preset.name ? Theme.text : Theme.muted)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(preset.name)
                        .accessibilityAddTraits(draft.name == preset.name ? .isSelected : [])
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
            .scrollIndicators(.hidden)
            .padding(.horizontal, -Theme.gutter)
        }
    }

    private var materialSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("material").andiLabel()
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(PersonaMaterial.allCases) { material in
                        let selected = draft.material == material
                        Button(material.label) { draft.material = material }
                            .font(Theme.caption.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .foregroundStyle(selected ? Theme.onPrimary : Theme.text)
                            .background(Capsule().fill(selected ? Theme.primary : Theme.card))
                            .overlay(Capsule().strokeBorder(Theme.hairline))
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
            .scrollIndicators(.hidden)
            .padding(.horizontal, -Theme.gutter)
        }
    }

    private var colorsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("colors").andiLabel()
            VStack(spacing: 14) {
                ColorPicker("glow", selection: colorBinding(\.glow), supportsOpacity: false)
                ColorPicker("body", selection: colorBinding(\.body), supportsOpacity: false)
                ColorPicker("depth", selection: colorBinding(\.depth), supportsOpacity: false)
            }
            .andiCard()
        }
    }

    private var feelSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("feel").andiLabel()
            VStack(spacing: 18) {
                slider("motion", value: $draft.speed, in: 0.2...3)
                slider("turbulence", value: $draft.turbulence, in: 0...1.5)
                slider("halo", value: $draft.halo, in: 0...1.5)
                slider("size", value: $draft.size, in: 0.6...1.15)
            }
            .andiCard()
        }
    }

    private var saveBar: some View {
        VStack(spacing: 8) {
            Button(isSaved ? "this is andi's look" : "use this look") {
                savedJSON = draft.json
                savedCount += 1
            }
            .buttonStyle(.andiPrimary)
            .disabled(isSaved)
            Text(isSaved ? "saved on this phone" : "currently: \(saved.name)")
                .font(Theme.caption)
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(Theme.background.opacity(0.92))
    }

    // MARK: Helpers

    private func slider(_ title: String, value: Binding<Double>, in range: ClosedRange<Double>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(Theme.body)
                Spacer()
                Text(value.wrappedValue, format: .number.precision(.fractionLength(2)))
                    .font(Theme.caption.monospacedDigit())
                    .foregroundStyle(Theme.muted)
            }
            Slider(value: value, in: range)
                .accessibilityLabel(title)
        }
    }

    private func colorBinding(_ keyPath: WritableKeyPath<PersonaStyle, PersonaRGB>) -> Binding<Color> {
        Binding(
            get: { draft[keyPath: keyPath].color },
            set: { draft[keyPath: keyPath] = PersonaRGB($0) }
        )
    }

    private func copyAsCode() {
        #if canImport(UIKit)
        UIPasteboard.general.string = draft.swiftLiteral
        #endif
        copiedCount += 1
    }
}

#Preview {
    NavigationStack { PersonaLabView() }
        .preferredColorScheme(.dark)
}
