# Handoff: ClerkBid to Killian (2026-11-21)

Killian (Slack `U04T8JF0G0P`, GitHub `killian-AM`, killian@auctionmethod.com) owns ClerkBid from today. Daniel stays a backup and can still give the routine instructions. This note holds no secrets; never add any.

## Fix first: production is not what's on `main`

On 2026-11-21, production (Vercel project `clerkpad`) was serving commit `d0c7378` from branch `claude/nice-wozniak-tbpdlb` ("Admin: remove the 25-user cap on bulk delete"). That commit is not on `main`, and `main` has changes production may lack (for example #95, "Add Killian as a super admin"). The next merge to `main` deploys `main` and would drop the bulk-delete change. Decide with Daniel whether that change should land on `main` through a normal pull request, or be dropped.

## What you own

- **Repo:** `AuctionMethod-Inc/clerkbid` (public). **Vercel project:** `clerkpad`, served at `clerkbid.com` / `www.clerkbid.com`. Merging to `main` deploys to production.
- **Approvals happen in Slack**, in the PR's thread in #clerkbid-feedback-loop. Only you, or a backup (Daniel, Dennis, Nate), can approve a change for production. The `slack-approval` check enforces this once the "slack-approvers" pull request merges. Deploys wait for the 11:30 pm to 6:00 am Eastern window unless an approver says "approve now".
- New sign-ups are now assigned to you in HubSpot (`HUBSPOT_CONTACT_OWNER_EMAIL`, set 2026-11-21).

## Routines to move to your Claude account

These run on Daniel's account today. Recreate each under yours with the same prompt, then Daniel turns his off:

- **ClerkBid feedback routine** (hourly): "Read .claude/feedback-loop/ROUTINE.md and CLAUDE.md in the checkout and do one run as described."
- **Dependabot routine for clerkbid** (Mondays): "Read .claude/feedback-loop/DEPENDABOT.md and CLAUDE.md in the checkout and do one run as described."

Both need this repo, the Slack connector and the Slack nudge-bot network secret in their environment. Once the routine runs as you, update `.claude/feedback-loop/ROUTINE.md`: its posts will show as yours, not Daniel's.

## Accounts to get from Daniel

Neon (project `small-brook-45993452`), Resend, Ably, HubSpot (the private app token), Sentry, the Slack nudge bot, and **Name.com for `clerkbid.com`**, so the domain renews under an account you can reach.

## Reminders

- Migrations are hand-run SQL in Neon before the code that needs them merges (`db/*.sql`).
- Other app owners can propose changes here as `cross-app-request` pull requests; only you or a backup approve them for production. See "App ownership and cross-app changes" in `CLAUDE.md`.
