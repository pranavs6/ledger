// Ledger Locator: watches Ledger's place geofences with Core Location and
// reports to the Ledger server on this Mac.
//
//   LedgerLocator --url http://127.0.0.1:4545 --token-file <path>
//
// Every report carries the permission status, the latest location, and the
// inside/outside state of every geofence, so the server can always rebuild
// its picture after a restart or a sleep. The reply is the list of geofences
// to watch. Built and installed by `bin/ledger install-helper`.
import AppKit
import CoreLocation

struct Place: Decodable, Equatable {
    let id: Int
    let lat: Double
    let lon: Double
    let radius: Double
}

struct PlacesReply: Decodable {
    let places: [Place]
}

final class Locator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let url: URL
    private let tokenFile: String
    private var watched: [Int: Place] = [:]
    /// Inside or outside each place, and when that last changed.
    private var states: [Int: (inside: Bool, at: Date)] = [:]
    private var location: CLLocation?
    private var reporting = false
    private var reportAgain = false
    private let isoFormat = ISO8601DateFormatter()

    init(url: URL, tokenFile: String) {
        self.url = url
        self.tokenFile = tokenFile
        super.init()
        isoFormat.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 25
    }

    func start() {
        log("starting; reporting to \(url.absoluteString)")
        manager.requestAlwaysAuthorization()
        manager.startUpdatingLocation()
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.report() }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.log("woke; re-checking geofences")
            self.recheckAll()
            self.manager.requestLocation()
            self.report()
        }
        report()
    }

    // MARK: - Reporting

    private func authStatus() -> String {
        guard CLLocationManager.locationServicesEnabled() else { return "disabled" }
        switch manager.authorizationStatus {
        case .authorizedAlways: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "authorized"
        }
    }

    private func readToken() -> String? {
        let t = (try? String(contentsOfFile: tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        return t?.isEmpty == false ? t : nil
    }

    func report() {
        if reporting {
            reportAgain = true
            return
        }
        guard let token = readToken() else {
            log("no token at \(tokenFile); is Ledger installed?")
            return
        }
        var body: [String: Any] = ["auth": authStatus()]
        if let l = location {
            body["location"] = [
                "lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
                "accuracy": l.horizontalAccuracy, "at": isoFormat.string(from: l.timestamp),
            ]
        }
        body["states"] = states.sorted { $0.value.at < $1.value.at }.map {
            ["place_id": $0.key, "inside": $0.value.inside, "at": isoFormat.string(from: $0.value.at)] as [String: Any]
        }

        var req = URLRequest(url: url.appendingPathComponent("api/helper/report"))
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        reporting = true
        URLSession.shared.dataTask(with: req) { data, response, error in
            DispatchQueue.main.async {
                self.reporting = false
                if let error {
                    self.log("report failed: \(error.localizedDescription)")
                } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    self.log("report failed: HTTP \(http.statusCode)")
                } else if let data, let reply = try? JSONDecoder().decode(PlacesReply.self, from: data) {
                    self.sync(reply.places)
                }
                if self.reportAgain {
                    self.reportAgain = false
                    self.report()
                }
            }
        }.resume()
    }

    // MARK: - Geofences

    private func placeId(_ identifier: String) -> Int? {
        identifier.hasPrefix("place-") ? Int(identifier.dropFirst(6)) : nil
    }

    /// Watch exactly the places Ledger sent. Regions persist across launches, so
    /// ones from a previous run are replaced too.
    private func sync(_ places: [Place]) {
        let wanted = Dictionary(uniqueKeysWithValues: places.map { ($0.id, $0) })
        for region in manager.monitoredRegions {
            guard let id = placeId(region.identifier) else { continue }
            if wanted[id] == nil || wanted[id] != watched[id] {
                manager.stopMonitoring(for: region)
                watched[id] = nil
                if wanted[id] == nil { states[id] = nil }
            }
        }
        for p in places where watched[p.id] == nil {
            let region = CLCircularRegion(
                center: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon),
                radius: min(p.radius, manager.maximumRegionMonitoringDistance),
                identifier: "place-\(p.id)")
            region.notifyOnEntry = true
            region.notifyOnExit = true
            manager.startMonitoring(for: region)
            watched[p.id] = p
            log("watching place \(p.id): \(Int(p.radius)) m around \(p.lat), \(p.lon)")
        }
        if let l = location { checkDistances(l) }
    }

    private func recheckAll() {
        for region in manager.monitoredRegions { manager.requestState(for: region) }
    }

    private func set(_ id: Int, inside: Bool, why: String) {
        guard watched[id] != nil, states[id]?.inside != inside else { return }
        states[id] = (inside, Date())
        log("place \(id): \(inside ? "inside" : "outside") (\(why))")
        report()
    }

    /// A second opinion from each location fix, since region events on a Mac
    /// can lag. Leaving needs a margin beyond the radius so a noisy fix near
    /// the edge does not flap in and out.
    private func checkDistances(_ l: CLLocation) {
        guard l.horizontalAccuracy >= 0, l.horizontalAccuracy <= 200 else { return }
        for p in watched.values {
            let d = l.distance(from: CLLocation(latitude: p.lat, longitude: p.lon))
            if d <= p.radius {
                set(p.id, inside: true, why: "\(Int(d)) m from centre")
            } else if d > p.radius + max(50, l.horizontalAccuracy) {
                set(p.id, inside: false, why: "\(Int(d)) m from centre")
            }
        }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        log("permission: \(authStatus())")
        if m.authorizationStatus == .authorizedAlways {
            m.startUpdatingLocation()
            recheckAll()
        }
        report()
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        let first = location == nil
        location = l
        checkDistances(l)
        if first { report() }
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .locationUnknown { return }
        log("location error: \(error.localizedDescription)")
    }

    func locationManager(_ m: CLLocationManager, didStartMonitoringFor region: CLRegion) {
        m.requestState(for: region)
    }

    func locationManager(_ m: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        log("cannot watch \(region?.identifier ?? "region"): \(error.localizedDescription)")
    }

    func locationManager(_ m: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard let id = placeId(region.identifier) else { return }
        switch state {
        case .inside: set(id, inside: true, why: "region state")
        case .outside: set(id, inside: false, why: "region state")
        default: break
        }
    }

    func locationManager(_ m: CLLocationManager, didEnterRegion region: CLRegion) {
        if let id = placeId(region.identifier) { set(id, inside: true, why: "entered region") }
    }

    func locationManager(_ m: CLLocationManager, didExitRegion region: CLRegion) {
        if let id = placeId(region.identifier) { set(id, inside: false, why: "left region") }
    }

    private func log(_ message: String) {
        print("\(isoFormat.string(from: Date())) \(message)")
        fflush(stdout)
    }
}

// MARK: - Main

let args = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

guard let url = URL(string: argument("--url") ?? "http://127.0.0.1:4545") else {
    FileHandle.standardError.write("LedgerLocator: bad --url\n".data(using: .utf8)!)
    exit(2)
}
let tokenFile = argument("--token-file")
    ?? NSString(string: "~/Library/Application Support/ledger/helper-token").expandingTildeInPath

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// A windowless app is a candidate for App Nap, which can stretch the
// one-minute heartbeat past Ledger's five-minute timeout and end visits
// early. Opt out, but still let the Mac sleep.
let activity = ProcessInfo.processInfo.beginActivity(
    options: [.userInitiatedAllowingIdleSystemSleep], reason: "Reporting location to Ledger")
let locator = Locator(url: url, tokenFile: tokenFile)
locator.start()
app.run()
