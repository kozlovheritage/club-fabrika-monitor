# Independent club monitor

Runs outside ONREZA on GitHub Actions, triggered every five minutes by
cron-job.org. GitHub's own cron remains a best-effort fallback.
No payment, account creation, login as a
member, production app deployment or financial-setting write is performed.

## Checks

- HTTP process: `/api/health`, **not** DB readiness.
- Login page: HTML and expected password/login form.
- Anonymous cabinet: same-origin redirect to login.
- Separate TLS read-only PostgreSQL connection: bounded constant-only queries
  to the existing club tables and `SELECT 1`. This checks database connectivity,
  not the production process's own pool or the member login journey.

The live collector performs exactly **four** checks. ONREZA budget polling and
budget email warnings are disabled by the owner's explicit choice: invoice
notifications are handled by ONREZA itself. No billing API request or billing
token is needed. Historical five-check reports remain readable; billing helpers
are retained only for compatibility and isolated legacy policy tests.

No provider snapshot token, customer field, session cookie, PDF signed URL,
recipient or credential is retained in checkpoints or printed in logs.

## Alert policy

- An incident requires two failed scheduled runs; one failure is suppressed.
- Incidents in the same run are combined. Recovery is combined with pending
  notices. Normal email has a 30-minute cooldown; the first confirmed incident
   may bypass a recent notice. Persistent incidents remind at most
  every six hours.
- On the four-check cutover, unsent budget paragraphs, stale billing incidents,
  budget samples and threshold state are removed. Other incidents, the mail
  receipt and delivery deduplication state are retained; no false budget
  recovery notice is sent.
- Healthy runs do not send email, including after long scheduler gaps. Daily
  reports and gap-only notices are disabled by the owner's choice. Old queued
  routine paragraphs are removed, retaining any real incident or budget warning.
- Explicit `test_email: true` still sends a test when requested. Ordinary
  scheduled runs and manual runs with `test_email: false` do not.
- A stopped GitHub scheduler cannot warn through its own stopped job. Silence
  is not proof of health; inspect Actions or add an independent heartbeat watcher.

The external trigger targets UTC minutes 0, 5, 10, …, 55; the GitHub fallback is
offset from the hour. **GitHub can delay or drop scheduled jobs, and external
dispatch still depends on GitHub runner availability. There is no guaranteed
five-minute response time.** HTTP 204 means a dispatch was accepted, not that
checks ran or an alert reached its recipient.
Successful encrypted checkpoint commits also keep the public repository active
so GitHub's 60-day repository inactivity rule does not normally disable cron.
This is low-cost best-effort monitoring, not a high-availability SLA.

## Configuration

Repository Secrets:

| Secret | Purpose |
| --- | --- |
| `MONITOR_DATABASE_URL` | Existing production database connection; never a copied test database |
| `MONITOR_ONREZA_TOKEN` | Legacy, not consumed by the live collector |
| `MONITOR_NOTISEND_KEY` | Email transport |
| `MONITOR_FROM_EMAIL` | Authorized sender |
| `MONITOR_RECIPIENT` | Owner-approved notification address |
| `MONITOR_STATE_KEY` | 32 random bytes, base64, for AES-256-GCM state |
| `MONITOR_STATE_RECOVERY_KEY` | Protected copy of the current key; manual recovery only |

`GITHUB_TOKEN` is the job's short-lived automatic token. Limit permissions to
`contents: write`; no pull-request or fork execution. Only trusted repository
maintainers may change the workflow because a workflow can access its Secrets.

`state.enc` holds authenticated encrypted alert state and the pending email
outbox. **Do not delete it or rotate the state key alone.** Missing, corrupt or
undecryptable state stops the job instead of silently forgetting incidents.
Bootstrap is an explicit one-time administrative operation, not part of cron.
The old unreadable checkpoint was archived before the owner-approved fresh
baseline. Canonical encryption keys are held in GitHub Actions Secrets. Never
overwrite them from a local secret unless that candidate authenticates the
current checkpoint. The backup key is not an automatic runtime fallback.

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

### Private per-check diagnostics

The public-log policy is **unchanged**. Individual results are kept only in
`state.enc` under `diagnostic`, using the existing AES-256-GCM key. No new
public summary fields, Actions summary, uploaded report or plaintext file is
introduced. The report is a fixed-field projection, not a copy of provider
responses, exceptions, configuration, receipts or budget values.

Read it **only from a trusted local terminal**, with `GITHUB_TOKEN` (repository
contents read access) and `MONITOR_STATE_KEY` supplied through the protected
environment, never as command-line arguments:

Commands below are relative to the standalone monitor repository root.
In the Replit source workspace, first enter `scripts/src/club-monitoring`.

```sh
node scheduler.mjs private-report
```

The repository is fixed to this monitor. This command does not need cron-job.org,
dispatch, database, billing or mail credentials. It only reads and decrypts the
checkpoint; it does not dispatch, send mail, change the schedule or save state.
It refuses execution when `GITHUB_ACTIONS=true` or `CI` is enabled. Do not run
it in public CI, paste its output into public logs or upload it as an artifact.
It does not print plaintext state, pending notices, message IDs or raw errors.

The version-1 report contains:

- `checkedAt`: run timestamp in Unix milliseconds; this is the **last stored
  report**, not a live query and not evidence that the scheduler still runs.
- `jobStatus`: `running`, `completed`, `failed`; `failureCode` is `NONE` or a
  fixed operational code (state read/save, probe collection, alert policy,
  mail-status lookup, mail submission, confirmed mail delivery failure or
  internal failure). Raw exception messages, stacks and causes are discarded.
- `checks`: live `http`, `login`, `cabinet`, `database`; historical reports may
  also contain `billing`. Each check has
  boolean `ok`, `code` (`OK` or respectively `HTTP_FAILED`, `LOGIN_FAILED`,
  `CABINET_FAILED`, `DATABASE_FAILED`, `BILLING_FAILED`) and `phase`.
  Failure codes identify the check, **not** the provider's failure reason.
- `phase`: `healthy`, `transient_failure` (first consecutive failure),
  `incident` (at least two consecutive failures), `recovered` (first successful
  run after a confirmed incident). A single failed check followed by success
  returns to `healthy`, without an incident or recovery email.
- `checksPassed` / `checksTotal` and `health`: live `healthy` is **4/4**,
  `partial` is 1–3/4, `unhealthy` is 0/4. Historical reports may contain five
  checks. Partial health does not itself prove a confirmed incident.
- `incidentStatus`: `confirmed` if any check is in incident, else `suspected`
  if any has a first failure, else `recovered` if any just recovered, else `none`.
  Per-check phases preserve simultaneous recovery and a different ongoing fault.
- `mail`: `accepted` refers only to a submission in **this run**;
  `deliveryStatus` and `emailDeliveryOk` refer to the latest receipt, which may
  belong to an older email. `none` means there is no receipt, not that a new
  email was delivered. `queued`/`sent`/`accepted` do not prove delivery.
  Failed submission/status operations report `unavailable`, never delivery OK.

A completed job can have `health: partial` and/or unconfirmed mail. A failed
mail job can have all five checks healthy. Six-hour suppression of repeated
mail-job failures does not turn the receipt healthy. Existing confirmation,
cooldown and reminder rules are unchanged.

The report is saved with the existing checkpoint: once for a silent run,
before submission and again after acceptance for a sending run. A crash after
the pre-submission save leaves `running`; this does not prove email was or was
not accepted. If state cannot be read/saved, or probe collection/alert evaluation
fails before a report can be built, the job fails safely and the stored report
may remain older. Always compare `checkedAt` with the relevant Actions run.
Missing diagnostics in older checkpoints is an explicit unavailable result,
not five assumed successes. No state reset or key rotation is needed.

## Operations

- Run manually: Actions → Club independent monitor → Run workflow.
- Use `test_email` for a test email (bypasses cooldown deliberately).
- Failure: inspect the generic failed job; check Secrets privately and retry.
- Identify the failing check: read `private-report` locally after the separate
  monitor release. Do not infer the failing component from the public 4/5 count.
- Stop all checks: disable the cron-job.org job **and** the GitHub workflow.
  Disabling only cron-job.org leaves GitHub's fallback schedule running.
  No club data or financial setting is changed by stopping monitoring.
- Restore: retain `state.enc` and its key, restore monitor code, run manually.
- Local verification: `node --test *.test.mjs`.

### External trigger administration

The owner approved free cron-job.org and explicitly authorized the existing
multi-repository GitHub token for this connection after limited-token setup
failed. Its wider scope is a risk, not a requirement of this tool. Do not
expand permissions, use it for another service, or copy it into source/logs.
Repository checks, NotiSend credentials, the recipient and the AES state key
remain in GitHub Actions Secrets; only the dispatch credential is stored in
the private cron-job.org job settings. `saveResponses` is disabled.

Administrative commands from the repository root:

```sh
node scheduler.mjs inspect
node scheduler.mjs verify 2026-11-04T17:47:02Z
# Only when intentionally creating/updating the schedule or rotating its token:
node scheduler.mjs configure
```

These commands use `CRON_JOB_ORG_API_KEY` and `CLUB_MONITOR_DISPATCH_TOKEN`
from the process environment. Never put values in command-line arguments.
`configure` first checks for duplicates and tests GitHub dispatch permission
with `test_email: false`, then creates or updates only this monitor's job.
It verifies the saved settings without printing credentials.

`inspect` correlates cron history with unique `workflow_dispatch` runs on
`main`, actual check-step timestamps and whitelisted run-log summaries.
`verify` requires at least three consecutive five-minute slots, successfully
completed monitor runs, distinct run IDs, previously confirmed email delivery, check intervals
within 300 ± 60 seconds and check-start lag no more than three minutes.
These tolerances are acceptance checks for the observed sample, not an SLA.
A manual dispatch alone cannot satisfy this evidence. `confirmed` refers only
to regularity, not cabinet health. Failed probes still count as completed checks;
`allChecksHealthy` and the counters expose their failures separately. A green
workflow is not proof of five healthy probes or a newly delivered warning.

Replacing a Replit Secret does **not** rotate the credential already copied to
cron-job.org: explicitly run `configure` and confirm subsequent automatic runs.
Expiry/revocation stops new dispatches. Keep the encrypted state and its key.
Cron-job.org account notifications are disabled rather than routing warnings to
an unverified account email; independent heartbeat alerts are separate work.

No automated budget mutation exists. The owner must separately configure the
approved extra budget in ONREZA. The monitoring allowance follows billing reads,
not an assumed or merely approved amount.
