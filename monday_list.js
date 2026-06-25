'use strict';
require('dotenv').config({ path: '/Users/mateocortazar/ghl-dashboard/.env' });

const fs   = require('fs');
const { WebClient } = require('@slack/web-api');

const CSV_PATH      = '/Users/mateocortazar/ghl-dashboard/data.csv';
const ROTATION_PATH = '/Users/mateocortazar/ghl-dashboard/last_week_lists.json';
const LOGS_DIR      = '/Users/mateocortazar/ghl-dashboard/logs';
const DM_TARGET     = 'U07EMR4R3DJ'; // Mateo's Slack user ID — DM fallback until #hc-monday-list exists
const HCS           = ['Matt Chavez', 'Paola Sella', 'Mateo Cortazar'];
const ROTATION_KEYS = { 'Matt Chavez': 'matt', 'Paola Sella': 'paola', 'Mateo Cortazar': 'mateo' };
const HC_TARGETS_FALLBACK = { 'Matt Chavez': 44, 'Paola Sella': 37, 'Mateo Cortazar': 38 };
const TARGETS_PATH  = '/Users/mateocortazar/ghl-dashboard/hc_targets.json';
let HC_TARGETS = HC_TARGETS_FALLBACK;
try {
  HC_TARGETS = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
} catch (_) { /* use fallback */ }
const CARRYOVER_DAYS = 7; // if >= 7 days without contact since last list → force carry over

// ─── CSV PARSING ──────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else field += line[i++];
      }
      fields.push(field);
      if (i < line.length && line[i] === ',') i++;
    } else {
      let field = '';
      while (i < line.length && line[i] !== ',') field += line[i++];
      fields.push(field.trim());
      if (i < line.length) i++;
    }
  }
  return fields;
}

function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const f = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (f[i] || '').trim(); });
    return row;
  }).filter(r => r['Name']);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  const p = dateStr.split('/');
  if (p.length !== 3) return 9999;
  const d = new Date(parseInt(p[2]), parseInt(p[0]) - 1, parseInt(p[1]));
  return isNaN(d) ? 9999 : Math.floor((Date.now() - d.getTime()) / 86400000);
}

function parseUpsellStage(text) {
  if (!text) return 'N/A';
  for (const s of ['Pitched', 'Active', 'Detected', 'Seeded', 'Closed']) {
    if (text.startsWith(s)) return s;
  }
  return 'N/A';
}

function getMondayDate() {
  const d = new Date();
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  return m;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function trunc(text, max = 80) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ─── SCORING ─────────────────────────────────────────────────────────────────

function scoreClient(c) {
  let score = 0;
  const stage = parseUpsellStage(c['Upsell']);
  const days  = parseInt(c['Days w/o Contact']) || 0;
  const ckDays = daysSince(c['Last Check-in']);
  const phase  = c['Phase'] || '';

  if      (stage === 'Pitched')  score += 40;
  else if (stage === 'Active')   score += 30;
  else if (stage === 'Detected') score += 25;
  else if (stage === 'Seeded')   score += 15;
  else if (stage === 'Closed')   score -= 10;

  if (c['Showed Up'] === 'Yes' && ckDays <= 21) score += 20;
  if (phase.includes('Month 1') || phase.includes('Month 2')) score += 15;
  if (days > 45)      score += 10;
  else if (days > 21) score += 5;
  if (c['Next Check-in'] === 'Overdue') score += 10;
  if (c['Showed Up'] === 'No') score -= 15;

  return score;
}

function withScore(arr) {
  return arr.map(c => ({ ...c, _score: scoreClient(c) }));
}

// ─── CLIENT SELECTION ────────────────────────────────────────────────────────

function selectClientsForHC(clients, hcName, lastWeekNames) {
  const hc    = clients.filter(c => c['HC'] === hcName);
  const lastW = new Set(lastWeekNames || []);

  // Carryover: was on last week's list AND still hasn't been contacted (>= 7 days w/o contact)
  const carryoverNames = new Set(
    hc
      .filter(c => lastW.has(c['Name']) && (parseInt(c['Days w/o Contact']) || 0) >= CARRYOVER_DAYS)
      .map(c => c['Name'])
  );

  function tagAndScore(arr) {
    return withScore(arr).map(c => ({ ...c, _carryover: carryoverNames.has(c['Name']) }));
  }

  const month1    = hc.filter(c => c['Status'] === 'Closed' && c['Phase'].includes('Month 1'));
  const month2    = hc.filter(c => c['Status'] === 'Closed' && c['Phase'].includes('Month 2'));
  const month3plus = hc.filter(c =>
    c['Status'] === 'Closed' && (c['Phase'].includes('Month 3+') || !c['Phase'])
  );
  const onHold   = hc.filter(c => c['Status'] === 'On Hold');
  const canceled = hc.filter(c => c['Status'] === 'Canceled');

  // Month 1 — all (carryover M1 clients are already always included)
  let selectedM1 = tagAndScore(month1).sort((a, b) => b._score - a._score);

  // Month 2 — half, but carryover always included first
  const m2Scored = tagAndScore(month2);
  const m2Carryover = m2Scored.filter(c => c._carryover);
  const m2Rest = m2Scored.filter(c => !c._carryover).sort((a, b) => {
    const aNew = lastW.has(a['Name']) ? 0 : 1;
    const bNew = lastW.has(b['Name']) ? 0 : 1;
    if (aNew !== bNew) return bNew - aNew;
    const aDue = (parseInt(a['Days w/o Contact']) || 0) >= 14 ? 1 : 0;
    const bDue = (parseInt(b['Days w/o Contact']) || 0) >= 14 ? 1 : 0;
    if (aDue !== bDue) return bDue - aDue;
    return b._score - a._score;
  });
  const m2Count = Math.max(Math.round(month2.length / 2), m2Carryover.length);
  let selectedM2 = [...m2Carryover, ...m2Rest.slice(0, Math.max(0, m2Count - m2Carryover.length))];

  // Month 3+ — quarter, carryover always included (overrides last-week exclusion rule)
  const m3Scored = tagAndScore(month3plus);
  const m3Carryover = m3Scored.filter(c => c._carryover);
  const m3Rest = m3Scored
    .filter(c => !c._carryover && (!lastW.has(c['Name']) || c._score >= 40))
    .sort((a, b) =>
      b._score - a._score ||
      (parseInt(b['Days w/o Contact']) || 0) - (parseInt(a['Days w/o Contact']) || 0)
    );
  const m3Count = Math.max(Math.round(month3plus.length / 4), m3Carryover.length);
  let selectedM3 = [...m3Carryover, ...m3Rest.slice(0, Math.max(0, m3Count - m3Carryover.length))];

  // On Hold — half, carryover always included first
  const holdScored = tagAndScore(onHold);
  const holdCarryover = holdScored.filter(c => c._carryover);
  const holdRest = holdScored
    .filter(c => !c._carryover)
    .sort((a, b) => (parseInt(b['Days w/o Contact']) || 0) - (parseInt(a['Days w/o Contact']) || 0));
  const holdCount = Math.max(Math.round(onHold.length / 2), holdCarryover.length);
  let selectedHold = [...holdCarryover, ...holdRest.slice(0, Math.max(0, holdCount - holdCarryover.length))];

  // Canceled — quarter, carryover always included first
  const canceledScored = tagAndScore(canceled)
    .sort((a, b) => (parseInt(b['Days w/o Contact']) || 0) - (parseInt(a['Days w/o Contact']) || 0));
  const canceledCarryover = canceledScored.filter(c => c._carryover);
  const canceledRest = canceledScored.filter(c => !c._carryover);
  const canceledCount = Math.max(Math.round(canceled.length / 4), canceledCarryover.length);
  let selectedCanceled = [...canceledCarryover, ...canceledRest.slice(0, Math.max(0, canceledCount - canceledCarryover.length))];

  // ── Hard cap at HC weekly target — carryover clients get priority but count toward the total ──
  const target = HC_TARGETS[hcName];
  if (target) {
    let total = selectedM1.length + selectedM2.length + selectedM3.length +
                selectedHold.length + selectedCanceled.length;

    // Pass 1: trim non-carryover clients (Canceled → Hold → M3+ → M2 → M1)
    if (total > target) {
      const canceledTrimable = selectedCanceled.filter(c => !c._carryover);
      const canceledTrim = Math.min(canceledTrimable.length, total - target);
      selectedCanceled = [...selectedCanceled.filter(c => c._carryover), ...canceledTrimable.slice(0, canceledTrimable.length - canceledTrim)];
      total -= canceledTrim;
    }
    if (total > target) {
      const holdTrimable = selectedHold.filter(c => !c._carryover);
      const holdTrim = Math.min(holdTrimable.length, total - target);
      selectedHold = [...selectedHold.filter(c => c._carryover), ...holdTrimable.slice(0, holdTrimable.length - holdTrim)];
      total -= holdTrim;
    }
    if (total > target) {
      const m3Trimable = selectedM3.filter(c => !c._carryover);
      const m3Trim = Math.min(m3Trimable.length, total - target);
      selectedM3 = [...selectedM3.filter(c => c._carryover), ...m3Trimable.slice(0, m3Trimable.length - m3Trim)];
      total -= m3Trim;
    }
    if (total > target) {
      const m2Trimable = selectedM2.filter(c => !c._carryover);
      const m2Trim = Math.min(m2Trimable.length, total - target);
      selectedM2 = [...selectedM2.filter(c => c._carryover), ...m2Trimable.slice(0, m2Trimable.length - m2Trim)];
      total -= m2Trim;
    }
    // Pass 2: if still over (only carryover clients remain), trim carryover from lowest-priority groups
    if (total > target) {
      const m3Carryover = selectedM3.slice(0, Math.max(0, selectedM3.length - (total - target)));
      total -= selectedM3.length - m3Carryover.length;
      selectedM3 = m3Carryover;
    }
    if (total > target) {
      const holdCarryover = selectedHold.slice(0, Math.max(0, selectedHold.length - (total - target)));
      total -= selectedHold.length - holdCarryover.length;
      selectedHold = holdCarryover;
    }
    if (total > target) {
      const canceledCarryover = selectedCanceled.slice(0, Math.max(0, selectedCanceled.length - (total - target)));
      selectedCanceled = canceledCarryover;
    }
  }

  return { selectedM1, selectedM2, selectedM3, selectedHold, selectedCanceled };
}

// ─── MESSAGE BUILDING ─────────────────────────────────────────────────────────

function buildMessage(hcName, groups, monday, isManualRun, slackUserId) {
  const { selectedM1, selectedM2, selectedM3, selectedHold, selectedCanceled } = groups;
  const all   = [...selectedM1, ...selectedM2, ...selectedM3, ...selectedHold, ...selectedCanceled];
  const total = all.length;
  const div   = '━━━━━━━━━━━━━━━━━━━━━━━━━';

  // Upsell priority: Pitched, Active, Detected — from any segment
  const upsellPriority = all
    .filter(c => ['Pitched', 'Active', 'Detected'].includes(parseUpsellStage(c['Upsell'])))
    .sort((a, b) => b._score - a._score);
  const upsellNames = new Set(upsellPriority.map(c => c['Name']));

  const manualNote = isManualRun ? `_(Manual run — ${new Date().toLocaleDateString('en-US')})_\n` : '';
  const carryoverCount = all.filter(c => c._carryover).length;

  let msg = `${div}\n`;
  msg += `📋 *MONDAY LIST — ${hcName.toUpperCase()}* | Week of ${fmtDate(monday)}\n`;
  if (manualNote) msg += manualNote;
  msg += `*${total} unique clients this week*\n`;
  if (carryoverCount > 0) {
    msg += `⚠️ *${carryoverCount} carried over from last week (not contacted)*\n`;
  }
  msg += `${div}\n\n`;

  // 🔥 Upsell Priority
  if (upsellPriority.length > 0) {
    msg += `🔥 *UPSELL PRIORITY* — close or pitch this week (${upsellPriority.length} clients)\n`;
    for (const c of upsellPriority) {
      const stage   = parseUpsellStage(c['Upsell']);
      const days    = c['Days w/o Contact'] || '?';
      const comment = trunc(c['Latest Comment'], 80);
      const action  = (stage === 'Pitched' || stage === 'Active') ? '*CLOSE IT*'
                    : stage === 'Detected' ? '*PITCH THIS WEEK*' : '*ADVANCE*';
      const ckStr   = c['Showed Up'] === 'Yes' ? ' | attended last check-in' : '';
      const cmtStr  = comment ? ` | _"${comment}"_` : '';
      const nc      = c._carryover ? ' ⚠️' : '';
      msg += `• *${c['Name']}*${nc} | ${action} — ${stage} | ${days} days no contact${ckStr}${cmtStr}\n`;
    }
    msg += '\n';
  }

  // 📅 Month 1
  if (selectedM1.length > 0) {
    // Show all M1 clients; mark upsell ones with a star
    msg += `📅 *MONTH 1 — Weekly check-ins* (${selectedM1.length} clients)\n`;
    msg += `_Check-in already scheduled. Use it to plant or advance the upsell._\n`;
    for (const c of selectedM1) {
      const stage   = parseUpsellStage(c['Upsell']);
      const nextCk  = c['Next Check-in'] || 'No check-ins';
      const activeDays = parseInt(c['Active Days']) || 0;
      const weekNum = activeDays > 0 ? `Week ~${Math.ceil(activeDays / 7)} of Month 1` : 'Month 1';
      const stageStr = stage !== 'N/A' ? ` | Upsell: *${stage}*` : '';
      const star    = upsellNames.has(c['Name']) ? ' 🔥' : '';
      const nc      = c._carryover ? ' ⚠️' : '';
      msg += `• *${c['Name']}*${star}${nc} | ${weekNum}${stageStr} | ${nextCk}\n`;
    }
    msg += '\n';
  }

  // 📅 Month 2
  if (selectedM2.length > 0) {
    msg += `📅 *MONTH 2 — This week's batch* (${selectedM2.length} clients)\n`;
    for (const c of selectedM2) {
      const stage  = parseUpsellStage(c['Upsell']);
      const days   = c['Days w/o Contact'] || '?';
      const stageStr = stage !== 'N/A' ? ` | Upsell: *${stage}*` : '';
      const star   = upsellNames.has(c['Name']) ? ' 🔥' : '';
      const nc     = c._carryover ? ' ⚠️' : '';
      msg += `• *${c['Name']}*${star}${nc} | ${days} days since last contact${stageStr}\n`;
    }
    msg += '\n';
  }

  // 📞 Month 3+ Sequences
  if (selectedM3.length > 0) {
    msg += `📞 *MONTH 3+ SEQUENCES* (${selectedM3.length} clients)\n`;
    msg += `_Day 1: 3 calls · Day 2: SMS · Day 3: 2 calls_\n`;
    for (const c of selectedM3) {
      const stage  = parseUpsellStage(c['Upsell']);
      const days   = c['Days w/o Contact'] || '?';
      const stageStr = stage !== 'N/A' ? ` | Upsell: *${stage}*` : '';
      const star   = upsellNames.has(c['Name']) ? ' 🔥' : '';
      const nc     = c._carryover ? ' ⚠️' : '';
      msg += `• *${c['Name']}*${star}${nc} | ${days} days no contact${stageStr}\n`;
    }
    msg += '\n';
  }

  // ⏸ On Hold
  if (selectedHold.length > 0) {
    msg += `⏸ *ON HOLD* (${selectedHold.length} clients) — 2 attempts this week\n`;
    for (const c of selectedHold) {
      const nc = c._carryover ? ' ⚠️' : '';
      msg += `• *${c['Name']}*${nc} | ${c['Days w/o Contact'] || '?'} days no contact\n`;
    }
    msg += '\n';
  }

  // 📬 Canceled
  if (selectedCanceled.length > 0) {
    msg += `📬 *CANCELED* (${selectedCanceled.length} clients) — 1 message only\n`;
    for (const c of selectedCanceled) {
      const nc = c._carryover ? ' ⚠️' : '';
      msg += `• *${c['Name']}*${nc} | ${c['Days w/o Contact'] || '?'} days no contact\n`;
    }
    msg += '\n';
  }

  // Summary footer
  const toClose  = all.filter(c => ['Pitched', 'Active'].includes(parseUpsellStage(c['Upsell']))).length;
  const toPitch  = all.filter(c => parseUpsellStage(c['Upsell']) === 'Detected').length;
  msg += `${div}\n`;
  msg += `*THIS WEEK'S FOCUS:*\n`;
  msg += `🎯 Upsells to close: *${toClose}* (Pitched/Active)\n`;
  msg += `💬 Upsells to pitch: *${toPitch}* (Detected)\n`;
  msg += `📞 Sequences to launch: *${selectedM3.length}*\n`;
  msg += div;

  return msg;
}

// ─── SLACK ────────────────────────────────────────────────────────────────────

// No channel lookup needed — chat.postMessage accepts a user ID directly

async function findSlackUserId(slack, fullName) {
  try {
    const list = await slack.users.list({ limit: 500 });
    const first = fullName.toLowerCase().split(' ')[0];
    const user  = (list.members || []).find(u =>
      !u.deleted && (
        (u.profile?.display_name || '').toLowerCase().includes(first) ||
        (u.real_name || '').toLowerCase().includes(first) ||
        (u.name || '').toLowerCase().includes(first)
      )
    );
    return user ? user.id : null;
  } catch (e) {
    console.warn(`  Could not look up Slack user for ${fullName}: ${e.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  console.log(`\n[${new Date().toISOString()}] Monday List starting...`);

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`ERROR: data.csv not found at ${CSV_PATH}`);
    process.exit(1);
  }

  const clients = parseCSV(CSV_PATH);
  console.log(`Loaded ${clients.length} clients from data.csv`);

  // Load rotation
  let lastWeekData = { week_of: null, matt: [], jorge: [], mateo: [] };
  if (fs.existsSync(ROTATION_PATH)) {
    try {
      lastWeekData = JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf8'));
      console.log(`Rotation file loaded (week of ${lastWeekData.week_of})`);
    } catch (e) {
      console.warn('Could not parse rotation file — starting fresh');
    }
  } else {
    console.log('No rotation file — first run, no exclusions');
  }

  const monday      = getMondayDate();
  const isManualRun = new Date().getDay() !== 1;
  if (isManualRun) console.log('Manual run detected (not Monday)');

  // Slack — send directly to Mateo's user ID (no channel lookup needed)
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const channelId = DM_TARGET;
  console.log(`Slack target: DM to ${DM_TARGET}`);

  const newRotation = { week_of: monday.toISOString().split('T')[0], matt: [], jorge: [], mateo: [] };

  for (const hcName of HCS) {
    console.log(`\nProcessing ${hcName}...`);

    const lastWeekNames = lastWeekData[ROTATION_KEYS[hcName]] || [];
    const groups  = selectClientsForHC(clients, hcName, lastWeekNames);
    const { selectedM1, selectedM2, selectedM3, selectedHold, selectedCanceled } = groups;
    const all     = [...selectedM1, ...selectedM2, ...selectedM3, ...selectedHold, ...selectedCanceled];

    console.log(`  M1=${selectedM1.length} M2=${selectedM2.length} M3+=${selectedM3.length} OnHold=${selectedHold.length} Canceled=${selectedCanceled.length} → Total=${all.length}`);

    // Look up Slack user ID
    const slackUserId = null; // future: @mentions per HC

    const message = buildMessage(hcName, groups, monday, isManualRun, slackUserId);

    // Save to rotation
    newRotation[ROTATION_KEYS[hcName]] = all.map(c => c['Name']);

    // Send to Slack
    if (channelId) {
      try {
        await slack.chat.postMessage({ channel: channelId, text: message, mrkdwn: true });
        console.log(`  Sent to Slack`);
      } catch (e) {
        console.error(`  Slack send failed: ${e.message}`);
        console.log(`\n--- FALLBACK: ${hcName} ---\n${message}\n--- END ---`);
      }
    } else {
      console.log(`\n--- SLACK UNAVAILABLE: ${hcName} ---\n${message}\n--- END ---`);
    }
  }

  // Save rotation file
  fs.writeFileSync(ROTATION_PATH, JSON.stringify(newRotation, null, 2));
  console.log(`\nRotation saved → ${ROTATION_PATH}`);
  console.log(`[${new Date().toISOString()}] Done.`);
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] FATAL:`, err.message || err);
  process.exit(1);
});
