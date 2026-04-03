# TerraLift GHL Automation

## Architecture

Two components work together:

1. **Drip Engine** (`ghl-drip-engine.js`) — Cron-based processor that runs every 30 min, handles:
   - Cold lead SMS drip (Day 1 → 3 → 7 → 14)
   - Outbound skip-trace campaign intros
   - Inbound lead auto-response (batch)
   - Conversion tracking (reply detection → pipeline advancement)

2. **Webhook Handler** (`ghl-webhook-handler.js`) — HTTP server for real-time events:
   - Speed-to-lead: auto-responds to new contacts within 60 seconds
   - Conversion tracking on inbound replies
   - Pipeline opportunity creation

## Setup

### Environment

```bash
export GHL_API_KEY="pit-42cafc8f-4b7b-42a1-8757-1c41cb9881fc"
export GHL_LOCATION_ID="KHkKxLvRrDipSbeMzKup"
```

### Run Drip Engine (cron)

```bash
# Every 30 minutes
*/30 * * * * GHL_API_KEY=pit-xxx GHL_LOCATION_ID=KHkKxLvRrDipSbeMzKup node /home/paperclip/Terralift-web/automation/ghl-drip-engine.js >> /var/log/terralift-drip.log 2>&1
```

### Run Webhook Handler (systemd/pm2)

```bash
GHL_API_KEY=pit-xxx node automation/ghl-webhook-handler.js
# Listens on port 3500
```

### Nginx config (VPS 137.184.69.127)

```nginx
location /webhooks/ghl {
    proxy_pass http://127.0.0.1:3500;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## Tag System

| Tag | Purpose |
|-----|---------|
| `drip-cold-lead` | Contact enrolled in cold drip sequence |
| `drip-day-1` through `drip-day-14` | Tracks drip progress |
| `drip-completed` | All 4 drip messages sent |
| `auto-responded` | Speed-to-lead SMS sent |
| `inbound-lead` | Came in via form/website |
| `skip-trace-outbound` | From skip-traced landowner list |
| `conversion-tracked` | Contact replied to outreach |
| `responded` | Contact engaged |

## GHL Workflows (UI Configuration Required)

The GHL Workflow API is read-only — workflows must be configured in the GHL UI.

### Workflow 1: New Lead Intake (exists as draft)
- **Trigger:** Contact Created + tagged `inbound-lead`
- **Actions:** Tag contact → Auto-respond SMS → Create opportunity → Wait 1hr → If no response → Add to drip

### Workflow 2: Cold Lead Drip
- **Trigger:** Tag added `drip-cold-lead`
- **Actions:** Handled by drip engine script (external)

### Workflow 3: Inbound Reply Handler
- **Trigger:** Customer Replied (SMS)
- **Actions:** Remove from drip → Tag `responded` → Move to Contacted stage → Internal notification

### A2P 10DLC
- Must be registered before sending bulk SMS
- Register at: GHL Settings → Phone Numbers → Messaging Compliance
- Business name: Terra Lift
- Use case: Real estate lead generation / property acquisition outreach

## Pipeline: Marketing Pipeline

| Stage | ID | Purpose |
|-------|----|---------|
| New Lead | f9e8c5a3-... | Just entered system |
| Contacted | 005eff38-... | First message sent |
| Qualified | b55b361c-... | Responded + has sellable property |
| Proposal Sent | e876fa7a-... | Offer sent |
| Negotiation | 5926b611-... | Counter/discussion |
| Closed | 71c6bfc9-... | Deal done |
