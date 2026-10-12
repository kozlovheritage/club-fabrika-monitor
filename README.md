# Independent club monitor

Runs outside ONREZA on GitHub Actions. No payment, account creation, login as a
member, production app deployment or financial-setting write is performed.

## Checks

- HTTP process: `/api/health`, **not** DB readiness.
- Login page: HTML and expected password/login form.
- Anonymous cabinet: same-origin redirect to login.
- Separate TLS read-only PostgreSQL connection: bounded constant-only queries
  to the existing club tables and `SELECT 1`. This checks database connectivity,
  not the production process's own pool or the member login journey.
- ONREZA workspace-wide resource usage: current period, fresh billing snapshot,
  included credit plus **effective** extra allowance; not only this project.

No provider snapshot token, customer field, session cookie, PDF signed URL,
recipient or credential is retained in checkpoints or printed in logs.

## Alert policy

- An incident requires two failed scheduled runs; one failure is suppressed.
- Incidents in the same run are combined. Recovery is combined with pending
  notices. Normal email has a 30-minute cooldown; the first confirmed incident
   may bypass a recent notice. Persistent incidents remind at most
  every six hours.
- Budget milestones: 70%, 85%, 95%, 100% of actual current included + effective
  extra budget. A jump over several milestones sends one notice.
- Provider forecast and a bounded seven-day history of hourly samples provide
  approximate end-of-period risk detection. Local velocity requires 24 hours
  of history. Period reset clears the old trend and threshold state.
- Healthy runs do not send email, including after long scheduler gaps. Daily
  reports and gap-only notices are disabled by the owner's choice. Old queued
  routine paragraphs are removed, retaining any real incident or budget warning.
- Explicit `test_email: true` still sends a test when requested. Ordinary
  scheduled runs and manual runs with `test_email: false` do not.
- A stopped GitHub scheduler cannot warn through its own stopped job. Silence
  is not proof of health; inspect Actions or add an independent heartbeat watcher.

The cron targets five-minute intervals, offset from the hour. **GitHub can delay
or drop scheduled jobs; there is no guaranteed five-minute response time.**
Successful encrypted checkpoint commits also keep the public repository active
so GitHub's 60-day repository inactivity rule does not normally disable cron.
This is low-cost best-effort monitoring, not a high-availability SLA.

## Configuration

Repository Secrets:

| Secret | Purpose |
| --- | --- |
| `MONITOR_DATABASE_URL` | Existing production database connection; never a copied test database |
| `MONITOR_ONREZA_TOKEN` | Existing token authorized for billing reads |
| `MONITOR_NOTISEND_KEY` | Email transport |
| `MONITOR_FROM_EMAIL` | Authorized sender |
| `MONITOR_RECIPIENT` | Owner-approved notification address |
| `MONITOR_STATE_KEY` | 32 random bytes, base64, for AES-256-GCM state |

`GITHUB_TOKEN` is the job's short-lived automatic token. Limit permissions to
`contents: write`; no pull-request or fork execution. Only trusted repository
maintainers may change the workflow because a workflow can access its Secrets.

`state.enc` holds authenticated encrypted alert state and the pending email
outbox. **Do not delete it or rotate the state key alone.** Missing, corrupt or
undecryptable state stops the job instead of silently forgetting incidents.
Bootstrap is an explicit one-time administrative operation, not part of cron.

The outbox is saved before provider submission and acknowledged after the
provider accepts the message. Provider failure keeps pending notices for retry.
Delivery is **at least once**: if the provider accepts and the acknowledgement
save fails, a later retry can duplicate the email. `queued` acceptance is not
proof of inbox delivery. Raw provider errors are never printed.

The most recent receipt is checked on subsequent runs. A bounce, skip, status
API failure or an unconfirmed queued/sent message older than an hour makes the
job fail visibly (first occurrence and at most once per six hours) while availability/budget checks and pending notices continue
to be saved. New automatic mail is held until the previous receipt is delivered,
to avoid repeated rejections or hiding an old queued receipt behind a newer one.
Fix the sender and use `test_email` for a deliberate delivery test.
GitHub failed-workflow notifications must be enabled separately by the owner;
they are a secondary diagnostic, not proof that alert mail reaches the inbox.
Intervening runs retain an explicit warning and `emailDeliveryOk: false`; a green
job during an already-signalled incident is not proof of email delivery. One
transient status-API failure is tolerated; two consecutive failures open an incident.

Public repository logs contain only number of passing checks and mail
acceptance, never spending amounts or mail addresses. State commits contain
only ciphertext. Do not upload plaintext state or command-output artifacts.

## Operations

- Run manually: Actions → Club independent monitor → Run workflow.
- Use `test_email` for a test email (bypasses cooldown deliberately).
- Failure: inspect the generic failed job; check Secrets privately and retry.
- Stop: disable the scheduled workflow. No club data or financial setting is
  changed by stopping it.
- Restore: retain `state.enc` and its key, restore monitor code, run manually.
- Local verification: `node --test *.test.mjs`.

No automated budget mutation exists. The owner must separately configure the
approved extra budget in ONREZA. The monitoring allowance follows billing reads,
not an assumed or merely approved amount.
