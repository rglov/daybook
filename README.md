# Daybook

Daybook is a local desktop app for planning your day and keeping work and personal records together. It uses an Obsidian vault as its notes and project backend, and can bring in tasks, calendar events, reminders, and workout history from connected services.

## What it does

- **Today:** Review Apple Calendar events, tasks selected for the day, and scheduled time blocks in one plan.
- **Journal:** Add timestamped entries to the daily note under `# Log`. Entries can have tags and can be converted into Obsidian checkbox tasks.
- **Tasks:** Bring together Todoist, Obsidian, Apple Reminders, Wrike, and ServiceNow tasks. Filter by source and urgency, group tasks by project, and open supported items in their source app.
- **Projects:** Keep project notes in the configured Obsidian folder, link tasks and people, and review work by urgency.
- **Meetings:** Create Apple Calendar events with linked Obsidian meeting notes. Daybook can show event metadata, agenda, notes, action items, and starred notes.
- **People:** Keep person notes in Obsidian and see meetings, tasks, and projects linked to each person.
- **Protocols:** Build dated cycles and recurring bundles from Wellness notes, then track the expected items and adherence.
- **Workouts:** Review workout history and stats synced from Hevy.
- **Weight & body composition:** Import a Garmin Connect weight report CSV and add dated DEXA scan measurements with an optional attached report.

## Requirements

- Node.js and npm
- macOS for Apple Calendar and Apple Reminders integration
- macOS Command Line Tools for Daybook’s native Calendar bridge
- An Obsidian vault

Todoist, Wrike, ServiceNow, and Hevy are optional integrations. Hevy’s public API requires Hevy Pro.

## Run Daybook

From this project folder:

```sh
npm install
npm start
```

On first launch, open **Settings** and choose your Obsidian vault. Set the folders you want Daybook to use, then configure any integrations. To package the app as an installable desktop release, add a packaging tool and build scripts; this project currently runs from source with Electron.

## Configure integrations

- **Apple Calendar:** In Today, choose **Request Calendar Access** and approve Daybook in macOS Privacy & Security settings. Daybook reads calendar events and can create meetings in a writable calendar.
- **Apple Reminders:** Grant Daybook Reminders access when macOS prompts. Reminders support is available on macOS.
- **Todoist:** Add a personal API token in Settings. Existing Todoist filters can be mapped to the urgency groups.
- **Wrike:** Add a permanent access token and, if needed, the Wrike API host in Settings.
- **ServiceNow:** Add your instance host and user name, then choose API key, OAuth bearer token, or username and password. The user name is used to filter records assigned to you. API key authentication must be enabled in your ServiceNow instance; bearer tokens may expire.
- **Hevy:** Add your API key in Settings. Workout history is cached locally to make the dashboard faster and available between syncs.
- **Garmin Connect weight:** Export a weight report CSV from Garmin Connect, then use **Import Garmin CSV** on the Weight page. This is a manual import; Garmin’s official Health API is currently offered through its business developer program.
- **DEXA:** On the Weight page, add a scan date, enter measurements from your report, and optionally attach its PDF or image. Daybook creates a note under `Wellness/DEXA Scans` and copies the report to the configured attachments folder.

## Obsidian data

Daybook writes notes and task updates directly to the selected vault. Folder names are configurable in Settings; defaults include `Daily`, `PROJECTS`, `MEETINGS`, and `People`. Wellness items are read from the configured Wellness folder, which can contain category subfolders.

Daily journal entries are added under the daily note’s `# Log` heading with a `YYYYMMDDHHmmss` timestamp. Meeting notes and project notes are Markdown files in their configured folders. Tasks created in Obsidian are Markdown checkboxes; completing an Obsidian task updates its original note.

Daybook stores syncable app data in the vault’s `SYSTEM/DAYBOOK` folder: protocol bundles and cycles, fixed habit commitments, shared preferences (appearance, enabled modules, folder settings, routines, task filters, and workout plans), cached workout history, and imported weight readings. DEXA scan records are Markdown notes in the configured Wellness folder under `DEXA Scans`; attached report files go in the configured attachments folder. Habit commitments snapshot the selected habits and their frequencies for a one-month or three-month period so adherence stays comparable if the habit list later changes. Keep the vault in Obsidian Sync and choose that vault in Daybook on each device to sync this data. Daily notes, projects, meetings, people, protocol cycles, habits, and Obsidian tasks are stored in the vault. Existing files in the previous `Daybook` and hidden `.daybook` folders are copied into `SYSTEM/DAYBOOK` when the vault is opened; the original files are left in place as a backup. API keys, passwords, and device permissions remain in local app settings and are not synced.

## Credential storage

Integration secrets are not kept in a project `.env` file. Daybook encrypts API tokens and passwords with Electron `safeStorage` before saving them in its local app settings. If secure storage is unavailable, Daybook refuses to save credentials. The `.gitignore` excludes `.env` files as an additional safeguard; never commit real tokens, passwords, or private keys.

API keys, passwords, the local vault path, and macOS Calendar/Reminders permissions remain device-specific. Enter integration credentials in Settings on each device; they are not written into the synced vault.

On macOS, the app data folder is typically:

```text
~/Library/Application Support/Daybook/
```

## Project files

- `main.cjs` — Electron main process, local files, integrations, and native service bridges
- `preload.cjs` — restricted IPC API exposed to the renderer
- `index.html` — app page structure
- `renderer.js` — interface behavior and rendering
- `styles.css` — app styles
- `calendar-bridge.swift` — macOS EventKit bridge used for Calendar access
- `assets/` — app icons and other bundled assets

## Current limitations

Daybook is an early-stage personal desktop app. It currently runs from source and does not include signed installers or background sync across devices. Calendar and Reminders access depend on macOS permissions. ServiceNow OAuth token refresh is not automatic; replace an expired bearer token in Settings.
