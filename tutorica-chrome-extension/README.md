# Borang QA Assistant (Chrome Extension)

Chrome extension for authorized educational QA runs on your own Google Forms.

## Features

- Popup settings for backend URL, count, delay, and jitter.
- Optional API key field (`X-API-Key`) when backend protection is enabled.
- Optional text randomization (`{{rand}}`, `{{i}}` tokens or auto mode).
- In-page quick actions: randomize page, import CSV, clear CSV.
- Confirmation dialog before each run.
- In-page status pill and job progress/result messages.
- Popup diagnostics for latest job id/status/error and backend connection test.
- Reliability improvements for Google Forms SPA behavior (form rebinding, Enter key submit interception, monitor retries).
- Sends jobs to local backend: `POST /api/qa/submit`.
- Optional compatibility mode uses legacy endpoints: `/api/forms` and `/api/forms/submit`.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`borang-chrome-extension`).

## Usage

1. Run backend locally (`http://localhost:5000`).
2. Open a Google Form (`docs.google.com/forms`).
3. Open extension popup and save your settings.
4. Click submit in the form and confirm the QA run.

CSV format note:

- First row is headers (use Google field names like `entry.123456`).
- Each next row is one answer profile.

## Limit location (commented)

The max value comments are here:

- `content/content.js`
- `popup/popup.js`

## License

MIT
