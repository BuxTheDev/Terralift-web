#!/usr/bin/env node
/**
 * TerraLift GHL Webhook Handler
 *
 * Lightweight HTTP server that receives GHL webhook events and triggers
 * speed-to-lead auto-response (<60 seconds).
 *
 * Webhook events handled:
 *   - ContactCreate: New inbound lead → instant SMS auto-response
 *   - FormSubmission: Form fill → tag + auto-respond + create opportunity
 *   - InboundMessage: Reply from lead → track conversion + advance pipeline
 *
 * Usage:
 *   GHL_API_KEY=pit-xxx node ghl-webhook-handler.js
 *
 * Deploy:
 *   Run on the VPS (137.184.69.127) behind nginx, expose as:
 *   https://terraliftoffers.com/webhooks/ghl
 */

const http = require('http');

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'KHkKxLvRrDipSbeMzKup';
const PORT = process.env.WEBHOOK_PORT || 3500;
const BASE_URL = 'https://services.leadconnectorhq.com';

if (!GHL_API_KEY) {
  console.error('Error: GHL_API_KEY required');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

// --- Speed-to-Lead Auto-Response ---

const SPEED_RESPONSE = `Thanks for reaching out to TerraLift! We got your info and someone will be in touch within the hour. We buy land for cash — fast close, no hassle. — TerraLift Team`;

async function ghlFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL ${res.status}: ${text}`);
  }
  return res.json();
}

async function handleContactCreate(data) {
  const contactId = data.id || data.contact_id || data.contactId;
  if (!contactId) return { status: 'skipped', reason: 'no contactId' };

  // Get full contact
  const contact = await ghlFetch(`/contacts/${contactId}`);
  const c = contact.contact || contact;
  const tags = (c.tags || []).map(t => t.toLowerCase());

  // Skip buyers
  if (tags.includes('terralift-buyer') || tags.includes('builder')) {
    return { status: 'skipped', reason: 'is buyer/builder' };
  }

  // Skip if no phone
  if (!c.phone) {
    return { status: 'skipped', reason: 'no phone' };
  }

  // Tag as inbound lead
  await ghlFetch(`/contacts/${contactId}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags: ['inbound-lead', 'auto-responded'] })
  });

  // Speed-to-lead: send SMS immediately
  await ghlFetch('/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({
      type: 'SMS',
      contactId,
      message: SPEED_RESPONSE
    })
  });

  // Create pipeline opportunity
  try {
    await ghlFetch('/opportunities/', {
      method: 'POST',
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        pipelineId: 'Dggu0FKblYAunQy3tEUs',
        pipelineStageId: 'f9e8c5a3-bc3f-49cc-8c85-6cbecbead64e',
        contactId,
        name: `Inbound — ${c.contactName || c.firstName || 'Unknown'}`,
        status: 'open'
      })
    });
  } catch (e) { /* may already exist */ }

  // Add note
  await ghlFetch(`/contacts/${contactId}/notes`, {
    method: 'POST',
    body: JSON.stringify({
      body: `[Speed-to-Lead] Auto-responded via SMS within 60s at ${new Date().toISOString()}`
    })
  });

  console.log(`Speed-to-lead: auto-responded to ${c.contactName || contactId}`);
  return { status: 'responded', contactId, name: c.contactName };
}

async function handleInboundMessage(data) {
  const contactId = data.contactId || data.contact_id;
  if (!contactId) return { status: 'skipped' };

  // Tag as responded for conversion tracking
  try {
    await ghlFetch(`/contacts/${contactId}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: ['responded', 'conversion-tracked'] })
    });

    // Move to Contacted stage
    const opps = await ghlFetch(
      `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}`
    );
    for (const opp of (opps.opportunities || [])) {
      if (opp.pipelineId === 'Dggu0FKblYAunQy3tEUs' &&
          opp.pipelineStageId === 'f9e8c5a3-bc3f-49cc-8c85-6cbecbead64e') {
        await ghlFetch(`/opportunities/${opp.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            pipelineStageId: '005eff38-28b3-4bf9-b987-fdec9b87a75a'
          })
        });
      }
    }

    console.log(`Conversion tracked: ${contactId}`);
    return { status: 'tracked', contactId };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (req.method !== 'POST' || !req.url.startsWith('/webhooks/ghl')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const eventType = data.type || data.event || req.headers['x-ghl-event'] || 'unknown';

      console.log(`Webhook: ${eventType} at ${new Date().toISOString()}`);

      let result;
      switch (eventType) {
        case 'ContactCreate':
        case 'contact.create':
          result = await handleContactCreate(data);
          break;
        case 'InboundMessage':
        case 'message.inbound':
          result = await handleInboundMessage(data);
          break;
        default:
          result = { status: 'ignored', event: eventType };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Webhook error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`TerraLift Webhook Handler running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Webhook: http://localhost:${PORT}/webhooks/ghl`);
});
