# Daily Assistant AMP Worker

Cloudflare Worker used by the Daily GTD Assistant to deliver Gmail AMP/dynamic emails with interactive Todoist completion.

## Production Worker

Worker name: `daily-assistant`

Production URL:

`https://daily-assistant.lmludick.workers.dev`

## What it does

- Polls the dedicated Daily Assistant Gmail staging mailbox.
- Converts the staged Daily Assistant payload into a polished multipart AMP email.
- Sends the user-facing brief from `lydialament@gmail.com` to `lmludick@gmail.com`.
- Renders each verified Todoist action as an in-email checkbox.
- Uses a per-task HMAC signature rather than exposing the long-lived action secret in the email.
- Re-reads the Todoist task before completion.
- Compares the task's current `due.date` with the occurrence embedded in the email so an old recurring-task email cannot complete a newer occurrence.
- Completes the Todoist task through the Todoist API without opening a browser tab.
- Returns the AMP-specific CORS headers Gmail requires.

## Cloudflare Git deployment

The Cloudflare Worker name and the `name` value in `wrangler.jsonc` must both be `daily-assistant`.

Production branch: `master`

Root directory: repository root

Deploy command: `npx wrangler deploy`

A cron trigger runs the staging mailbox processor every two minutes.

## Required encrypted secrets

Configure these only in Cloudflare Worker Settings → Variables and Secrets:

- `TODOIST_TOKEN`
- `EMAIL_ACTION_SECRET`
- `GMAIL_APP_PASSWORD`

Do not commit any of these values to GitHub.

## Endpoints

### `GET /health`

Deployment and service check.

### `POST /complete`

Used by Gmail AMP forms to complete a signed Todoist task occurrence.

Expected form fields:

- `task` — exact Todoist task ID
- `due` — current Todoist `due.date`, or `none`
- `sig` — Worker-generated HMAC signature for that task occurrence

The endpoint also requires Gmail AMP for Email CORS metadata identifying `lydialament@gmail.com` as the message sender.

### `GET /process-staged`

Manually runs the staging-mailbox processor. Normal production delivery is handled by the scheduled Worker trigger.

## Security

- Todoist and Gmail credentials exist only as encrypted Cloudflare Worker secrets.
- The Todoist API token is never placed in an email or committed to the repository.
- The long-lived action secret is not embedded in the delivered email; the Worker creates a per-task HMAC signature instead.
- A stale recurring-task occurrence is rejected rather than completing a newer occurrence.
- `/complete` rejects ordinary browser requests that lack Gmail AMP sender/origin metadata.
