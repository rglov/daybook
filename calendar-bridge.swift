import EventKit
import Foundation

@main
struct DaybookCalendarBridge {
    static func main() async {
        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else {
            writeJSON(["authorized": false, "events": [], "error": "Missing command."])
            return
        }

        let store = EKEventStore()
        switch arguments[1] {
        case "request":
            do {
                let granted: Bool
                if #available(macOS 14.0, *) {
                    granted = try await store.requestFullAccessToEvents()
                } else {
                    granted = try await withCheckedThrowingContinuation { continuation in
                        store.requestAccess(to: .event) { allowed, error in
                            if let error {
                                continuation.resume(throwing: error)
                            } else {
                                continuation.resume(returning: allowed)
                            }
                        }
                    }
                }
                writeJSON(["authorized": granted, "events": []])
            } catch {
                writeJSON(["authorized": false, "events": [], "error": error.localizedDescription])
            }
        case "list":
            guard arguments.count >= 3 else {
                writeJSON(["authorized": false, "events": [], "error": "Missing date."])
                return
            }
            let status = EKEventStore.authorizationStatus(for: .event)
            let hasFullAccess: Bool
            if #available(macOS 14.0, *) {
                hasFullAccess = status == .fullAccess
            } else {
                hasFullAccess = status == .authorized
            }
            guard hasFullAccess else {
                writeJSON(["authorized": false, "events": []])
                return
            }
            guard let date = dateFromDay(arguments[2]),
                  let nextDay = Calendar.current.date(byAdding: .day, value: 1, to: date) else {
                writeJSON(["authorized": true, "events": [], "error": "Invalid date."])
                return
            }

            let predicate = store.predicateForEvents(withStart: date, end: nextDay, calendars: nil)
            let matchingEvents = store.events(matching: predicate).sorted { left, right in
                left.startDate < right.startDate
            }
            var events: [[String: Any]] = []
            for event in matchingEvents {
                events.append(eventDictionary(event))
            }
            writeJSON(["authorized": true, "events": events])
        case "list-month":
            guard arguments.count >= 3 else {
                writeJSON(["authorized": false, "events": [], "error": "Missing month."])
                return
            }
            let status = EKEventStore.authorizationStatus(for: .event)
            let hasFullAccess: Bool
            if #available(macOS 14.0, *) {
                hasFullAccess = status == .fullAccess
            } else {
                hasFullAccess = status == .authorized
            }
            guard hasFullAccess else {
                writeJSON(["authorized": false, "events": []])
                return
            }
            guard let monthStart = dateFromMonth(arguments[2]),
                  let monthEnd = Calendar.current.date(byAdding: .month, value: 1, to: monthStart) else {
                writeJSON(["authorized": true, "events": [], "error": "Invalid month."])
                return
            }
            let predicate = store.predicateForEvents(withStart: monthStart, end: monthEnd, calendars: nil)
            let matchingEvents = store.events(matching: predicate).sorted { left, right in
                left.startDate < right.startDate
            }
            var events: [[String: Any]] = []
            for event in matchingEvents {
                events.append(eventDictionary(event))
            }
            writeJSON(["authorized": true, "events": events])
        case "create":
            guard arguments.count >= 3,
                  let data = Data(base64Encoded: arguments[2]),
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let title = payload["title"] as? String,
                  let startValue = payload["start"] as? String,
                  let endValue = payload["end"] as? String else {
                writeJSON(["authorized": false, "events": [], "error": "Meeting details are incomplete."])
                return
            }
            let status = EKEventStore.authorizationStatus(for: .event)
            let hasFullAccess: Bool
            if #available(macOS 14.0, *) {
                hasFullAccess = status == .fullAccess
            } else {
                hasFullAccess = status == .authorized
            }
            guard hasFullAccess else {
                writeJSON(["authorized": false, "events": [], "error": "Grant Daybook Calendar access in macOS Privacy & Security, then try again."])
                return
            }
            guard let start = dateFromISO8601(startValue),
                  let end = dateFromISO8601(endValue), end > start else {
                writeJSON(["authorized": true, "events": [], "error": "The meeting date or time is invalid. Check that the end time is after the start time."])
                return
            }
            let writableCalendar = store.defaultCalendarForNewEvents.flatMap { $0.allowsContentModifications ? $0 : nil }
                ?? store.calendars(for: .event).first(where: { $0.allowsContentModifications })
            guard let calendar = writableCalendar else {
                writeJSON(["authorized": true, "events": [], "error": "No writable calendar is available. In Calendar, add or enable a calendar where you can create events, then try again."])
                return
            }
            let event = EKEvent(eventStore: store)
            event.title = title
            event.startDate = start
            event.endDate = end
            event.calendar = calendar
            event.location = payload["location"] as? String
            event.notes = payload["agenda"] as? String
            if let urlText = payload["url"] as? String, !urlText.isEmpty, let url = URL(string: urlText) {
                event.url = url
            }
            do {
                try store.save(event, span: .thisEvent, commit: true)
                writeJSON(["authorized": true, "event": eventDictionary(event)])
            } catch {
                writeJSON(["authorized": true, "events": [], "error": error.localizedDescription])
            }
        default:
            writeJSON(["authorized": false, "events": [], "error": "Unknown command."])
        }
    }

    private static func dateFromDay(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        guard let day = formatter.date(from: value) else { return nil }
        return Calendar.current.startOfDay(for: day)
    }

    private static func dateFromISO8601(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }

    private static func dateFromMonth(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM"
        guard let month = formatter.date(from: value) else { return nil }
        return Calendar.current.dateInterval(of: .month, for: month)?.start
    }

    private static func eventDictionary(_ event: EKEvent) -> [String: Any] {
        let attendees: [[String: Any]] = attendeeDictionaries(event.attendees ?? [])
        let alarms: [[String: Any]] = alarmDictionaries(event.alarms ?? [])
        let recurrenceRules: [[String: Any]] = recurrenceDictionaries(event.recurrenceRules ?? [])

        var organizer: [String: Any] = [:]
        if let person = event.organizer {
            organizer["name"] = person.name ?? ""
            organizer["url"] = person.url.absoluteString
            organizer["status"] = String(person.participantStatus.rawValue)
            organizer["role"] = String(person.participantRole.rawValue)
            organizer["type"] = String(person.participantType.rawValue)
        }

        var result: [String: Any] = [:]
        result["title"] = event.title ?? "Untitled event"
        result["start"] = isoDate(event.startDate)
        result["end"] = isoDate(event.endDate)
        result["calendar"] = event.calendar?.title ?? "Calendar"
        result["allDay"] = event.isAllDay
        result["eventIdentifier"] = event.eventIdentifier ?? ""
        result["calendarItemIdentifier"] = event.calendarItemIdentifier
        result["calendarItemExternalIdentifier"] = event.calendarItemExternalIdentifier ?? ""
        result["calendarIdentifier"] = event.calendar?.calendarIdentifier ?? ""
        result["calendarType"] = event.calendar.map { String($0.type.rawValue) } ?? ""
        result["calendarSource"] = event.calendar?.source?.title ?? ""
        result["location"] = event.location ?? ""
        result["notes"] = event.notes ?? ""
        result["url"] = event.url?.absoluteString ?? ""
        result["createdAt"] = event.creationDate.map(isoDate) ?? ""
        result["updatedAt"] = event.lastModifiedDate.map(isoDate) ?? ""
        result["timeZone"] = event.timeZone?.identifier ?? ""
        result["attendees"] = attendees
        result["organizer"] = organizer
        result["availability"] = String(event.availability.rawValue)
        result["status"] = String(event.status.rawValue)
        result["occurrenceDate"] = event.occurrenceDate.map(isoDate) ?? ""
        result["isDetached"] = event.isDetached
        result["alarms"] = alarms
        result["recurrenceRules"] = recurrenceRules
        return result
    }

    private static func attendeeDictionaries(_ attendees: [EKParticipant]) -> [[String: Any]] {
        var result: [[String: Any]] = []
        for attendee in attendees {
            var row: [String: Any] = [:]
            row["name"] = attendee.name ?? ""
            row["url"] = attendee.url.absoluteString
            row["status"] = String(attendee.participantStatus.rawValue)
            row["role"] = String(attendee.participantRole.rawValue)
            row["type"] = String(attendee.participantType.rawValue)
            result.append(row)
        }
        return result
    }

    private static func alarmDictionaries(_ alarms: [EKAlarm]) -> [[String: Any]] {
        var result: [[String: Any]] = []
        for alarm in alarms {
            var row: [String: Any] = [:]
            row["absolute_date"] = alarm.absoluteDate.map(isoDate) ?? ""
            row["relative_offset_seconds"] = alarm.relativeOffset
            result.append(row)
        }
        return result
    }

    private static func recurrenceDictionaries(_ rules: [EKRecurrenceRule]) -> [[String: Any]] {
        var result: [[String: Any]] = []
        for rule in rules {
            var weekdays: [[String: Any]] = []
            for day in rule.daysOfTheWeek ?? [] {
                var weekday: [String: Any] = [:]
                weekday["day"] = String(day.dayOfTheWeek.rawValue)
                weekday["week_number"] = day.weekNumber
                weekdays.append(weekday)
            }

            var row: [String: Any] = [:]
            row["frequency"] = String(rule.frequency.rawValue)
            row["interval"] = rule.interval
            row["days_of_the_week"] = weekdays
            row["days_of_the_month"] = rule.daysOfTheMonth ?? []
            row["months_of_the_year"] = rule.monthsOfTheYear ?? []
            row["weeks_of_the_year"] = rule.weeksOfTheYear ?? []
            row["days_of_the_year"] = rule.daysOfTheYear ?? []
            row["set_positions"] = rule.setPositions ?? []
            row["end_date"] = rule.recurrenceEnd?.endDate.map(isoDate) ?? ""
            result.append(row)
        }
        return result
    }

    private static func isoDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    private static func writeJSON(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let output = String(data: data, encoding: .utf8) else {
            FileHandle.standardOutput.write(Data("{}\n".utf8))
            return
        }
        FileHandle.standardOutput.write(Data((output + "\n").utf8))
    }
}
