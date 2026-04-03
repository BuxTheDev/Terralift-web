#!/usr/bin/env node
/**
 * TerraLift GHL Drip & SMS Automation Engine
 *
 * Runs as a cron job to process contacts through drip sequences.
 * Handles: cold lead re-engagement, inbound auto-response, outbound campaigns.
 *
 * Usage:
 *   node ghl-drip-engine.js                 # Run all sequences
 *   node ghl-drip-engine.js --drip-only     # Only cold lead drip
 *   node ghl-drip-engine.js --autorespond   # Only inbound auto-respond
 *   node ghl-drip-engine.js --dry-run       # Preview without sending
 *
 * Env vars:
 *   GHL_API_KEY       - GoHighLevel API key (required)
 *   GHL_LOCATION_ID   - GHL location ID (required)
 *   DRY_RUN           - Set to "true" to preview without sending
 */

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'KHkKxLvRrDipSbeMzKup';
const BASE_URL = 'https://services.leadconnectorhq.com';
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const DRIP_ONLY = process.argv.includes('--drip-only');
const AUTORESPOND_ONLY = process.argv.includes('--autorespond');

if (!GHL_API_KEY) {
  console.error('Error: GHL_API_KEY environment variable required');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

// --- SMS Templates ---

const DRIP_TEMPLATES = {
  day1: {
    tag: 'drip-day-1',
    message: (name) =>
      `Hi ${name}, this is Bryan from TerraLift. I noticed you own land that might be a great fit for our buyers. Would you consider a cash offer? No fees, no hassle. Reply YES if interested or STOP to opt out.`
  },
  day3: {
    tag: 'drip-day-3',
    message: (name) =>
      `Hey ${name}, just following up — we have active buyers looking for land in your area right now. We can close in as little as 7 days with cash. Want me to send you a no-obligation offer? Reply YES or STOP to opt out.`
  },
  day7: {
    tag: 'drip-day-7',
    message: (name) =>
      `${name}, quick update — land values in your area have been moving. If you've thought about selling, now is a great time. We handle everything — title, closing, all of it. Interested? Reply YES or STOP.`
  },
  day14: {
    tag: 'drip-day-14',
    message: (name) =>
      `Hi ${name}, this is my last follow-up. We're still interested in your property if you'd like a free, no-obligation cash offer. Just reply YES anytime and we'll get back to you right away. — Bryan, TerraLift`
  }
};

const INBOUND_AUTO_RESPONSE =
  `Thanks for reaching out to TerraLift! We received your info and a team member will contact you within the hour. If you have a property to sell, we buy land for cash and can close fast. — TerraLift Team`;

const OUTBOUND_INTRO = (name) =>
  `Hi ${name}, this is Bryan from TerraLift. We buy vacant land for cash and noticed you may own a property we're interested in. Would you be open to hearing a no-obligation offer? Reply YES or STOP to opt out.`;

// --- API Helpers ---

async function ghlFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API ${res.status}: ${text}`);
  }
  return res.json();
}

async function searchContacts(query) {
  return ghlFetch(`/contacts/?locationId=${GHL_LOCATION_ID}&${query}`);
}

async function getContactsByTag(tag, limit = 100) {
  // GHL search by tag via query param
  return ghlFetch(`/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(tag)}&limit=${limit}`);
}

async function addTags(contactId, tags) {
  return ghlFetch(`/contacts/${contactId}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags })
  });
}

async function removeTags(contactId, tags) {
  return ghlFetch(`/contacts/${contactId}/tags`, {
    method: 'DELETE',
    body: JSON.stringify({ tags })
  });
}

async function sendSMS(contactId, message) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would send SMS to ${contactId}: ${message.substring(0, 60)}...`);
    return { success: true, dryRun: true };
  }
  return ghlFetch('/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({
      type: 'SMS',
      contactId,
      message
    })
  });
}

async function sendEmail(contactId, subject, body) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would send email to ${contactId}: ${subject}`);
    return { success: true, dryRun: true };
  }
  return ghlFetch('/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({
      type: 'Email',
      contactId,
      subject,
      message: body
    })
  });
}

async function addNote(contactId, body) {
  return ghlFetch(`/contacts/${contactId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body })
  });
}

async function createOpportunity(contactId, pipelineId, stageId, name, monetaryValue) {
  return ghlFetch(`/opportunities/`, {
    method: 'POST',
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      pipelineId,
      pipelineStageId: stageId,
      contactId,
      name,
      monetaryValue,
      status: 'open'
    })
  });
}

// --- Drip Sequence Logic ---

async function runColdLeadDrip() {
  console.log('\n=== Cold Lead Drip Sequence ===');

  // Get all contacts tagged for drip
  const { contacts = [] } = await searchContacts('limit=100');

  let processed = 0;
  for (const contact of contacts) {
    const tags = (contact.tags || []).map(t => t.toLowerCase());
    const name = contact.firstNameRaw || contact.firstName || 'there';
    const phone = contact.phone;

    // Skip if no phone, already completed drip, or is a buyer
    if (!phone) continue;
    if (tags.includes('drip-completed')) continue;
    if (tags.includes('terralift-buyer')) continue;
    if (tags.includes('responded')) continue;

    // Must be tagged for cold outreach
    if (!tags.includes('drip-cold-lead') && !tags.includes('skip-trace-outbound')) continue;

    // Determine which drip step to send
    if (!tags.includes('drip-day-1')) {
      console.log(`  Day 1 SMS → ${contact.contactName || contact.id} (${phone})`);
      await sendSMS(contact.id, DRIP_TEMPLATES.day1.message(name));
      await addTags(contact.id, ['drip-day-1']);
      processed++;
    } else if (!tags.includes('drip-day-3')) {
      // Check if day-1 was sent at least 2 days ago (use dateUpdated as proxy)
      const daysSinceUpdate = daysSince(contact.dateUpdated);
      if (daysSinceUpdate >= 2) {
        console.log(`  Day 3 SMS → ${contact.contactName || contact.id} (${phone})`);
        await sendSMS(contact.id, DRIP_TEMPLATES.day3.message(name));
        await addTags(contact.id, ['drip-day-3']);
        processed++;
      }
    } else if (!tags.includes('drip-day-7')) {
      const daysSinceUpdate = daysSince(contact.dateUpdated);
      if (daysSinceUpdate >= 4) {
        console.log(`  Day 7 SMS → ${contact.contactName || contact.id} (${phone})`);
        await sendSMS(contact.id, DRIP_TEMPLATES.day7.message(name));
        await addTags(contact.id, ['drip-day-7']);
        processed++;
      }
    } else if (!tags.includes('drip-day-14')) {
      const daysSinceUpdate = daysSince(contact.dateUpdated);
      if (daysSinceUpdate >= 7) {
        console.log(`  Day 14 SMS → ${contact.contactName || contact.id} (${phone})`);
        await sendSMS(contact.id, DRIP_TEMPLATES.day14.message(name));
        await addTags(contact.id, ['drip-day-14', 'drip-completed']);
        processed++;
      }
    }

    // Rate limit: ~1 msg/sec to stay safe with A2P
    if (!DRY_RUN && processed > 0) await sleep(1200);
  }

  console.log(`  Drip processed: ${processed} messages sent`);
  return processed;
}

// --- Inbound Auto-Responder ---

async function runInboundAutoResponder() {
  console.log('\n=== Inbound Auto-Responder ===');

  // Find contacts tagged inbound-lead but NOT auto-responded
  const { contacts = [] } = await searchContacts('limit=100');

  let responded = 0;
  for (const contact of contacts) {
    const tags = (contact.tags || []).map(t => t.toLowerCase());

    if (!tags.includes('inbound-lead')) continue;
    if (tags.includes('auto-responded')) continue;
    if (!contact.phone) continue;

    // Check if contact was added recently (within last 2 hours for speed-to-lead)
    const minutesSinceAdded = minutesSince(contact.dateAdded);
    if (minutesSinceAdded > 120) {
      // Too old for auto-response, just tag it
      await addTags(contact.id, ['auto-responded']);
      continue;
    }

    console.log(`  Auto-respond → ${contact.contactName || contact.id} (${contact.phone})`);
    await sendSMS(contact.id, INBOUND_AUTO_RESPONSE);
    await addTags(contact.id, ['auto-responded']);

    // Create opportunity in pipeline
    try {
      await createOpportunity(
        contact.id,
        'Dggu0FKblYAunQy3tEUs', // Marketing Pipeline
        'f9e8c5a3-bc3f-49cc-8c85-6cbecbead64e', // New Lead stage
        `Inbound — ${contact.contactName || 'Unknown'}`,
        0
      );
      console.log(`    → Created pipeline opportunity`);
    } catch (e) {
      console.log(`    → Pipeline opportunity failed: ${e.message}`);
    }

    await addNote(contact.id, `[Auto] Inbound lead auto-responded via SMS at ${new Date().toISOString()}`);
    responded++;

    if (!DRY_RUN) await sleep(1200);
  }

  console.log(`  Auto-responded: ${responded} contacts`);
  return responded;
}

// --- Outbound Campaign Processor ---

async function runOutboundCampaign() {
  console.log('\n=== Outbound Skip-Trace Campaign ===');

  const { contacts = [] } = await searchContacts('limit=100');

  let sent = 0;
  for (const contact of contacts) {
    const tags = (contact.tags || []).map(t => t.toLowerCase());

    if (!tags.includes('skip-trace-outbound')) continue;
    if (tags.includes('drip-cold-lead')) continue; // Already in drip
    if (tags.includes('drip-day-1')) continue; // Already contacted
    if (!contact.phone) continue;

    const name = contact.firstNameRaw || contact.firstName || 'there';

    console.log(`  Outbound intro → ${contact.contactName || contact.id} (${contact.phone})`);
    await sendSMS(contact.id, OUTBOUND_INTRO(name));
    await addTags(contact.id, ['drip-cold-lead', 'drip-day-1']);

    // Create pipeline opportunity
    try {
      await createOpportunity(
        contact.id,
        'Dggu0FKblYAunQy3tEUs',
        'f9e8c5a3-bc3f-49cc-8c85-6cbecbead64e',
        `Outbound — ${contact.contactName || 'Unknown'}`,
        0
      );
    } catch (e) { /* may already exist */ }

    await addNote(contact.id, `[Auto] Outbound campaign intro sent at ${new Date().toISOString()}`);
    sent++;

    if (!DRY_RUN) await sleep(1200);
  }

  console.log(`  Outbound sent: ${sent} messages`);
  return sent;
}

// --- Conversion Tracking ---

async function runConversionTracking() {
  console.log('\n=== Conversion Tracking ===');

  // Find contacts that replied (have conversations) but aren't tracked
  const { contacts = [] } = await searchContacts('limit=100');

  let tracked = 0;
  for (const contact of contacts) {
    const tags = (contact.tags || []).map(t => t.toLowerCase());

    // Skip already tracked or buyers
    if (tags.includes('conversion-tracked')) continue;
    if (tags.includes('terralift-buyer')) continue;

    // Check if contact has any drip tags (was in a sequence)
    const inDrip = tags.some(t => t.startsWith('drip-'));
    if (!inDrip) continue;

    // Check for conversations (replies)
    try {
      const convResult = await ghlFetch(
        `/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${contact.id}&limit=1`
      );
      const convos = convResult.conversations || [];
      if (convos.length > 0) {
        const lastMsg = convos[0];
        // If there's an inbound message, track as conversion
        if (lastMsg.lastMessageType === 'TYPE_CALL' || lastMsg.unreadCount > 0) {
          console.log(`  Conversion tracked: ${contact.contactName || contact.id}`);
          await addTags(contact.id, ['conversion-tracked', 'responded']);
          await addNote(contact.id, `[Auto] Conversion tracked — contact responded to drip campaign at ${new Date().toISOString()}`);

          // Move to Contacted stage in pipeline
          try {
            const opps = await ghlFetch(
              `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contact.id}`
            );
            for (const opp of (opps.opportunities || [])) {
              if (opp.pipelineId === 'Dggu0FKblYAunQy3tEUs') {
                await ghlFetch(`/opportunities/${opp.id}`, {
                  method: 'PUT',
                  body: JSON.stringify({
                    pipelineStageId: '005eff38-28b3-4bf9-b987-fdec9b87a75a' // Contacted
                  })
                });
              }
            }
          } catch (e) { /* best effort */ }

          tracked++;
        }
      }
    } catch (e) {
      // Skip if conversation search fails
    }
  }

  console.log(`  Conversions tracked: ${tracked}`);
  return tracked;
}

// --- Utilities ---

function daysSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

function minutesSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main ---

async function main() {
  console.log(`TerraLift GHL Drip Engine — ${new Date().toISOString()}`);
  console.log(`Location: ${GHL_LOCATION_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const results = {};

  try {
    if (!AUTORESPOND_ONLY) {
      results.drip = await runColdLeadDrip();
      results.outbound = await runOutboundCampaign();
    }

    if (!DRIP_ONLY) {
      results.autorespond = await runInboundAutoResponder();
    }

    results.conversions = await runConversionTracking();

    console.log('\n=== Summary ===');
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('Engine error:', error.message);
    process.exit(1);
  }
}

main();
