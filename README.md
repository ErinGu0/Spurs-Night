# spurs-calendar-sync

Keeps a Squarespace site's event calendar in sync with Eventbrite, with no manual
copying and no monthly plan upgrade.

Built for [Spurs Night](https://www.eventbrite.ca/o/spurs-1651156147793), a queer
line dancing night in Toronto.

```
Google Calendar  (organiser types the month's dates)  ─┐
                                                        ├─→ Lambda ─→ S3 ─┬─ spurs.ics
Eventbrite API   (tickets + purchase links)            ─┘                 └─ calendar.html
                                                                                   │
                                                              Squarespace <iframe> ─┘
```

An EventBridge rule fires the Lambda hourly. It reads both sources, merges them by
calendar date, and writes two files to S3: a subscribable `.ics` feed and a rendered
month-grid `calendar.html` that the site embeds.

## The problem

Squarespace cannot import an external calendar. Its Events pages accept manual entry
only — no iCal subscription, and its public API covers commerce, not events. So the
site can't be fed directly; the calendar has to be rendered externally and embedded.

Meanwhile Eventbrite publishes each night's tickets about a week ahead, so relying on
Eventbrite alone means the site can only ever show one upcoming date. The organisers
decide the month's dates well before tickets go on sale.

Hence two sources: Google Calendar carries dates that are known but not yet on sale,
Eventbrite carries the ones that are.

## Design decisions

**Polling, not webhooks.** Eventbrite supports webhooks, and they'd be lower latency.
But webhooks fail silently — a dropped delivery leaves the site permanently stale with
nothing to trigger a correction. An hourly poll reconciles full state every run, so a
failure self-heals on the next tick. At this volume the cost difference is under a cent
a year.

**No database.** Each run rebuilds both output files from scratch. That removes the
whole class of problems a mapping table exists to solve: no "have I seen this event",
no orphaned records, no cleanup pass when an event is cancelled — a cancelled event is
simply absent from the next write.

**Merge by date, replace wholesale.** When Eventbrite has an event on a date the
organiser already entered by hand, the Eventbrite version wins outright rather than
being field-merged. One event per night makes the date a reliable key, and wholesale
replacement avoids guessing which fields a human edited. The manual entry's description
is carried across so notes aren't lost when tickets drop. A mismatched date surfaces as
two visible entries — a loud failure rather than a silent one.

**API key, not a service account.** The Lambda only reads the Google Calendar, so it
needs no write credential. A restricted API key against a public calendar avoids
service-account keys entirely (blocked by org policy on many Google Cloud accounts) and
sidesteps OAuth refresh tokens, which expire after 7 days unless the consent screen is
published.

**Zero npm dependencies.** `fetch`, `Intl` and the AWS SDK are all in the Lambda Node
runtime, so the function deploys by pasting one file into the console — no bundler, no
zip, no layer.

**Writes are all-or-nothing.** Both sources are fetched before anything is written. If
either fails the function throws and the previous files stay live, so an upstream outage
shows slightly stale dates instead of an empty calendar.

## Configuration

Environment variables:

| Variable | Example |
|---|---|
| `CALENDAR_ID` | `…@group.calendar.google.com` |
| `S3_BUCKET` | `spurs-night-calendar` |
| `EB_ORG_ID` | Eventbrite organisation id |
| `S3_KEY` | `spurs.ics` (default) |
| `HTML_KEY` | `calendar.html` (default) |
| `TIMEZONE` | `America/Toronto` (default) |

Secrets live in SSM Parameter Store as SecureStrings (free, unlike Secrets Manager at
$0.40/secret/month):

- `/spurs/eventbrite-token` — Eventbrite private token
- `/spurs/google-api-key` — Google API key, restricted to the Calendar API

IAM and bucket policies are in `iam/`. Substitute `REGION`, `ACCOUNT_ID` and
`BUCKET_NAME`.

## Deploying

1. S3 bucket with public read on its objects (`iam/bucket-policy.json`)
2. Two SecureString parameters in Parameter Store
3. Lambda, Node.js 24, arm64, 256 MB, 30s timeout — paste `index.mjs`
4. Attach `iam/lambda-execution-policy.json` to the execution role
5. EventBridge trigger, `rate(1 hour)`
6. Embed in Squarespace:

```html
<div style="width:100%;height:660px;">
  <iframe src="https://BUCKET.s3.REGION.amazonaws.com/calendar.html"
          style="width:100%;height:100%;border:0"></iframe>
</div>
```

## Runbook

The Google Calendar's public sharing must be **"See all event details"**. On
"free/busy" the API returns times but strips titles, locations and descriptions, and
every event silently falls back to a default name.

The Eventbrite token is a personal credential scoped to whoever generated it. If that
person leaves the organisation, the sync stops returning events.

Force a refresh without waiting for the hour by invoking the Lambda manually. Output
files carry `Cache-Control: max-age=300`, so allow five minutes for browsers to catch up.
