import SwiftUI
#if os(iOS)
import UIKit
#endif

struct PlacesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var showAdd = false

    private var places: [Place] { model.me?.places ?? [] }

    var body: some View {
        List {
            Section {
                Text("andi only learns that you arrived or left, never where you are.")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
                    .listRowBackground(Color.clear)
            }

            if model.me?.consents.location == false {
                Section {
                    Text("noticing places is off in settings, so andi won't check in near these.")
                        .font(Theme.caption)
                        .foregroundStyle(Theme.muted)
                }
                .listRowBackground(Theme.card)
            } else {
                locationPermissionSection
            }

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

            Section("your places") {
                if places.isEmpty {
                    ContentUnavailableView(
                        "no places yet",
                        systemImage: "mappin.slash",
                        description: Text("add a bar or store that pulls at you. andi will check in when you get close.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(places) { place in
                        PlaceRow(place: place)
                    }
                    .onDelete(perform: delete)
                }
            }
            .listRowBackground(Theme.card)
        }
        .andiScreenBackground()
        .navigationTitle("places")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.lastError = nil
                    showAdd = true
                } label: {
                    Label("add a place", systemImage: "plus")
                }
                .disabled(places.count >= LocationMonitor.maxPlaces)
                .accessibilityHint(places.count >= LocationMonitor.maxPlaces
                                   ? "you have the most places andi can watch. remove one first." : "")
            }
        }
        .sheet(isPresented: $showAdd) {
            AddPlaceSheet().environment(model)
        }
        .refreshable { await model.refresh() }
    }

    @ViewBuilder private var locationPermissionSection: some View {
        switch model.location.authorization {
        case "notDetermined":
            Section {
                Button("turn on location for andi") { model.location.requestAuthorization() }
            } footer: {
                Text("needed so andi can notice when you're near one of these places.")
            }
            .listRowBackground(Theme.card)
        case "whenInUse":
            Section {
                Button("allow \"always\"") { model.location.requestAuthorization() }
            } footer: {
                Text("with \"always\", andi can notice even when the app is closed.")
            }
            .listRowBackground(Theme.card)
        case "denied":
            Section {
                #if os(iOS)
                Button("open settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
                #endif
            } footer: {
                Text("location is off for andi, so these places can't help yet. you can turn it on in settings.")
            }
            .listRowBackground(Theme.card)
        default:
            EmptyView()
        }
    }

    private func delete(at offsets: IndexSet) {
        let doomed = offsets.compactMap { places.indices.contains($0) ? places[$0] : nil }
        Task {
            for place in doomed {
                await model.deletePlace(place) // refreshes `me` (and the geofences) after each
            }
        }
    }
}

private struct PlaceRow: View {
    let place: Place

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(place.name, systemImage: place.kind.uiSymbol)
                .font(Theme.headline)
                .foregroundStyle(Theme.text)
            Text("\(place.kind.uiLabel) · \(Int(place.radiusM)) m")
                .font(Theme.caption)
                .foregroundStyle(Theme.muted)
            if let alternative = place.alternative, !alternative.isEmpty {
                Text("instead: \(alternative)")
                    .font(Theme.caption)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Add a place

private struct AddPlaceSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var kind: PlaceKind = .bar
    @State private var radius: Double = 200
    @State private var alternative = ""
    @State private var coordinate: (lat: Double, lng: Double)?
    @State private var isLocating = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    private var canSave: Bool {
        !name.andiTrimmed.isEmpty && coordinate != nil && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("the place") {
                    TextField("name", text: $name)
                        .focused($focused)
                    Picker("kind", selection: $kind) {
                        ForEach(PlaceKind.allCases, id: \.self) { kind in
                            Label(kind.uiLabel, systemImage: kind.uiSymbol).tag(kind)
                        }
                    }
                }

                Section {
                    Button {
                        locate()
                    } label: {
                        HStack {
                            Label("use my current location", systemImage: "location.fill")
                            Spacer()
                            if isLocating {
                                ProgressView()
                            } else if coordinate != nil {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Theme.riskLow)
                                    .accessibilityLabel("location set")
                            }
                        }
                    }
                    .disabled(isLocating)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("notice me within \(Int(radius)) m")
                            .accessibilityHidden(true)
                        Slider(value: $radius, in: 100...500, step: 25) {
                            Text("radius")
                        } minimumValueLabel: {
                            Text("100").font(Theme.caption)
                        } maximumValueLabel: {
                            Text("500").font(Theme.caption)
                        }
                        .accessibilityLabel("radius")
                        .accessibilityValue("\(Int(radius)) meters")
                    }
                } footer: {
                    Text("stand at the place, or close to it. andi only learns that you arrived or left, never where you are.")
                }

                Section {
                    TextField("a coffee shop, a park, a friend's place…", text: $alternative)
                        .focused($focused)
                } header: {
                    Text("safe alternative nearby")
                } footer: {
                    Text("optional. andi can suggest it when you're close.")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(Theme.riskElevated)
                    }
                }
            }
            .formStyle(.grouped)
            .andiScreenBackground()
            .scrollDismissesKeyboard(.interactively)
            .keyboardDoneButton { focused = false }
            .navigationTitle("add a place")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("save") { save() }
                            .disabled(!canSave)
                    }
                }
            }
        }
        .tint(Theme.accent)
    }

    private func locate() {
        focused = false
        isLocating = true
        errorMessage = nil
        Task {
            let found = await model.location.requestCurrentLocation()
            isLocating = false
            if let found {
                coordinate = found
            } else if model.location.authorization == "denied" {
                errorMessage = "location is off for andi. turn it on in settings to add a place."
            } else {
                errorMessage = "couldn't find you just now. try again in a moment."
            }
        }
    }

    private func save() {
        guard let coordinate, !isSaving else { return }
        focused = false
        isSaving = true
        errorMessage = nil
        model.lastError = nil
        let alt = alternative.andiTrimmed
        Task {
            let saved = await model.addPlace(
                name: name.andiTrimmed,
                lat: coordinate.lat,
                lng: coordinate.lng,
                radiusM: radius,
                kind: kind,
                alternative: alt.isEmpty ? nil : alt
            )
            isSaving = false
            if saved {
                dismiss()
            } else {
                // e.g. the 20-place limit (409) — the server's message is shown as-is.
                errorMessage = model.lastError ?? "that didn't save. try again."
                model.lastError = nil
            }
        }
    }
}

#Preview("places") {
    NavigationStack { PlacesView() }
        .environment(AppModel.preview())
        .preferredColorScheme(.dark)
}

#Preview("places · empty") {
    let model = AppModel.preview(me: {
        var me = MockData.me
        me.places = []
        return me
    }())
    return NavigationStack { PlacesView() }
        .environment(model)
        .preferredColorScheme(.dark)
}

#Preview("add a place") {
    let model = AppModel.preview()
    return Text("places")
        .sheet(isPresented: .constant(true)) { AddPlaceSheet().environment(model) }
        .environment(model)
        .preferredColorScheme(.dark)
}
