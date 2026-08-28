# Todoist Email Completion Worker

Small Cloudflare Worker used by Gmail AMP/dynamic email to complete Todoist tasks without opening another browser tab.

## What it does

- Accepts AMP for Email POST requests from `lydialament@gmail.com` only.
- Verifies a per-email action secret.
- Re-reads the Todoist task before completing it.
- Compares the task's current `due.date` with the occurrence embedded in the email, so an old email cannot accidentally complete a later recurrence.
- Calls Todoist's `/api/v1/tasks/{task_id}/close` endpoint.
- Returns the AMP-specific CORS headers Gmail requires.

## Deploy with Cloudflare Git integration

1. In Cloudflare, open **Workers & Pages**.
2. Choose **Create application**.
3. Under **Import a repository**, connect GitHub.
4. Select `4rt3m1sx/Test`.
5. The Worker name must be `todoist-email-complete` to match `wrangler.jsonc`.
6. Production branch: `master`.
7. Root directory: leave blank / repository root.
8. Build command: leave blank.
9. Deploy command: `npx wrangler deploy`.
10. Save and deploy.

Cloudflare should deploy the Worker to a URL similar to:

`https://todoist-email-complete.<your-subdomain>.workers.dev`

## Required secrets

After the Worker exists, go to **Settings → Variables and Secrets** and add both values as encrypted secrets:

- `TODOIST_TOKEN` — your Todoist personal API token.
- `EMAIL_ACTION_SECRET` — a long random value used in the AMP form.

Do not commit either secret to GitHub.

## Endpoints

### `GET /health`

Safe deployment check:

```json
{"ok":true,"service":"todoist-email-complete"}
```

### `POST /complete`

Used by the AMP email. Expected form fields:

- `task` — Todoist task ID.
- `due` — current Todoist `due.date`, or `none` for an undated task.
- `key` — value matching the `EMAIL_ACTION_SECRET` Worker secret.

The endpoint also requires Gmail AMP for Email CORS metadata identifying `lydialament@gmail.com` as the message sender.

## Security notes

- Todoist credentials exist only as Cloudflare Worker secrets.
- The API token is never placed in email HTML or this repository.
- A stale recurring-task occurrence is rejected rather than completing the task's newer occurrence.
- The `/complete` endpoint rejects ordinary browser requests that do not contain AMP for Email sender/origin metadata.

## Next step

Once Cloudflare has deployed the Worker, copy its `workers.dev` URL. That URL will be used in the AMP test email's `action-xhr` for each Todoist checkbox.
