const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const {google} = require('googleapis');

// Leer variables de entorno desde .env
function loadEnv() {
  const envFile = '/Users/mateocortazar/ghl-dashboard/.env';
  if (!fs.existsSync(envFile)) return {};
  const env = {};
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return env;
}
const ENV = loadEnv();
const GITHUB_TOKEN = ENV.GITHUB_TOKEN || '';

const TOKEN = 'pit-fe410924-18d2-4d12-9636-a05aa95e7094';
const LOCATION_ID = 'nBJaHWqLWmHJZScjsZJS';
const CREDENTIALS_PATH = '/Users/mateocortazar/ghl-dashboard/credentials.json';
const CHECKINS_SHEET_ID = '1OeFPo2mUQ15oPEPgAHI6C3wgi39j_UUiTmOB5qx8Jlo';
const RCRM_SHEET_ID = '1tezh5OM7fg2khAAMg128Jf0F51f0oGISa3yv3hbXaFE';
const UPSELL_SHEET_ID   = '13GmU4WLqNJjCGPvjqrxuZg7utELMJQWbqNxjjiM7ojg';
const HC_METRICS_ID     = '1WC22XiU199p8N8L8a2i0wtrynqT7j49_o-A3fhpQsfc';

const CONSULTANTS = [
  { name: 'Mateo Cortazar', assignedTo: 'Q0aVHyBbFhqJxWuEKLMt', userId: 'Q0aVHyBbFhqJxWuEKLMt', color: '#6366f1' },
  { name: 'Matt Chavez',    assignedTo: 'uqAeFfwbHnH0lCwSvprz', userId: 'uqAeFfwbHnH0lCwSvprz', color: '#06b6d4' },
  { name: 'Paola Sella',    assignedTo: 'lLAobNN6pGwCHqXYXBMr', userId: 'lLAobNN6pGwCHqXYXBMr', color: '#10b981' }
];

function ghl(path, cb) {
  const opts = {
    hostname: 'services.leadconnectorhq.com',
    path, method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'locationId': LOCATION_ID,
      'Version': '2021-07-28'
    }
  };
  let data = '';
  https.request(opts, r => {
    r.on('data', d => data += d);
    r.on('end', () => { try { cb(JSON.parse(data)); } catch(e) { cb({raw: data}); } });
  }).on('error', e => cb({error: e.message})).end();
}

function getAllConversations(assignedTo, cb) {
  let all = [];
  function fetchPage(lastDate, lastId) {
    let p = '/conversations/search?locationId=' + LOCATION_ID + '&limit=50&sort=asc&sortBy=last_message_date&type=inbox&assignedTo=' + assignedTo;
    if (lastDate) p += '&startAfterDate=' + lastDate;
    if (lastId) p += '&startAfterId=' + lastId;
    ghl(p, (data) => {
      const convos = data.conversations || [];
      all = all.concat(convos);
      if (convos.length === 50) {
        const last = convos[convos.length - 1];
        fetchPage(last.lastMessageDate, last.id);
      } else {
        cb(all);
      }
    });
  }
  fetchPage(null, null);
}

function getCurrentWeekStart() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = (day === 0) ? -6 : 1 - day; // days back to Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getLastSmsCall(conversationId, userId, cb) {
  ghl('/conversations/' + conversationId + '/messages?limit=100', d => {
    const msgs = d.messages?.messages || [];
    // All outbound SMS/calls manually sent by this user (exclude workflow/campaign automations)
    const outbound = msgs.filter(m =>
      (m.messageType === 'TYPE_SMS' || m.messageType === 'TYPE_CALL') &&
      m.direction === 'outbound' &&
      m.userId === userId &&
      m.source !== 'workflow' &&
      m.source !== 'campaign'
    );
    const match = outbound.length > 0 ? outbound[0] : null;

    // Weekly activity — reads meta.duration for calls (seconds); 2+ min = >= 120
    const weekStart = getCurrentWeekStart();
    const weeklyMsgs = outbound.filter(m => new Date(m.dateAdded) >= weekStart);
    const callsByDay = {};
    weeklyMsgs.filter(m => m.messageType === 'TYPE_CALL').forEach(msg => {
      const day = new Date(msg.dateAdded).toDateString();
      callsByDay[day] = (callsByDay[day] || 0) + 1;
    });
    const maxCallsInOneDay = Object.values(callsByDay).length > 0
      ? Math.max(...Object.values(callsByDay))
      : 0;
    const weekly = {
      smsCount: weeklyMsgs.filter(m => m.messageType === 'TYPE_SMS').length,
      callCount: weeklyMsgs.filter(m => m.messageType === 'TYPE_CALL').length,
      hadCallWith2min: weeklyMsgs.some(m =>
        m.messageType === 'TYPE_CALL' && m.meta && ((m.meta.duration || 0) >= 120 || (m.meta.call && (m.meta.call.duration || 0) >= 120))
      ),
      maxCallsInOneDay
    };

    if (match) {
      cb({ found: true, messageType: match.messageType, dateAdded: match.dateAdded, weekly, allOutbound: outbound });
    } else {
      cb({ found: false, weekly, allOutbound: outbound });
    }
  });
}

function processConsultant(consultant, cb) {
  console.log('Processing ' + consultant.name + '...');
  getAllConversations(consultant.assignedTo, convos => {
    console.log('  ' + convos.length + ' conversations. Processing messages...');
    const results = [];
    let i = 0;
    function next() {
      if (i >= convos.length) { cb(results); return; }
      const c = convos[i++];
      getLastSmsCall(c.id, consultant.userId, r => {
        const now = new Date();
        let daysSince = null;
        if (r.found) daysSince = Math.floor((now - new Date(r.dateAdded)) / (1000 * 60 * 60 * 24));
        results.push({
          name: c.contactName || c.id,
          contactId: c.contactId || null,
          lastContact: r.found ? r.dateAdded : null,
          daysSince: daysSince,
          type: r.found ? r.messageType : null,
          consultant: consultant.name,
          consultantColor: consultant.color,
          weekly: r.weekly || { smsCount: 0, callCount: 0, hadCallWith2min: false },
          allOutbound: r.allOutbound || []
        });
        if (i % 20 === 0) console.log('  ' + i + '/' + convos.length);
        next();
      });
    }
    next();
  });
}


const FIREFLIES_MARKERS = ['fireflies', 'new fireflies', 'demo call notes', 'demo call', 'attendes:', 'transcript https://app.fireflies'];

function isFireflies(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return FIREFLIES_MARKERS.some(m => lower.includes(m));
}

function getContactNotes(contactId, cb) {
  if (!contactId) { cb(null); return; }
  ghl('/contacts/' + contactId + '/notes', d => {
    const notes = d.notes || [];
    const manual = notes.filter(n => n.userId !== null);
    if (manual.length === 0) { cb(null); return; }
    manual.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    const valid = manual.find(n => !isFireflies(n.bodyText || n.body));
    if (!valid) { cb(null); return; }
    cb({ body: valid.bodyText || valid.body, dateAdded: valid.dateAdded });
  });
}

// Parses any date string safely as LOCAL time (avoids UTC-midnight timezone shift).
// Handles: "4/13/2026", "04/13/2026", "2026-04-13", full ISO timestamps.
function parseFlexDate(str) {
  if (!str) return null;
  // Full ISO timestamp with time — let JS parse normally (already has timezone info)
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return new Date(str);
  // ISO date only: "2026-04-13" — JavaScript treats this as UTC midnight, causing a 1-day
  // shift in Colombia (UTC-5). Fix: treat as local noon instead.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, mo, d] = str.split('-').map(Number);
    return new Date(y, mo - 1, d, 12, 0, 0);
  }
  // M/D/YYYY or MM/DD/YYYY (manually entered in Upsell Tracker) — parse as local time
  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]), 12, 0, 0);
  // Fallback
  return new Date(str);
}

async function getSheetData(spreadsheetId, range) {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({version: 'v4', auth});
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

function generateClientId(name, hc) {
  const input = name.toLowerCase().trim() + hc.toLowerCase().trim();
  return crypto.createHash('md5').update(input).digest('hex').substring(0, 12);
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function setupSheetIfEmpty(sheets) {
  // Verificar si la pestaña "Upsell Tracker" existe; crearla si no
  const meta = await sheets.spreadsheets.get({ spreadsheetId: UPSELL_SHEET_ID });
  const tabExists = meta.data.sheets.some(s => s.properties.title === 'Upsell Tracker');
  if (!tabExists) {
    console.log('Creando pestaña Upsell Tracker...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: UPSELL_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Upsell Tracker' } } }] }
    });
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: UPSELL_SHEET_ID,
    range: 'Upsell Tracker!A1:J1'
  });
  const rows = res.data.values || [];
  const meta2 = await sheets.spreadsheets.get({ spreadsheetId: UPSELL_SHEET_ID });
  const sheetMeta = meta2.data.sheets.find(s => s.properties.title === 'Upsell Tracker');
  const sheetId = sheetMeta ? sheetMeta.properties.sheetId : 0;

  const headersExist = rows.length > 0 && rows[0].length > 0;
  if (!headersExist) {
    console.log('Upsell Tracker vacío — escribiendo headers...');
    const headers = ['ID', 'Cliente', 'HC', 'Status', 'Tipo', 'Phase', 'Días Activo', 'Último Contacto', 'Upsell Stage', 'Notas HC', 'Stage Since'];
    await sheets.spreadsheets.values.update({
      spreadsheetId: UPSELL_SHEET_ID,
      range: 'Upsell Tracker!A1:K1',
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: UPSELL_SHEET_ID,
    requestBody: {
      requests: [{
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 8, endColumnIndex: 9 },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: [
                { userEnteredValue: 'N/A' },
                { userEnteredValue: 'Seeded' },
                { userEnteredValue: 'Detected' },
                { userEnteredValue: 'Pitched' },
                { userEnteredValue: 'Active' },
                { userEnteredValue: 'Closed' },
                { userEnteredValue: 'Failed Negotiation' },
                { userEnteredValue: 'Not Interested' }
              ]
            },
            showCustomUi: true,
            strict: true
          }
        }
      }]
    }
  });
  console.log('Headers y dropdown de Upsell Stage configurados.');
  if (!headersExist) {
    await styleUpsellSheet(sheets, sheetId);
    console.log('Estilos aplicados al Upsell Tracker.');
  }
}

async function styleUpsellSheet(sheets, sheetId, existingBandId) {
  const requests = [];

  // Header: indigo-700, texto blanco bold, cubre todas las columnas
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.263, green: 0.220, blue: 0.792 }, // #4338ca indigo-700
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE'
        }
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
    }
  });

  // Altura header: 46px
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 46 },
      fields: 'pixelSize'
    }
  });

  // Altura filas de datos: 36px (más cómodas de leer)
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1000 },
      properties: { pixelSize: 36 },
      fields: 'pixelSize'
    }
  });

  // Congelar primera fila
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  // Anchos de columna A-M: ajustados a las columnas visibles
  // A=ID, B=Cliente, C=HC, D=Status, E=Tipo, F=Phase, G=Días, H=Último Contacto,
  // I=Upsell Stage, J=Notas HC, K=Stage Since, L=Last External Contact, M=External Channel
  [90, 220, 120, 120, 160, 110, 80, 120, 140, 320, 100, 160, 130].forEach((width, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: width },
        fields: 'pixelSize'
      }
    });
  });

  // Alineación vertical MIDDLE y fuente 11 en todas las celdas de datos
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 13 },
      cell: {
        userEnteredFormat: {
          verticalAlignment: 'MIDDLE',
          textFormat: { fontSize: 11 }
        }
      },
      fields: 'userEnteredFormat(verticalAlignment,textFormat)'
    }
  });

  // Centrar: HC (col 2), Status (col 3), Upsell Stage (col 8), External Channel (col 12)
  [2, 3, 8, 12].forEach(colIdx => {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(horizontalAlignment)'
      }
    });
  });

  // Notas HC (col 9): wrap text + alinear arriba para que se lea todo
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 9, endColumnIndex: 10 },
      cell: {
        userEnteredFormat: {
          wrapStrategy: 'WRAP',
          verticalAlignment: 'TOP'
        }
      },
      fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)'
    }
  });

  // Banding solo se agrega si no existe (al crear el sheet por primera vez)
  if (!existingBandId) {
    requests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 13 },
          rowProperties: {
            firstBandColor:  { red: 1.0,   green: 1.0,   blue: 1.0  },
            secondBandColor: { red: 0.961, green: 0.953, blue: 1.0  }
          }
        }
      }
    });
  }

  // Colores vividos por Upsell Stage (columna I, índice 8)
  const stageStyles = [
    { value: 'N/A',      bg: { red: 0.929, green: 0.929, blue: 0.929 }, fg: { red: 0.333, green: 0.333, blue: 0.333 } },
    { value: 'Seeded',   bg: { red: 0.816, green: 0.878, blue: 1.0   }, fg: { red: 0.059, green: 0.216, blue: 0.655 } },
    { value: 'Detected', bg: { red: 1.0,   green: 0.925, blue: 0.694 }, fg: { red: 0.490, green: 0.267, blue: 0.0   } },
    { value: 'Pitched',  bg: { red: 1.0,   green: 0.875, blue: 0.780 }, fg: { red: 0.573, green: 0.169, blue: 0.051 } },
    { value: 'Active',   bg: { red: 0.773, green: 0.965, blue: 0.835 }, fg: { red: 0.024, green: 0.357, blue: 0.149 } },
    { value: 'Closed',            bg: { red: 0.867, green: 0.800, blue: 1.0   }, fg: { red: 0.298, green: 0.082, blue: 0.647 } },
    { value: 'Failed Negotiation', bg: { red: 0.988, green: 0.859, blue: 0.859 }, fg: { red: 0.545, green: 0.114, blue: 0.114 } },
    { value: 'Not Interested',     bg: { red: 0.878, green: 0.878, blue: 0.878 }, fg: { red: 0.2,   green: 0.2,   blue: 0.2   } }
  ];
  stageStyles.forEach(s => {
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 8, endColumnIndex: 9 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: s.value }] },
            format: {
              backgroundColor: s.bg,
              textFormat: { bold: true, foregroundColor: s.fg }
            }
          }
        },
        index: 0
      }
    });
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: UPSELL_SHEET_ID,
    requestBody: { requests }
  });
}

async function applyUpsellStyle(sheets) {
  // Obtener metadata del sheet
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: UPSELL_SHEET_ID,
    fields: 'sheets(properties(sheetId,title),conditionalFormats,bandedRanges)'
  });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === 'Upsell Tracker');
  if (!sheetMeta) return;
  const sheetId = sheetMeta.properties.sheetId;

  // Borrar solo reglas de formato condicional existentes (de mayor a menor índice)
  const clearRequests = [];
  const rules = sheetMeta.conditionalFormats || [];
  for (let i = rules.length - 1; i >= 0; i--) {
    clearRequests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }
  if (clearRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: UPSELL_SHEET_ID,
      requestBody: { requests: clearRequests }
    });
  }

  // Pasar el bandedRangeId existente para actualizarlo en vez de crear uno nuevo
  const existingBands = sheetMeta.bandedRanges || [];
  const existingBandId = existingBands.length > 0 ? existingBands[0].bandedRangeId : null;

  await styleUpsellSheet(sheets, sheetId, existingBandId);
  console.log('Estilos del Upsell Tracker actualizados.');
}

async function handleClosedUpsells(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: UPSELL_SHEET_ID,
    range: 'Upsell Tracker!A:N'
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return;

  const dataRows = rows.slice(1);
  const closedRowNums = [];
  const closedRows = [];
  dataRows.forEach((row, idx) => {
    if ((row[8] || '') === 'Closed') {
      closedRowNums.push(idx + 2); // fila real en el sheet (header = fila 1)
      closedRows.push(row);
    }
  });
  if (closedRows.length === 0) return;

  console.log(closedRows.length + ' clientes Closed → moviendo a Historial Upsells...');

  const meta = await sheets.spreadsheets.get({ spreadsheetId: UPSELL_SHEET_ID });
  const historialExists = meta.data.sheets.some(s => s.properties.title === 'Historial Upsells');
  if (!historialExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: UPSELL_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Historial Upsells' } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: UPSELL_SHEET_ID,
      range: 'Historial Upsells!A1:F1',
      valueInputOption: 'RAW',
      requestBody: { values: [['ID', 'Cliente', 'HC', 'Fecha Cierre', 'Stage anterior', 'Notas']] }
    });
  }

  const today = new Date().toLocaleDateString('es-CO');
  const historialRows = closedRows.map(row => [
    row[0] || '', row[1] || '', row[2] || '', today, row[13] || row[8] || '', row[9] || ''
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: UPSELL_SHEET_ID,
    range: 'Historial Upsells!A:F',
    valueInputOption: 'RAW',
    requestBody: { values: historialRows }
  });

  console.log('Historial actualizado. Stages Closed se mantienen como Closed.');
}

async function ensureTrackerHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: UPSELL_SHEET_ID,
    range: 'Upsell Tracker!A1:N1'
  });
  const headers = (res.data.values || [[]])[0] || [];
  const updates = [];
  if (!headers[10]) updates.push({ range: 'Upsell Tracker!K1', values: [['Stage Since']] });
  if (!headers[11]) updates.push({ range: 'Upsell Tracker!L1', values: [['Last External Contact']] });
  if (!headers[12]) updates.push({ range: 'Upsell Tracker!M1', values: [['External Channel']] });
  if (!headers[13]) updates.push({ range: 'Upsell Tracker!N1', values: [['Prev Stage']] });
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: UPSELL_SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
    console.log('Tracker headers actualizados: K, L, M, N.');
  }
}

async function syncUpsellSheet(sheets, enriched) {
  console.log('Sincronizando Upsell Tracker...');

  await ensureTrackerHeaders(sheets);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: UPSELL_SHEET_ID,
    range: 'Upsell Tracker!A:O'
  });
  const rows = res.data.values || [];
  const todayStr = new Date().toISOString().split('T')[0];

  // Construir mapa ID → {stage, notas, stageSince, lastExternalContact, externalChannel, prevStage, clientResponded}
  const existingMap = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const id = row[0] || '';
    if (id) existingMap[id] = {
      stage: row[8] || 'N/A',
      notas: row[9] || '',
      stageSince: row[10] || '',
      lastExternalContact: row[11] || '',
      externalChannel: row[12] || '',
      prevStage: row[13] || null,
      clientResponded: row[14] || ''
    };
  }

  // Construir filas nuevas preservando columnas manuales (stage, notas, stageSince, L, M, O)
  const newRows = enriched.map(contact => {
    const id = generateClientId(contact.name, contact.consultant);
    const existing = existingMap[id];
    const stage = existing ? existing.stage : 'N/A';
    const notas = existing ? existing.notas : '';
    // Comparar stage actual (col I, puesto por el usuario) contra prevStage (col N, guardado en el run anterior)
    const stageSince = (existing && existing.stageSince && stage === existing.prevStage)
      ? existing.stageSince
      : todayStr;
    const lastExternalContact = existing ? existing.lastExternalContact : '';
    const externalChannel = existing ? existing.externalChannel : '';
    const clientResponded = existing ? existing.clientResponded : '';
    const lastContact = contact.lastContact ? new Date(contact.lastContact).toLocaleDateString('en-US') : '';
    return [
      id, contact.name, contact.consultant,
      contact.jobStatus || '', contact.typeOfClient || '',
      contact.phase || '', contact.activeDays || '',
      lastContact, stage, notas, stageSince,
      lastExternalContact, externalChannel, stage, clientResponded
    ];
  });

  const lastRow = Math.max(newRows.length + 1, rows.length);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: UPSELL_SHEET_ID,
    range: 'Upsell Tracker!A2:O' + lastRow
  });

  if (newRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: UPSELL_SHEET_ID,
      range: 'Upsell Tracker!A2:O' + (newRows.length + 1),
      valueInputOption: 'RAW',
      requestBody: { values: newRows }
    });
  }
  console.log('Upsell Tracker sincronizado: ' + newRows.length + ' clientes.');

  // Retornar mapa completo para que main() lo use
  const returnMap = {};
  newRows.forEach(r => {
    if (r[0]) returnMap[r[0]] = {
      stage: r[8], notas: r[9], stageSince: r[10],
      lastExternalContact: r[11], externalChannel: r[12],
      clientResponded: r[14] || ''
    };
  });
  return returnMap;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m + 1}, (_, i) =>
    Array.from({length: n + 1}, (_, j) => j === 0 ? i : i === 0 ? j : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

const NICKNAMES = {
  'joe':'joseph','joseph':'joe','mike':'michael','michael':'mike',
  'bob':'robert','robert':'bob','bill':'william','william':'bill',
  'will':'william','jim':'james','james':'jim','tom':'thomas','thomas':'tom',
  'dan':'daniel','daniel':'dan','dave':'david','david':'dave',
  'chris':'christopher','christopher':'chris','matt':'matthew','matthew':'matt',
  'alex':'alexander','alexander':'alex','nick':'nicholas','nicholas':'nick',
  'sam':'samuel','samuel':'sam','ben':'benjamin','benjamin':'ben',
  'liz':'elizabeth','elizabeth':'liz','kate':'katherine','katherine':'kate',
  'andy':'andrew','andrew':'andy','tony':'anthony','anthony':'tony',
  'rick':'richard','richard':'rick','rich':'richard','ed':'edward','edward':'ed',
  'rob':'robert','ron':'ronald','ronald':'ron','pat':'patrick','patrick':'pat',
  'vince':'vincent','vincent':'vince','steve':'steven','steven':'steve',
  'stephen':'steve','greg':'gregory','gregory':'greg','jeff':'jeffrey','jeffrey':'jeff',
  'ken':'kenneth','kenneth':'ken','brad':'bradley','bradley':'brad'
};

function wordSimilar(w1, w2) {
  if (w1 === w2) return true;
  if (NICKNAMES[w1] === w2 || NICKNAMES[w2] === w1) return true;
  const maxLen = Math.max(w1.length, w2.length);
  if (maxLen < 4) return false;
  return levenshtein(w1, w2) <= Math.floor(maxLen * 0.25);
}

function fuzzyMatch(name1, name2) {
  if (!name1 || !name2) return 0;
  const clean = s => s.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\bjr\b|\bsr\b|\bii\b|\biii\b/g, '')
    .trim();
  const n1 = clean(name1);
  const n2 = clean(name2);
  if (n1 === n2) return 1;
  const words1 = n1.split(' ').filter(w => w.length > 1);
  const words2 = n2.split(' ').filter(w => w.length > 1);
  if (words1.length === 0 || words2.length === 0) return 0;

  let matchCount = 0;
  const used = new Set();
  for (const w1 of words1) {
    for (let j = 0; j < words2.length; j++) {
      if (used.has(j)) continue;
      if (wordSimilar(w1, words2[j])) { matchCount++; used.add(j); break; }
    }
  }

  const total = Math.max(words1.length, words2.length);
  const shorter = Math.min(words1.length, words2.length);
  let score = matchCount / total;
  // Si todos los palabras del nombre más corto hicieron match, boost a 0.75
  if (matchCount === shorter && shorter >= 2) score = Math.max(score, 0.75);
  return score;
}

const JOB_TITLE_KEYWORDS = new Set([
  'setter', 'assistant', 'manager', 'coordinator', 'specialist', 'representative',
  'developer', 'designer', 'strategist', 'caller', 'recruiter', 'bookkeeper',
  'accountant', 'copywriter', 'architect', 'analyst', 'editor', 'closer',
  'consultant', 'officer', 'engineer', 'writer', 'buyer', 'researcher', 'expert',
  'advisor', 'director', 'operator', 'associate', 'creator', 'host', 'producer',
  'rep', 'csr', 'sdr', 'bdr', 'va', 'ea', 'moderator', 'recruiter', 'sourcer'
]);

function extractClientName(jobName) {
  if (!jobName) return '';
  const parts = jobName.split(/ ?- /);
  if (parts.length <= 1) return jobName.trim();
  const lastPart = parts[parts.length - 1].trim();
  const lastWords = lastPart.toLowerCase().replace(/[()\/]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const lastIsJobTitle = lastWords.some(w => JOB_TITLE_KEYWORDS.has(w));
  return lastIsJobTitle ? parts[0].trim() : lastPart;
}

const API_HOST = 'generatygs-mateo-production.up.railway.app';

function apiRequest(method, path, cb) {
  const opts = {
    hostname: API_HOST, path, method,
    headers: { 'Accept': 'application/json', 'Content-Length': 0 }
  };
  let raw = '';
  const req = https.request(opts, res => {
    res.on('data', d => raw += d);
    res.on('end', () => { try { cb(null, JSON.parse(raw)); } catch(e) { cb(e); } });
  });
  req.setTimeout(30000, () => { req.destroy(); cb(new Error('request timeout')); });
  req.on('error', cb);
  req.end();
}

function fetchFromAPI() {
  return new Promise((resolve, reject) => {
    // Step 1: trigger a fresh refresh
    console.log('Triggering Railway data refresh...');
    apiRequest('POST', '/api/refresh', (err, body) => {
      if (err) return reject(err);
      console.log('Refresh triggered:', body.message || JSON.stringify(body));

      // Step 2: poll /api/status every 30s until ready (max 20 min)
      const startedAt = Date.now();
      const MAX_WAIT = 20 * 60 * 1000;
      let attempt = 0;

      function poll() {
        if (Date.now() - startedAt > MAX_WAIT) return reject(new Error('API refresh timed out after 20 min'));
        attempt++;
        console.log('Polling status... (attempt ' + attempt + ')');
        apiRequest('GET', '/api/status', (err, status) => {
          if (err) { console.log('Poll error:', err.message, '— retrying in 30s'); setTimeout(poll, 30000); return; }
          console.log('Status:', JSON.stringify(status));
          if (status.isRefreshing || !status.ready) {
            setTimeout(poll, 30000);
          } else {
            // Step 3: fetch the cached data
            console.log('Data ready — fetching...');
            apiRequest('GET', '/api/data', (err, result) => {
              if (err) return reject(err);
              if (!result.success) return reject(new Error(result.error || 'API error'));
              console.log('Received ' + result.count + ' contacts from API.');
              resolve(result.data);
            });
          }
        });
      }
      // Wait 30s before first poll to give the server time to start processing
      setTimeout(poll, 30000);
    });
  });
}

async function main() {
  console.log('Generating unified dashboard...');

  // Fetch all enriched data from Railway API (pipeline runs server-side, ~5 min)
  const enriched = await fetchFromAPI();
  console.log('Loaded ' + enriched.length + ' contacts from API.');

  if (false) { // legacy local pipeline — kept for reference, not executed
  // 1. Get GHL data
  let allContacts = [];
  for (var i = 0; i < CONSULTANTS.length; i++) {
    var consultant = CONSULTANTS[i];
    await new Promise(function(resolve) {
      processConsultant(consultant, function(results) {
        allContacts = allContacts.concat(results);
        resolve();
      });
    });
  }
  console.log('GHL: ' + allContacts.length + ' contacts loaded.');

  // 2. Get Check-ins data
  console.log('Loading check-ins sheet...');
  const checkinRows = await getSheetData(CHECKINS_SHEET_ID, 'Form Responses 1!A:Z');
  const checkinHeaders = checkinRows[0] || [];
  const colIdx = {};
  checkinHeaders.forEach((h, i) => { if (h) colIdx[h.trim()] = i; });

  // Group check-ins by client name
  const checkinsByClient = {};
  for (let r = 1; r < checkinRows.length; r++) {
    const row = checkinRows[r];
    const clientName = row[colIdx['Client Name']] || '';
    const timestamp = row[colIdx['Timestamp']] || '';
    const showedUp = row[colIdx['Did the Client Show Up?']] || '';
    const checkinType = row[colIdx['Type of Check-in']] || '';
    const nextStep = row[colIdx['Next expected step']] || row[colIdx['Next Expected Step']] || '';
    const upsellStatus = row[colIdx['Upsell Status']] || '';
    const candidateStatus = row[colIdx['Candidate Status']] || '';
    const meetingDate = row[colIdx['Date Of Meeting']] || '';
    if (!clientName) continue;
    if (!checkinsByClient[clientName]) checkinsByClient[clientName] = [];
    checkinsByClient[clientName].push({
      timestamp, showedUp, checkinType, nextStep,
      upsellStatus, candidateStatus, meetingDate
    });
  }

  // 3. Get RCRM data
  console.log('Loading RCRM sheet...');
  const rcrmRows = await getSheetData(RCRM_SHEET_ID, 'RCRM Data Pull!A:AH');
  const rcrmHeaders = rcrmRows[0] || [];
  const rcrmIdx = {};
  rcrmHeaders.forEach((h, i) => { if (h) rcrmIdx[h.trim()] = i; });

  const rcrmClients = [];
  for (let r = 1; r < rcrmRows.length; r++) {
    const row = rcrmRows[r];
    const jobName = row[rcrmIdx['Job Name']] || '';
    // Skip rows without a client name (job name has no " - " or "- " separator)
    if (!jobName.match(/ ?- /)) continue;
    const clientName = extractClientName(jobName);
    const jobParts = jobName.split(/ ?- /);
    const clientNameAlt = jobParts.length > 1 ? jobParts[0].trim() : '';
    rcrmClients.push({
      clientName,
      clientNameAlt,
      jobName,
      jobStatus: row[rcrmIdx['Job Status']] || '',
      typeOfClient: row[rcrmIdx['Type of Client']] || '',
      jobTeam: row[rcrmIdx['Job Team']] || '',
      activeDays: row[rcrmIdx['Active Days']] || '',
      candidatesPresented: row[rcrmIdx['Candidates Presented']] || '',
      createdOn: row[rcrmIdx['Created on']] || '',
      closedJobAt: row[rcrmIdx['Closed Job At']] || '',
      updatedOn: row[rcrmIdx['Updated On']] || '',
      createdBy: row[rcrmIdx['Created By']] || ''
    });
  }

  // 4. Cross-reference all data
  console.log('Cross-referencing data...');
  const now = new Date();

  // Build GHL lookup map by contact name: keep most recent entry for weekly/contact fields,
  // but merge allOutbound from ALL conversations so m3 metrics see the full history
  const ghlByName = {};
  for (const c of allContacts) {
    const existing = ghlByName[c.name];
    if (!existing) {
      ghlByName[c.name] = Object.assign({}, c, { allOutbound: (c.allOutbound || []).slice() });
    } else {
      // Always merge allOutbound from every conversation
      existing.allOutbound = (existing.allOutbound || []).concat(c.allOutbound || []);
      // Update the rest of the fields only if this conversation is more recent
      if (c.lastContact && (!existing.lastContact || new Date(c.lastContact) > new Date(existing.lastContact))) {
        existing.lastContact = c.lastContact;
        existing.daysSince = c.daysSince;
        existing.type = c.type;
        existing.weekly = c.weekly;
        existing.contactId = c.contactId;
      }
    }
  }

  // Group RCRM rows by client name (normalized), excluding internal non-clients
  const EXCLUDED_CLIENTS = ['omer bloch', 'esteban andrade'];
  const rcrmByClient = {};
  for (const rc of rcrmClients) {
    const key = rc.clientName.toLowerCase().trim();
    if (EXCLUDED_CLIENTS.includes(key)) continue;
    if (!rcrmByClient[key]) rcrmByClient[key] = { clientName: rc.clientName, jobs: [] };
    rcrmByClient[key].jobs.push(rc);
  }

  // Merge pass: combine entries that are likely the same client (score >= 0.5 + same team)
  let mergeChanged = true;
  while (mergeChanged) {
    mergeChanged = false;
    const entries = Object.entries(rcrmByClient);
    outerMerge: for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [keyA, entryA] = entries[i];
        const [keyB, entryB] = entries[j];
        if (!rcrmByClient[keyA] || !rcrmByClient[keyB]) continue;
        const score = fuzzyMatch(entryA.clientName, entryB.clientName);
        const wordsA = entryA.clientName.replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/).filter(w => w.length > 1);
        const wordsB = entryB.clientName.replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/).filter(w => w.length > 1);
        const minThreshold = (wordsA.length === 1 || wordsB.length === 1) ? 0.5 : 0.75;
        if (score < minThreshold) continue;
        const teamsA = new Set(entryA.jobs.map(j => j.jobTeam).filter(Boolean));
        const teamsB = new Set(entryB.jobs.map(j => j.jobTeam).filter(Boolean));
        if (teamsA.size === 0 || teamsB.size === 0) continue;
        if (![...teamsA].some(t => teamsB.has(t))) continue;
        // Merge: keep the longer (more complete) name
        const keepKey = entryA.clientName.length >= entryB.clientName.length ? keyA : keyB;
        const dropKey = keepKey === keyA ? keyB : keyA;
        rcrmByClient[keepKey].jobs.push(...rcrmByClient[dropKey].jobs);
        delete rcrmByClient[dropKey];
        mergeChanged = true;
        break outerMerge;
      }
    }
  }

  const JOB_TEAM_HC    = { 'Team 1': 'Matt Chavez', 'Team 2': 'Paola Sella', 'Team 3': 'Mateo Cortazar' };
  const HC_COLOR       = { 'Matt Chavez': '#06b6d4', 'Paola Sella': '#10b981', 'Mateo Cortazar': '#6366f1', 'Unassigned': '#94a3b8' };
  const STATUS_PRIORITY = ['Open', 'Pending to be launched', 'On Hold', 'Client Unresponsive', 'Closed', 'Canceled'];

  const enriched = Object.values(rcrmByClient).map(rcrmEntry => {
    const { clientName, jobs } = rcrmEntry;

    // Assign HC from Job Team
    const jobTeam = (jobs.find(j => j.jobTeam) || {}).jobTeam || '';
    const consultantName  = JOB_TEAM_HC[jobTeam] || 'Unassigned';
    const consultantColor = HC_COLOR[consultantName];

    // Find best GHL match by fuzzy name
    let ghlMatch = null;
    let bestGHLScore = 0;
    for (const [gname, gdata] of Object.entries(ghlByName)) {
      const score = fuzzyMatch(clientName, gname);
      if (score > bestGHLScore && score >= 0.6) { bestGHLScore = score; ghlMatch = gdata; }
    }

    // Find check-in match
    let checkinMatch = null, bestCheckinName = null;
    let bestCheckinScore = 0;
    for (const cName of Object.keys(checkinsByClient)) {
      const score = fuzzyMatch(clientName, cName);
      if (score > bestCheckinScore && score >= 0.6) { bestCheckinScore = score; checkinMatch = checkinsByClient[cName]; bestCheckinName = cName; }
    }

    // Process check-in data
    let totalCheckins = 0, lastCheckinDate = null, lastShowedUp = null;
    let lastCheckinType = null, lastNextStep = null, upsellStatus = null, noShows = 0;
    if (checkinMatch && checkinMatch.length > 0) {
      const attended = checkinMatch.filter(ck => ck.showedUp === 'Yes');
      totalCheckins = attended.length;
      noShows = checkinMatch.length - attended.length;
      const last = checkinMatch[checkinMatch.length - 1];
      lastCheckinDate = last.meetingDate || last.timestamp;
      lastShowedUp = last.showedUp;
      lastCheckinType = last.checkinType;
      lastNextStep = last.nextStep;
      upsellStatus = last.upsellStatus;
    }

    // Composite jobStatus
    let compositeStatus = null;
    for (const p of STATUS_PRIORITY) {
      if (jobs.some(j => j.jobStatus === p)) { compositeStatus = p; break; }
    }

    // Primary job: prefer Open, else first
    const primaryJob = jobs.find(j => j.jobStatus === 'Open') || jobs[0];

    // Calculate check-in phase
    let phase = null, nextCheckinDue = null, checkinStatus = null;
    const closedDate = primaryJob && primaryJob.closedJobAt ? new Date(primaryJob.closedJobAt) : null;
    if (closedDate && !isNaN(closedDate)) {
      const daysSinceClose = Math.floor((now - closedDate) / (1000 * 60 * 60 * 24));
      if (daysSinceClose <= 30) {
        phase = 'Month 1 (Weekly)';
        if (lastCheckinDate) { const d = Math.floor((now - new Date(lastCheckinDate)) / (1000*60*60*24)); nextCheckinDue = d <= 7 ? 'On track' : 'Overdue'; checkinStatus = d <= 7 ? 'green' : 'red'; }
        else { nextCheckinDue = 'No check-ins yet'; checkinStatus = 'red'; }
      } else if (daysSinceClose <= 60) {
        phase = 'Month 2 (Bi-Weekly)';
        if (lastCheckinDate) { const d = Math.floor((now - new Date(lastCheckinDate)) / (1000*60*60*24)); nextCheckinDue = d <= 14 ? 'On track' : 'Overdue'; checkinStatus = d <= 14 ? 'green' : 'red'; }
        else { nextCheckinDue = 'No check-ins yet'; checkinStatus = 'red'; }
      } else {
        phase = 'Month 3+ (Monthly)';
        if (lastCheckinDate) { const d = Math.floor((now - new Date(lastCheckinDate)) / (1000*60*60*24)); nextCheckinDue = d <= 30 ? 'On track' : 'Overdue'; checkinStatus = d <= 30 ? 'green' : 'red'; }
        else { nextCheckinDue = 'No check-ins yet'; checkinStatus = 'red'; }
      }
    }

    // Phase attempts/convos: GHL calls/SMS + check-ins since phase start
    // Upsell tracker contribution added after tracker sync in main()
    let m3attempts = null;
    let m3convos = null;
    if (closedDate && !isNaN(closedDate)) {
      const phaseOffset = phase === 'Month 3+ (Monthly)' ? 61 : phase === 'Month 2 (Bi-Weekly)' ? 31 : 0;
      const m3Start = new Date(closedDate);
      m3Start.setDate(m3Start.getDate() + phaseOffset);
      const ghlOutbound = ghlMatch ? (ghlMatch.allOutbound || []) : [];
      const m3msgs = ghlOutbound.filter(m => new Date(m.dateAdded) >= m3Start);
      // Check-ins since Month 3+ start (any check-in = attempt; showed up = conversation)
      const m3checkinAll = checkinMatch ? checkinMatch.filter(ck => {
        const ckDate = parseFlexDate(ck.meetingDate || ck.timestamp);
        return ckDate && ckDate >= m3Start;
      }) : [];
      m3attempts = m3msgs.length + m3checkinAll.length;
      const m3callConvos = m3msgs.filter(m =>
        m.messageType === 'TYPE_CALL' && m.meta &&
        ((m.meta.duration || 0) >= 120 || (m.meta.call && (m.meta.call.duration || 0) >= 120))
      ).length;
      const m3checkinConvos = m3checkinAll.filter(ck => ck.showedUp === 'Yes').length;
      m3convos = m3callConvos + m3checkinConvos;
    }

    return {
      name: clientName,
      contactId: ghlMatch ? ghlMatch.contactId : null,
      consultant: consultantName,
      consultantColor,
      lastContact: ghlMatch ? ghlMatch.lastContact : null,
      daysSince: ghlMatch ? ghlMatch.daysSince : null,
      type: ghlMatch ? ghlMatch.type : null,
      jobs,
      jobStatus: compositeStatus,
      typeOfClient: primaryJob ? primaryJob.typeOfClient : null,
      activeDays: primaryJob ? primaryJob.activeDays : null,
      candidatesPresented: primaryJob ? primaryJob.candidatesPresented : null,
      closedJobAt: primaryJob ? primaryJob.closedJobAt : null,
      daysSincePlacement: primaryJob && primaryJob.closedJobAt ? Math.floor((now - new Date(primaryJob.closedJobAt)) / (1000*60*60*24)) : null,
      updatedOn: primaryJob ? primaryJob.updatedOn : null,
      totalCheckins, lastCheckinDate, lastShowedUp, lastCheckinType, lastNextStep,
      upsellStatus, phase, nextCheckinDue, checkinStatus,
      latestComment: null, latestCommentDate: null, latestCommentSource: null,
      rcrmMatched: true,
      noShows: noShows || 0, checkinMatched: checkinMatch !== null,
      checkinMatchedName: bestCheckinName,
      weeklyGHL: ghlMatch ? (ghlMatch.weekly || null) : null,
      m3attempts, m3convos
    };
  });

  enriched.sort((a, b) => {
    if (!a.lastContact) return 1;
    if (!b.lastContact) return -1;
    return new Date(b.lastContact) - new Date(a.lastContact);
  });

  // Build check-in name → { hc, id } map — reuses the fuzzy match already done above
  const checkinNameToContact = {};
  for (const c of enriched) {
    if (c.checkinMatchedName && !checkinNameToContact[c.checkinMatchedName]) {
      checkinNameToContact[c.checkinMatchedName] = {
        hc: c.consultant,
        id: generateClientId(c.name, c.consultant)
      };
    }
  }

  // 4b. Get GHL notes for each contact
  console.log('Loading GHL notes...');
  await new Promise(function(resolve) {
    let i = 0;
    function next() {
      if (i >= enriched.length) { resolve(); return; }
      const contact = enriched[i++];
      if (!contact.contactId) { next(); return; }
      getContactNotes(contact.contactId, function(note) {
        // Compare GHL note date vs check-in nextStep date
        const ghlDate = note ? new Date(note.dateAdded) : null;
        const ckDate = contact.lastCheckinDate ? new Date(contact.lastCheckinDate) : null;
        
        if (ghlDate && ckDate) {
          if (ghlDate >= ckDate) {
            contact.latestComment = note.body;
            contact.latestCommentDate = note.dateAdded;
            contact.latestCommentSource = 'GHL Note';
          } else {
            contact.latestComment = contact.lastNextStep;
            contact.latestCommentDate = contact.lastCheckinDate;
            contact.latestCommentSource = 'Check-in';
          }
        } else if (ghlDate) {
          contact.latestComment = note.body;
          contact.latestCommentDate = note.dateAdded;
          contact.latestCommentSource = 'GHL Note';
        } else if (contact.lastNextStep) {
          contact.latestComment = contact.lastNextStep;
          contact.latestCommentDate = contact.lastCheckinDate;
          contact.latestCommentSource = 'Check-in';
        }
        if (i % 20 === 0) console.log('  Notes: ' + i + '/' + enriched.length);
        next();
      });
    }
    next();
  });

  // 5. Sync Upsell Tracker BEFORE generating HTML so stage data is available
  console.log('Syncing Upsell Tracker...');
  const upsellSheets = await getSheets();
  await setupSheetIfEmpty(upsellSheets);
  await applyUpsellStyle(upsellSheets);
  await handleClosedUpsells(upsellSheets);
  const trackerMap = await syncUpsellSheet(upsellSheets, enriched);

  // Merge tracker stages into enriched contacts
  const todayStr = new Date().toISOString().split('T')[0];
  enriched.forEach(contact => {
    const id = generateClientId(contact.name, contact.consultant);
    const entry = trackerMap[id];
    const trackerStage = entry ? entry.stage : 'N/A';
    if (trackerStage && trackerStage !== 'N/A') {
      contact.upsellStage = trackerStage;
      contact.upsellStageSince = entry.stageSince || todayStr;
    } else {
      contact.upsellStage = 'N/A';
      contact.upsellStageSince = null;
    }
    contact.upsellNotes = entry ? entry.notas : '';
    contact.daysInStage = contact.upsellStageSince ?
      Math.floor((new Date() - new Date(contact.upsellStageSince)) / (1000*60*60*24)) : null;

    // COSA 2: Merge external contact data from tracker
    contact.lastExternalContact = entry ? entry.lastExternalContact : '';
    contact.externalChannel = entry ? entry.externalChannel : '';

    // Calculate best contact from all 4 sources: SMS/Call GHL, Check-in, External
    const sources = [];
    if (contact.lastContact) {
      sources.push({ dateStr: contact.lastContact, type: contact.type === 'TYPE_SMS' ? 'SMS' : 'Call', date: parseFlexDate(contact.lastContact) });
    }
    if (contact.lastCheckinDate) {
      sources.push({ dateStr: contact.lastCheckinDate, type: 'Check-in', date: parseFlexDate(contact.lastCheckinDate) });
    }
    if (contact.lastExternalContact) {
      sources.push({ dateStr: contact.lastExternalContact, type: contact.externalChannel || 'External', date: parseFlexDate(contact.lastExternalContact) });
    }
    if (sources.length > 0) {
      sources.sort((a, b) => b.date - a.date);
      contact.bestContactDate = sources[0].dateStr;
      contact.bestContactType = sources[0].type;
      contact.bestDaysWithoutContact = Math.floor((new Date() - sources[0].date) / 86400000);
    } else {
      contact.bestContactDate = null;
      contact.bestContactType = null;
      contact.bestDaysWithoutContact = null;
    }

    // Add upsell tracker contribution (lastExternalContact + clientResponded)
    if (contact.m3attempts !== null && contact.closedJobAt) {
      const phaseOffset = contact.phase === 'Month 3+ (Monthly)' ? 61 : contact.phase === 'Month 2 (Bi-Weekly)' ? 31 : 0;
      const m3Start = new Date(contact.closedJobAt);
      m3Start.setDate(m3Start.getDate() + phaseOffset);
      if (contact.lastExternalContact && parseFlexDate(contact.lastExternalContact) >= m3Start) {
        contact.m3attempts++;
      }
      const crid = generateClientId(contact.name, contact.consultant);
      const crEntry = trackerMap[crid];
      if (crEntry && crEntry.clientResponded) {
        contact.m3attempts++;
        if (crEntry.clientResponded === 'Yes') contact.m3convos++;
      }
    }
  });
  } // end if (false) — legacy local pipeline

  // 6. Generate HTML
  const html = generateHTML(enriched);
  fs.writeFileSync('/Users/mateocortazar/ghl-dashboard/index.html', html);
  // Export CSV
  const csvHeaders = ['Name','HC','Status','Type','Active Days','Last SMS/Call','Days w/o Contact','Contact Type','Check-ins','No Shows','Last Check-in','Showed Up','Phase','Next Check-in','Upsell','Latest Comment','Latest Comment Source'];
  const csvRows = enriched.map(c => [
    c.name,
    c.consultant,
    c.jobStatus || '',
    c.typeOfClient || '',
    c.activeDays || '',
    c.lastContact ? new Date(c.lastContact).toLocaleDateString('en-US') : '',
    c.daysSince !== null ? c.daysSince : '',
    c.type === 'TYPE_SMS' ? 'SMS' : c.type === 'TYPE_CALL' ? 'Call' : '',
    c.totalCheckins || 0,
    c.noShows || 0,
    c.lastCheckinDate ? new Date(c.lastCheckinDate).toLocaleDateString('en-US') : '',
    c.lastShowedUp || '',
    c.phase || '',
    c.nextCheckinDue || '',
    c.upsellStage || c.upsellStatus || '',
    (c.latestComment || '').replace(/,/g, ';').replace(/\n/g, ' '),
    c.latestCommentSource || ''
  ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
  
  const csv = [csvHeaders.join(','), ...csvRows].join('\n');
  fs.writeFileSync('/Users/mateocortazar/ghl-dashboard/data.csv', csv);
  console.log('CSV exported: /Users/mateocortazar/ghl-dashboard/data.csv');

  console.log('Done! ' + enriched.length + ' contacts total.');

  await updateLocalTargets();
  await deployToGitHub();
}

async function updateLocalTargets() {
  try {
    const sheets = await getSheets();
    const HC_UNIQUE_TARGET_CELL = { 'Matt Chavez': 'C9', 'Paola Sella': 'G9', 'Mateo Cortazar': 'K9' };
    const HCS = ['Matt Chavez', 'Paola Sella', 'Mateo Cortazar'];
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: HC_METRICS_ID,
      ranges: HCS.map(hc => 'WEEKLY TRACKER!' + HC_UNIQUE_TARGET_CELL[hc])
    });
    const hcTargets = {};
    HCS.forEach((hc, i) => {
      const raw = (res.data.valueRanges[i]?.values?.[0]?.[0]) ?? 0;
      hcTargets[hc] = parseInt(raw) || 0;
    });
    fs.writeFileSync('/Users/mateocortazar/ghl-dashboard/hc_targets.json', JSON.stringify(hcTargets, null, 2));
    console.log('hc_targets.json actualizado:', JSON.stringify(hcTargets));
  } catch (err) {
    console.error('Error actualizando hc_targets.json (no bloquea el deploy):', err.message);
  }
}

async function updateHCMetricsTracker(sheets, enriched, checkinsByClient, checkinNameToContact) {
  const HC_CONFIG_COL = { 'Matt Chavez': 'C', 'Paola Sella': 'D', 'Mateo Cortazar': 'E' };
  const HC_ACTUAL_COL = { 'Matt Chavez': 'D', 'Paola Sella': 'H', 'Mateo Cortazar': 'L' };
  const HCS = ['Matt Chavez', 'Paola Sella', 'Mateo Cortazar'];

  try {
    console.log('Actualizando HC Metrics Tracker...');

    const weekStart = getCurrentWeekStart();
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6); // lunes a domingo
    weekEnd.setHours(23, 59, 59, 999);

    function isThisWeek(dateStr) {
      if (!dateStr) return false;
      const d = new Date(dateStr);
      return !isNaN(d) && d >= weekStart && d <= weekEnd;
    }

    // Read Upsell Tracker A:O for stage, stageSince, lastExternalContact, clientResponded
    const upsellRes = await sheets.spreadsheets.values.get({
      spreadsheetId: UPSELL_SHEET_ID,
      range: 'Upsell Tracker!A:O'
    });
    const upsellRows = upsellRes.data.values || [];
    const upsellMap = {};
    for (let i = 1; i < upsellRows.length; i++) {
      const r = upsellRows[i];
      const id = r[0]; if (!id) continue;
      upsellMap[id] = {
        hc:                  r[2]  || '',
        stage:               r[8]  || '',
        stageSince:          r[10] || '',
        lastExternalContact: r[11] || '',
        clientResponded:     r[14] || ''
      };
    }

    // ── PART 1: CONFIG — portfolio counts (rows 22–26) ───────────────────
    const cfg = {};
    HCS.forEach(hc => { cfg[hc] = { month1: 0, month2: 0, month3: 0, noPhase: 0, onHold: 0, canceled: 0 }; });

    for (const c of enriched) {
      const hc = c.consultant;
      if (!cfg[hc]) continue;
      if (c.jobStatus === 'Closed') {
        if      (c.phase === 'Month 1 (Weekly)')    cfg[hc].month1++;
        else if (c.phase === 'Month 2 (Bi-Weekly)') cfg[hc].month2++;
        else if (c.phase === 'Month 3+ (Monthly)')  cfg[hc].month3++;
        else                                         cfg[hc].noPhase++;
      } else if (c.jobStatus === 'On Hold') {
        cfg[hc].onHold++;
      } else if (c.jobStatus === 'Canceled') {
        cfg[hc].canceled++;
      }
    }


    const configData = [];
    HCS.forEach(hc => {
      const col = HC_CONFIG_COL[hc];
      configData.push(
        { range: `CONFIG!${col}22`, values: [[cfg[hc].month1]] },
        { range: `CONFIG!${col}23`, values: [[cfg[hc].month2]] },
        { range: `CONFIG!${col}24`, values: [[cfg[hc].month3]] },
        { range: `CONFIG!${col}25`, values: [[cfg[hc].noPhase]] },
        { range: `CONFIG!${col}26`, values: [[cfg[hc].onHold]] }
      );
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: HC_METRICS_ID,
      requestBody: { valueInputOption: 'RAW', data: configData }
    });
    console.log('  CONFIG: portfolio actualizado.');

    // ── PART 1B: WEEKLY TRACKER + MONTHLY SUMMARY — dynamic targets ──────
    // Team fixed targets (work backwards from $40K/month)
    const TEAM = {
      convosWeek:   52,   pitchesWeek:  13,   dealsMonth:  17,  revenueWeek: 9300,
      convosMonth: 222,   pitchesMonth: 56,   revenueMonth: 40000
    };
    // Active clients per HC (exclude OnHold)
    const activeMap = {};
    HCS.forEach(hc => {
      const c = cfg[hc];
      activeMap[hc] = c.month1 + c.month2 + c.month3 + c.noPhase;
    });
    const totalActive = HCS.reduce((sum, hc) => sum + activeMap[hc], 0);

    // Read unique-clients-per-week target directly from the tracker (C9, G9, K9).
    // Single source of truth: whatever the HC Metrics Tracker shows is what the Monday list uses.
    const HC_UNIQUE_TARGET_CELL = { 'Matt Chavez': 'C9', 'Paola Sella': 'G9', 'Mateo Cortazar': 'K9' };
    const targetReads = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: HC_METRICS_ID,
      ranges: HCS.map(hc => `WEEKLY TRACKER!${HC_UNIQUE_TARGET_CELL[hc]}`),
    });
    const hcTargets = {};
    HCS.forEach((hc, i) => {
      const raw = (targetReads.data.valueRanges[i]?.values?.[0]?.[0]) ?? 0;
      hcTargets[hc] = parseInt(raw) || 0;
    });
    fs.writeFileSync('/Users/mateocortazar/ghl-dashboard/hc_targets.json', JSON.stringify(hcTargets, null, 2));
    console.log('  TARGETS: hc_targets.json →', JSON.stringify(hcTargets));

    const HC_TARGET_WEEKLY  = { 'Matt Chavez': 'C', 'Paola Sella': 'G', 'Mateo Cortazar': 'K' };
    const HC_TARGET_MONTHLY = { 'Matt Chavez': 'C', 'Paola Sella': 'K', 'Mateo Cortazar': 'S' };

    // Formulas that reference CONFIG tab — auto-recalculate when portfolio changes
    const mattA  = '(CONFIG!C22+CONFIG!C23+CONFIG!C24+CONFIG!C25)';
    const paolaA = '(CONFIG!D22+CONFIG!D23+CONFIG!D24+CONFIG!D25)';
    const mateoA = '(CONFIG!E22+CONFIG!E23+CONFIG!E24+CONFIG!E25)';
    const totalA = `(${mattA}+${paolaA}+${mateoA})`;
    const propFormulas = { 'Matt Chavez': mattA, 'Paola Sella': paolaA, 'Mateo Cortazar': mateoA };

    const dynData = [];
    HCS.forEach(hc => {
      const p = propFormulas[hc];
      const wCol = HC_TARGET_WEEKLY[hc];
      const mCol = HC_TARGET_MONTHLY[hc];
      dynData.push(
        { range: `WEEKLY TRACKER!${wCol}12`,  values: [[`=ROUND(${p}/${totalA}*${TEAM.convosWeek})`]]   },
        { range: `WEEKLY TRACKER!${wCol}13`,  values: [[`=ROUND(${p}/${totalA}*${TEAM.pitchesWeek})`]]  },
        { range: `WEEKLY TRACKER!${wCol}14`,  values: [[`=ROUND(${p}/${totalA}*${TEAM.dealsMonth})`]]   },
        { range: `WEEKLY TRACKER!${wCol}16`,  values: [[`=ROUND(${p}/${totalA}*${TEAM.revenueWeek})`]]  },
        { range: `MONTHLY SUMMARY!${mCol}12`, values: [[`=ROUND(${p}/${totalA}*${TEAM.convosMonth})`]]  },
        { range: `MONTHLY SUMMARY!${mCol}13`, values: [[`=ROUND(${p}/${totalA}*${TEAM.pitchesMonth})`]] },
        { range: `MONTHLY SUMMARY!${mCol}14`, values: [[`=ROUND(${p}/${totalA}*${TEAM.dealsMonth})`]]   },
        { range: `MONTHLY SUMMARY!${mCol}16`, values: [[`=ROUND(${p}/${totalA}*${TEAM.revenueMonth})`]] }
      );
    });
    // Team totals — hardcoded (always the full $40K targets)
    dynData.push(
      { range: 'WEEKLY TRACKER!O12',   values: [[TEAM.convosWeek]]    },
      { range: 'WEEKLY TRACKER!O13',   values: [[TEAM.pitchesWeek]]   },
      { range: 'WEEKLY TRACKER!O14',   values: [[TEAM.dealsMonth]]    },
      { range: 'WEEKLY TRACKER!O16',   values: [[TEAM.revenueWeek]]   },
      { range: 'MONTHLY SUMMARY!AA12', values: [[TEAM.convosMonth]]   },
      { range: 'MONTHLY SUMMARY!AA13', values: [[TEAM.pitchesMonth]]  },
      { range: 'MONTHLY SUMMARY!AA14', values: [[TEAM.dealsMonth]]    },
      { range: 'MONTHLY SUMMARY!AA16', values: [[TEAM.revenueMonth]]  }
    );
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: HC_METRICS_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: dynData }
    });
    console.log('  TARGETS: fórmulas escritas (auto-calculan desde CONFIG).');

    // ── PART 2: WEEKLY TRACKER — actual metrics ──────────────────────────
    const m = {};
    HCS.forEach(hc => {
      m[hc] = {
        uniqueClients: new Set(),  // row 9
        outreachCount: 0,          // row 10
        realConvs:     new Set(),  // row 12
        pitchClients:  new Set(),  // row 13
        dealsClients:  new Set(),  // row 14
        checkinsYes:   0,          // row 18
        checkinsNo:    0,          // row 19
        seqLaunched:   new Set(),  // row 23
        seqConnected:  new Set()   // row 24
      };
    });

    // Pre-compute clients with real conversation this week (upsell responded OR check-in showed up)
    const hadConvThisWeek = new Set();
    for (const [id, entry] of Object.entries(upsellMap)) {
      if (isThisWeek(entry.lastExternalContact) && entry.clientResponded === 'Yes') {
        hadConvThisWeek.add(id);
      }
    }
    for (const [ckName, checkinsArr] of Object.entries(checkinsByClient)) {
      const info = checkinNameToContact[ckName];
      if (!info) continue;
      for (const ck of checkinsArr) {
        const dateStr = ck.meetingDate || ck.timestamp;
        if (isThisWeek(dateStr) && ck.showedUp === 'Yes') {
          hadConvThisWeek.add(info.id);
        }
      }
    }

    // GHL outbound activity this week (per enriched contact)
    for (const c of enriched) {
      const hc = c.consultant;
      if (!m[hc] || !c.weeklyGHL) continue;
      const wk = c.weeklyGHL;
      const id = generateClientId(c.name, c.consultant);
      const hasGHLContact = (wk.smsCount + wk.callCount) > 0;

      if (hasGHLContact) {
        m[hc].uniqueClients.add(id);
        m[hc].outreachCount += wk.smsCount + wk.callCount;
      }
      if (wk.hadCallWith2min) m[hc].realConvs.add(id);

      // Sequences: Month 3+ only
      // Launched = answered ≥1 call OR ≥5 unanswered calls this week
      // Connected = launched + real conv (call≥2min, check-in showed up, or log contact responded)
      const isSeqPhase = !c.phase || c.phase === 'Month 3+ (Monthly)';
      if (isSeqPhase && wk.callCount > 0) {
        const answered = wk.hadCallWith2min;
        const launched = answered || wk.callCount >= 5;
        if (launched) {
          m[hc].seqLaunched.add(id);
          if (answered || hadConvThisWeek.has(id)) {
            m[hc].seqConnected.add(id);
          }
        }
      }
    }

    // Upsell Tracker: external contacts + stage changes this week
    const pitchedStages = new Set(['Pitched', 'Active', 'Closed']);
    for (const [id, entry] of Object.entries(upsellMap)) {
      const hc = entry.hc;
      if (!m[hc]) continue;

      // External Log Contact this week
      if (isThisWeek(entry.lastExternalContact)) {
        m[hc].uniqueClients.add(id);
        m[hc].outreachCount++;
        if (entry.clientResponded === 'Yes') m[hc].realConvs.add(id);
      }

      // Pitch opened this week (stage moved to Pitched/Active/Closed this week)
      if (pitchedStages.has(entry.stage) && isThisWeek(entry.stageSince)) {
        m[hc].pitchClients.add(id);
      }

      // Deal closed this week
      if (entry.stage === 'Closed' && isThisWeek(entry.stageSince)) {
        m[hc].dealsClients.add(id);
      }
    }

    // Check-ins this week (showed up = Yes → real conversation; any check-in = unique contact)
    for (const [ckName, checkinsArr] of Object.entries(checkinsByClient)) {
      const info = checkinNameToContact[ckName];
      if (!info) continue;
      const { hc, id } = info;
      if (!m[hc]) continue;

      for (const ck of checkinsArr) {
        const dateStr = ck.meetingDate || ck.timestamp;
        if (!isThisWeek(dateStr)) continue;

        m[hc].uniqueClients.add(id); // any check-in = contact this week
        if (ck.showedUp === 'Yes') {
          m[hc].checkinsYes++;
          m[hc].realConvs.add(id);
        } else if (ck.showedUp === 'No') {
          m[hc].checkinsNo++;
        }
      }
    }

    // Write WEEKLY TRACKER actuals (only ACTUAL columns, never touches TARGET or VS formulas)
    const weeklyData = [];
    HCS.forEach(hc => {
      const col = HC_ACTUAL_COL[hc];
      const h = m[hc];
      weeklyData.push(
        { range: `WEEKLY TRACKER!${col}9`,  values: [[h.uniqueClients.size]] },
        { range: `WEEKLY TRACKER!${col}10`, values: [[h.outreachCount]]       },
        { range: `WEEKLY TRACKER!${col}12`, values: [[h.realConvs.size]]      },
        { range: `WEEKLY TRACKER!${col}13`, values: [[h.pitchClients.size]]   },
        { range: `WEEKLY TRACKER!${col}14`, values: [[h.dealsClients.size]]   },
        { range: `WEEKLY TRACKER!${col}18`, values: [[h.checkinsYes]]         },
        { range: `WEEKLY TRACKER!${col}19`, values: [[h.checkinsNo]]          },
        { range: `WEEKLY TRACKER!${col}23`, values: [[h.seqLaunched.size]]    },
        { range: `WEEKLY TRACKER!${col}24`, values: [[h.seqConnected.size]]   }
      );
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: HC_METRICS_ID,
      requestBody: { valueInputOption: 'RAW', data: weeklyData }
    });

    const wkLabel = weekStart.toISOString().split('T')[0] + ' → ' + weekEnd.toISOString().split('T')[0];
    console.log('  WEEKLY TRACKER: semana ' + wkLabel + ' actualizada.');

    // Quick summary log
    HCS.forEach(hc => {
      const h = m[hc]; const col = HC_CONFIG_COL[hc];
      const c = cfg[hc];
      console.log('  [' + hc + '] Portfolio: M1=' + c.month1 + ' M2=' + c.month2 + ' M3+=' + c.month3 +
        ' Cold=' + c.noPhase + ' OnHold=' + c.onHold +
        ' | Week: clients=' + h.uniqueClients.size + ' outreach=' + h.outreachCount +
        ' convos=' + h.realConvs.size + ' pitches=' + h.pitchClients.size +
        ' deals=' + h.dealsClients.size);
      console.log('    uniqueClients: ' + JSON.stringify([...h.uniqueClients]));
      console.log('    realConvs:     ' + JSON.stringify([...h.realConvs]));
    });

  } catch (err) {
    console.error('Error en updateHCMetricsTracker (no bloquea el deploy):', err.message || err);
  }
}

async function deployToGitHub() {
  const dir = '/Users/mateocortazar/ghl-dashboard';
  const repoUrl = 'https://' + GITHUB_TOKEN + '@github.com/mcortazar14/HC-dashboard.git';
  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: 'inherit' });

  try {
    if (!fs.existsSync(dir + '/.git')) {
      // Primera vez: inicializar repo
      console.log('Inicializando repositorio git...');
      run('git init');
      run('git config user.name "HC Dashboard"');
      run('git config user.email "dashboard@remote-latinos.com"');
      run('git checkout -b gh-pages');
      run('git remote add origin ' + repoUrl);
    } else {
      // Actualizar remote URL por si el token cambió
      try { run('git remote set-url origin ' + repoUrl); }
      catch(e) { run('git remote add origin ' + repoUrl); }
    }

    // Agregar index.html al staging
    run('git add index.html');

    // Verificar si hay cambios reales para commitear
    let hasStagedChanges = false;
    try { execSync('git diff --cached --quiet', { cwd: dir }); }
    catch(e) { hasStagedChanges = true; }

    if (!hasStagedChanges) {
      console.log('Sin cambios en index.html — deploy omitido.');
      return;
    }

    run('git commit -m "Dashboard update - ' + now + '"');

    // Primer push usa --force; los siguientes son normales
    const isFirstPush = !fs.existsSync(dir + '/.git/refs/remotes/origin/gh-pages');
    if (isFirstPush) {
      console.log('Primer push a GitHub Pages (--force)...');
      run('git push --force origin gh-pages');
    } else {
      run('git push origin gh-pages');
    }

    console.log('Dashboard publicado en: https://mcortazar14.github.io/HC-dashboard/');
  } catch(e) {
    console.error('Error en deploy a GitHub Pages:', e.message || e);
  }
}

function generateHTML(contacts) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dataJson = JSON.stringify(contacts);
  const total = contacts.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Remote Latinos — HC Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', system-ui, sans-serif; background: #08090f; color: #e2e8f0; min-height: 100vh; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: #0d1117; }
::-webkit-scrollbar-thumb { background: #1a2540; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #2a3a5c; }
tr.data-row:hover td { background: #1a2235 !important; }
.tab-btn { transition: all .2s; }
.tab-btn.active { background: linear-gradient(135deg, #6366f1, #8b5cf6) !important; color: white !important; border-color: transparent !important; }
.hc-btn.active { color: white !important; }
#hc-all.active { background: #6366f1 !important; border-color: #6366f1 !important; }
#hc-mateo.active { background: #6366f1 !important; border-color: #6366f1 !important; }
#hc-matt.active { background: #06b6d4 !important; border-color: #06b6d4 !important; }
#hc-jorge.active { background: #10b981 !important; border-color: #10b981 !important; }
.phase-btn.active { color: white !important; background: #8b5cf6 !important; border-color: #8b5cf6 !important; }
</style>
</head>
<body>

<!-- Header -->
<div style="background:linear-gradient(180deg,#0d1424 0%,#08090f 100%);border-bottom:1px solid #1a2540;padding:24px 32px 20px">
  <div style="max-width:1600px;margin:0 auto">
    <h1 style="font-size:22px;font-weight:800;color:white;letter-spacing:-.3px">Remote Latinos <span style="color:#6366f1">—</span> HC Dashboard</h1>
    <p style="font-size:12px;color:#475569;margin-top:4px">Last updated: ${dateStr} &nbsp;·&nbsp; ${total} records</p>
  </div>
</div>

<!-- HC Filter -->
<div style="background:#0d1117;border-bottom:1px solid #1a2540;padding:12px 32px">
  <div style="max-width:1600px;margin:0 auto;display:flex;align-items:center;gap:8px">
    <span style="font-size:11px;color:#475569;margin-right:4px;text-transform:uppercase;letter-spacing:.5px">Filter HC:</span>
    <button id="hc-all" class="hc-btn active" onclick="setHC('all')" style="background:#6366f1;border:1px solid #6366f1;color:white;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">All</button>
    <button id="hc-mateo" class="hc-btn" onclick="setHC('Mateo Cortazar')" style="background:#0f1520;border:1px solid #6366f144;color:#6366f1;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Mateo</button>
    <button id="hc-matt" class="hc-btn" onclick="setHC('Matt Chavez')" style="background:#0f1520;border:1px solid #06b6d444;color:#06b6d4;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Matt</button>
    <button id="hc-paola" class="hc-btn" onclick="setHC('Paola Sella')" style="background:#0f1520;border:1px solid #10b98144;color:#10b981;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Paola</button>
  </div>
</div>

<!-- Tab Navigation -->
<div style="background:#0d1117;border-bottom:1px solid #1a2540;padding:0 32px">
  <div style="max-width:1600px;margin:0 auto;display:flex;gap:2px;padding-top:8px">
    <button id="btn-open" class="tab-btn" onclick="showTab('open')" style="padding:10px 20px;border-radius:8px 8px 0 0;border:1px solid transparent;background:transparent;color:#64748b;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-bottom:-1px">Open Clients</button>
    <button id="btn-closed" class="tab-btn" onclick="showTab('closed')" style="padding:10px 20px;border-radius:8px 8px 0 0;border:1px solid transparent;background:transparent;color:#64748b;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-bottom:-1px">Closed Clients</button>
    <button id="btn-upsell" class="tab-btn" onclick="showTab('upsell')" style="padding:10px 20px;border-radius:8px 8px 0 0;border:1px solid transparent;background:transparent;color:#64748b;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-bottom:-1px">Upsell Pipeline</button>
    <button id="btn-paused" class="tab-btn" onclick="showTab('paused')" style="padding:10px 20px;border-radius:8px 8px 0 0;border:1px solid transparent;background:transparent;color:#64748b;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-bottom:-1px">Paused / Inactive</button>
    <button id="btn-pending" class="tab-btn" onclick="showTab('pending')" style="padding:10px 20px;border-radius:8px 8px 0 0;border:1px solid transparent;background:transparent;color:#64748b;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-bottom:-1px">Pending Launch</button>
  </div>
</div>

<!-- Content -->
<div style="max-width:1600px;margin:0 auto;padding:28px 32px">

  <!-- Tab: Open Clients -->
  <div id="tab-open" class="tab-pane">
    <div id="cards-open"></div>
    <div id="table-open"></div>
  </div>

  <!-- Tab: Closed Clients -->
  <div id="tab-closed" class="tab-pane" style="display:none">
    <div id="phase-filter-bar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
      <span style="color:#64748b;font-size:12px;font-weight:600;margin-right:4px">Phase:</span>
      <button id="phase-all" class="phase-btn active" onclick="setPhase('all')" style="background:#8b5cf6;border:1px solid #8b5cf6;color:white;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">All</button>
      <button id="phase-m1" class="phase-btn" onclick="setPhase('Month 1 (Weekly)')" style="background:#0f1520;border:1px solid #8b5cf644;color:#8b5cf6;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Month 1</button>
      <button id="phase-m2" class="phase-btn" onclick="setPhase('Month 2 (Bi-Weekly)')" style="background:#0f1520;border:1px solid #8b5cf644;color:#8b5cf6;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Month 2</button>
      <button id="phase-m3" class="phase-btn" onclick="setPhase('Month 3+ (Monthly)')" style="background:#0f1520;border:1px solid #8b5cf644;color:#8b5cf6;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Month 3+</button>
      <button id="phase-none" class="phase-btn" onclick="setPhase('none')" style="background:#0f1520;border:1px solid #94a3b844;color:#94a3b8;padding:5px 14px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">No Phase</button>
    </div>
    <div id="cards-closed"></div>
    <div id="table-closed"></div>
  </div>

  <!-- Tab: Upsell Pipeline -->
  <div id="tab-upsell" class="tab-pane" style="display:none">
    <div id="funnel-upsell"></div>
    <div id="cards-upsell"></div>
    <div id="table-upsell"></div>
  </div>

  <!-- Tab: Paused / Inactive -->
  <div id="tab-paused" class="tab-pane" style="display:none">
    <div id="cards-paused"></div>
    <div id="paused-sections"></div>
  </div>

  <!-- Tab: Pending Launch -->
  <div id="tab-pending" class="tab-pane" style="display:none">
    <div id="cards-pending"></div>
    <div id="table-pending"></div>
  </div>

</div>

<script>
var data = ${dataJson};
var activeHC = 'all';
var activePhase = 'all';
var activeTab = 'open';
var cardFilters = {open: null, closed: null, upsell: null, paused: null, pending: null};

function toggleJobs(id) {
  var row = document.getElementById(id);
  var btn = document.getElementById('btn-' + id);
  if (!row) return;
  var isHidden = row.style.display === 'none';
  row.style.display = isHidden ? 'table-row' : 'none';
  if (btn) btn.textContent = isHidden
    ? btn.textContent.replace('\u25b6', '\u25bc')
    : btn.textContent.replace('\u25bc', '\u25b6');
}

function parseFlexDate(s) {
  if (!s) return null;
  if (/^\\d{4}-\\d{2}-\\d{2}T/.test(s)) return new Date(s);
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) { var p=s.split('-'); return new Date(+p[0],+p[1]-1,+p[2],12,0,0); }
  var m=s.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/);
  if (m) return new Date(+m[3],+m[1]-1,+m[2],12,0,0);
  return new Date(s);
}
function fmtDate(d) {
  if (!d) return '\u2014';
  var dt = parseFlexDate(d);
  if (!dt || isNaN(dt)) return '\u2014';
  return dt.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'2-digit'});
}

function dsSince(d) {
  if (!d) return null;
  return Math.floor((new Date() - new Date(d)) / 86400000);
}

function mostRecent(d1, d2) {
  if (!d1 && !d2) return null;
  if (!d1) return d2;
  if (!d2) return d1;
  return new Date(d1) >= new Date(d2) ? d1 : d2;
}

function recentSrc(c) {
  if (!c.lastContact && !c.lastCheckinDate) return null;
  if (!c.lastContact) return 'Check-in';
  if (!c.lastCheckinDate) return c.type === 'TYPE_SMS' ? 'SMS' : 'Call';
  return new Date(c.lastContact) >= new Date(c.lastCheckinDate) ? (c.type === 'TYPE_SMS' ? 'SMS' : 'Call') : 'Check-in';
}

function filterHC(arr) {
  if (activeHC === 'all') return arr;
  return arr.filter(function(c) { return c.consultant === activeHC; });
}
function filterPhase(arr) {
  if (activePhase === 'all') return arr;
  if (activePhase === 'none') return arr.filter(function(c) { return !c.phase || c.phase === ''; });
  return arr.filter(function(c) { return c.phase === activePhase; });
}

function priorityBorder(idx, total) {
  var pct = idx / total;
  if (pct < 0.33) return '3px solid #ef4444';
  if (pct < 0.66) return '3px solid #f97316';
  return '3px solid #22c55e';
}

function priorityDot(idx, total) {
  var pct = idx / total;
  var color = pct < 0.33 ? '#ef4444' : pct < 0.66 ? '#f97316' : '#22c55e';
  return '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + color + ';margin-right:6px"></span>';
}

var HC_COLORS = {'Mateo Cortazar':'#6366f1','Matt Chavez':'#06b6d4','Paola Sella':'#10b981'};
var STAGE_ORDER = {Active:0,Pitched:1,Detected:2,Seeded:3,Closed:4};

function hcPill(c) {
  var col = HC_COLORS[c.consultant] || '#94a3b8';
  return '<span style="background:' + col + '15;color:' + col + ';border:1px solid ' + col + '40;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">' + (c.consultant ? c.consultant.split(' ')[0] : '') + '</span>';
}

function stageBadge(s) {
  var styles = {
    'N/A':      'background:#111827;color:#6b7280;border:1px solid #1f2937',
    'Seeded':   'background:#1e0547;color:#c084fc;border:1px solid #4c1d95',
    'Detected': 'background:#431407;color:#fdba74;border:1px solid #9a3412',
    'Pitched':  'background:#431407;color:#fb923c;border:1px solid #c2410c',
    'Active':   'background:#0c1a3d;color:#60a5fa;border:1px solid #1e3a8a',
    'Closed':   'background:#052e16;color:#4ade80;border:1px solid #166534'
  };
  var st = styles[s] || styles['N/A'];
  return '<span style="' + st + ';padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700">' + (s||'N/A') + '</span>';
}

function ckStatusBadge(c) {
  if (!c.phase) return '<span style="background:#111827;color:#6b7280;border:1px solid #1f2937;padding:2px 8px;border-radius:6px;font-size:11px">\u2014</span>';
  if (c.checkinStatus === 'green') return '<span style="background:#052e16;color:#4ade80;border:1px solid #166534;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600">On Track</span>';
  if (c.checkinStatus === 'red') return '<span style="background:#450a0a;color:#f87171;border:1px solid #7f1d1d;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600">Overdue</span>';
  return '<span style="background:#111827;color:#6b7280;border:1px solid #1f2937;padding:2px 8px;border-radius:6px;font-size:11px">No data</span>';
}

function activeDaysBadge(d) {
  if (!d) return '<span style="color:#475569">\u2014</span>';
  var n = parseInt(d);
  var col = n > 60 ? '#f87171' : n >= 30 ? '#fb923c' : '#60a5fa';
  return '<b style="color:' + col + ';font-size:13px">' + d + 'd</b>';
}

function daysContactBadge(n) {
  if (n === null || n === undefined) return '<span style="color:#475569">\u2014</span>';
  var st = n > 30 ? 'background:#450a0a;color:#f87171;border:1px solid #7f1d1d' :
           n > 14 ? 'background:#431407;color:#fb923c;border:1px solid #9a3412' :
                    'background:#052e16;color:#4ade80;border:1px solid #166534';
  return '<span style="' + st + ';padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600">' + n + 'd</span>';
}

function m3attCell(c) {
  if (c.m3attempts === null || c.m3attempts === undefined) return '<span style="color:#475569">\u2014</span>';
  if (c.m3attempts >= 10 && (c.m3convos === 0 || c.m3convos === null)) return '<b style="color:#ef4444">' + c.m3attempts + '</b>';
  return '<span style="color:#94a3b8">' + c.m3attempts + '</span>';
}
function m3conCell(c) {
  if (c.m3convos === null || c.m3convos === undefined) return '<span style="color:#475569">\u2014</span>';
  if (c.m3convos > 0) return '<b style="color:#22c55e">' + c.m3convos + '</b>';
  return '<span style="color:#6b7280">0</span>';
}

function srcBadge(src) {
  if (!src) return '';
  var cols = {
    'Check-in': 'background:#052e16;color:#4ade80',
    'Call':     'background:#0c1a3d;color:#60a5fa',
    'SMS':      'background:#083344;color:#67e8f9',
    'WhatsApp': 'background:#14271a;color:#a3e635',
    'Email':    'background:#2d1f00;color:#fbbf24',
    'Slack':    'background:#1e0547;color:#c084fc'
  };
  var col = cols[src] || 'background:#111827;color:#94a3b8';
  return ' <span style="' + col + ';padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600">' + src + '</span>';
}

function bestCell(c) {
  var d = c.bestContactDate || mostRecent(c.lastContact, c.lastCheckinDate);
  var t = c.bestContactType || recentSrc(c);
  if (!d) return '<span style="color:#475569">\u2014</span>';
  return fmtDate(d) + srcBadge(t);
}

function comment(c, maxLen) {
  if (!c.latestComment) return '<span style="color:#475569">\u2014</span>';
  var ml = maxLen || 70;
  var txt = c.latestComment.substring(0, ml);
  if (c.latestComment.length > ml) txt += '\u2026';
  return '<span style="color:#94a3b8;font-size:11px" title="[' + (c.latestCommentSource||'') + '] ' + c.latestComment.replace(/"/g,"'") + '">' + txt + '</span>';
}

function statusBadge(s) {
  if (!s) return '<span style="color:#475569">\u2014</span>';
  var styles = {
    'Open':'background:#052e16;color:#4ade80;border:1px solid #166534',
    'Closed':'background:#0c1a3d;color:#60a5fa;border:1px solid #1e3a8a',
    'On Hold':'background:#431407;color:#fb923c;border:1px solid #9a3412',
    'Client Unresponsive':'background:#450a0a;color:#f87171;border:1px solid #7f1d1d',
    'Canceled':'background:#111827;color:#6b7280;border:1px solid #1f2937',
    'Pending to be launched':'background:#1e0547;color:#c084fc;border:1px solid #4c1d95'
  };
  return '<span style="' + (styles[s]||styles['Closed']) + ';padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600">' + s + '</span>';
}

function mkCard(tabKey, filterKey, label, value, color, subtitle) {
  var isActive = cardFilters[tabKey] === filterKey;
  var border = isActive ? '1.5px solid ' + color : '1px solid #1a2540';
  var shadow = isActive ? '0 0 18px ' + color + '44' : 'none';
  var subHtml = subtitle ? '<div style="font-size:11px;color:#475569;margin-top:2px">' + subtitle + '</div>' : '';
  var q = String.fromCharCode(39);
  var onclick = 'setCardFilter(' + q + tabKey + q + ',' + q + filterKey + q + ')';
  return '<div onclick="' + onclick + '" ' +
    'style="background:linear-gradient(135deg,#0f1420,#141928);border:' + border + ';border-radius:12px;padding:16px 20px;min-width:120px;flex:1;cursor:pointer;transition:all .2s;box-shadow:' + shadow + ';border-left:3px solid ' + color + '">' +
    '<div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">' + label + '</div>' +
    '<div style="font-size:30px;font-weight:800;color:' + color + ';line-height:1">' + value + '</div>' +
    subHtml + '</div>';
}

function setCardFilter(tab, key) {
  cardFilters[tab] = cardFilters[tab] === key ? null : key;
  renderAll();
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-pane').forEach(function(p) { p.style.display = 'none'; });
  document.getElementById('tab-' + tab).style.display = 'block';
  document.getElementById('btn-' + tab).classList.add('active');
}

function setHC(hc) {
  activeHC = hc;
  document.querySelectorAll('.hc-btn').forEach(function(b) { b.classList.remove('active'); });
  var id = hc === 'all' ? 'hc-all' : 'hc-' + hc.split(' ')[0].toLowerCase();
  var el = document.getElementById(id);
  if (el) el.classList.add('active');
  renderAll();
}
function setPhase(phase) {
  activePhase = phase;
  document.querySelectorAll('.phase-btn').forEach(function(b) { b.classList.remove('active'); });
  var idMap = {'all':'phase-all','Month 1 (Weekly)':'phase-m1','Month 2 (Bi-Weekly)':'phase-m2','Month 3+ (Monthly)':'phase-m3','none':'phase-none'};
  var el = document.getElementById(idMap[phase]);
  if (el) el.classList.add('active');
  renderClosed();
}

var sortState = {
  open:    {col: null, dir: -1},
  closed:  {col: null, dir: -1},
  upsell:  {col: null, dir: -1},
  paused:  {col: null, dir: -1},
  pending: {col: null, dir: -1}
};
function sortTable(tab, col) {
  var s = sortState[tab];
  if (s.col === col) {
    if (s.dir === -1) { s.dir = 1; }
    else { s.col = null; s.dir = -1; } // 3er clic = reset
  } else { s.col = col; s.dir = -1; }  // 1er clic = descendente
  renderAll();
}
function sortVal(c, col) {
  if (col === 'lastCheckinDate')   return c.lastCheckinDate   ? new Date(c.lastCheckinDate).getTime()   : 0;
  if (col === 'bestContactDate')   return c.bestContactDate   ? new Date(c.bestContactDate).getTime()   : 0;
  if (col === 'daysSincePlacement')return parseFloat(c.daysSincePlacement) || 0;
  if (col === '_daysNoContact')    return (c._daysNoContact  !== null && c._daysNoContact  !== undefined) ? c._daysNoContact  : -1;
  if (col === 'daysInStage')       return (c.daysInStage     !== null && c.daysInStage     !== undefined) ? c.daysInStage     : -1;
  if (col === '_doh')              return (c._doh            !== null && c._doh            !== undefined) ? c._doh            : -1;
  if (col === '_dwr')              return (c._dwr            !== null && c._dwr            !== undefined) ? c._dwr            : -1;
  if (col === 'checkinStatus')     return c.checkinStatus === 'red' ? 0 : c.checkinStatus === 'green' ? 1 : 2;
  var v = c[col]; return (v === null || v === undefined) ? '' : v;
}
function applyColSort(rows, tab) {
  var s = sortState[tab];
  if (!s || !s.col) return;
  var col = s.col, dir = s.dir;
  rows.sort(function(a, b) {
    var va = sortVal(a, col), vb = sortVal(b, col);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function renderAll() {
  renderOpen();
  renderClosed();
  renderUpsell();
  renderPaused();
  renderPending();
}

function theadTh(label, col, tab) {
  var s = (tab && sortState[tab]) ? sortState[tab] : {col: null, dir: -1};
  var sortIcon = col ? ((s.col === col) ? (s.dir === -1 ? ' \u2193' : ' \u2191') : ' \u2195') : '';
  var extra = col ? 'cursor:pointer;user-select:none;' : '';
  var q = String.fromCharCode(39);
  var onclick = col ? 'onclick="sortTable(' + q + tab + q + ',' + q + col + q + ')"' : '';
  return '<th ' + onclick + ' style="background:#0a0e1a;padding:10px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#475569;white-space:nowrap;position:sticky;top:0;z-index:10;' + extra + '">' + label + sortIcon + '</th>';
}

function tdCell(content, extra) {
  return '<td style="padding:10px 14px;border-bottom:1px solid #0d1117;vertical-align:middle;' + (extra||'') + '">' + content + '</td>';
}

function renderOpen() {
  var base = filterHC(data.filter(function(c) { return c.jobStatus === 'Open'; }));
  base.sort(function(a,b) { return (parseFloat(b.activeDays)||0) - (parseFloat(a.activeDays)||0); });

  var total = base.length;
  var newC = base.filter(function(c) { return c.typeOfClient === 'New Client'; }).length;
  var ret = base.filter(function(c) { return (c.typeOfClient||'').toLowerCase().indexOf('return') > -1; }).length;
  var rep = base.filter(function(c) { return (c.typeOfClient||'').toLowerCase().indexOf('replace') > -1; }).length;

  document.getElementById('cards-open').innerHTML =
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">' +
    mkCard('open','all','Total Open', total, '#6366f1') +
    mkCard('open','new','New Clients', newC, '#60a5fa') +
    mkCard('open','returning','Returning', ret, '#34d399') +
    mkCard('open','replacement','Replacements', rep, '#f472b6') +
    '</div>';

  var rows = base;
  var cf = cardFilters['open'];
  if (cf && cf !== 'all') {
    if (cf === 'new') rows = rows.filter(function(c) { return c.typeOfClient === 'New Client'; });
    else if (cf === 'returning') rows = rows.filter(function(c) { return (c.typeOfClient||'').toLowerCase().indexOf('return') > -1; });
    else if (cf === 'replacement') rows = rows.filter(function(c) { return (c.typeOfClient||'').toLowerCase().indexOf('replace') > -1; });
  }

  var html = '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540">' +
    '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr>' +
    theadTh('#') + theadTh('Client','name') + theadTh('HC') + theadTh('Type') +
    theadTh('Active Days','activeDays','open') + theadTh('Candidates','candidatesPresented','open') +
    theadTh('Check-ins','totalCheckins','open') + theadTh('No-shows','noShows','open') +
    theadTh('Last Check-in','lastCheckinDate','open') + theadTh('Check-in Status','checkinStatus','open') + theadTh('Last Comment') +
    '</tr></thead><tbody>';

  applyColSort(rows, 'open');
  rows.forEach(function(c, i) {
    var border = priorityBorder(i, rows.length);
    var bg = i % 2 === 0 ? '#0f1520' : 'transparent';
    var typeTag = c.typeOfClient ? '<span style="background:#111827;color:#94a3b8;border:1px solid #1f2937;padding:2px 7px;border-radius:6px;font-size:11px">' + c.typeOfClient + '</span>' : '<span style="color:#475569">\u2014</span>';
    var noShow = (c.noShows||0) > 0 ? '<b style="color:#f87171">' + c.noShows + '</b>' : '<span style="color:#475569">0</span>';

    var openJobs = c.jobs ? c.jobs.filter(function(j) { return j.jobStatus === 'Open'; }) : [];
    var isMulti = openJobs.length > 1;
    var jobId = 'openjob-' + i;

    var nameHtml = '<b style="color:#e2e8f0">' + c.name + '</b>';
    if (isMulti) {
      nameHtml += '<br><button id="btn-' + jobId + '" data-jid="' + jobId + '" onclick="toggleJobs(this.dataset.jid)" style="margin-top:5px;background:#0d1a30;border:1px solid #1e3a5f;color:#7ba7d4;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">\u25bc ' + openJobs.length + ' jobs</button>';
    }

    var activeDaysCell = isMulti
      ? '<span style="color:#475569;font-style:italic;font-size:11px">see jobs \u2193</span>'
      : activeDaysBadge(c.activeDays);
    var candidatesCell = isMulti
      ? '<span style="color:#475569;font-style:italic;font-size:11px">see jobs \u2193</span>'
      : '<span style="color:#94a3b8">' + (c.candidatesPresented||'\u2014') + '</span>';

    html += '<tr style="background:' + bg + ';border-left:' + border + ';transition:background .15s" class="data-row">' +
      tdCell(priorityDot(i,rows.length) + '<span style="color:#475569">' + (i+1) + '</span>') +
      tdCell(nameHtml) +
      tdCell(hcPill(c)) +
      tdCell(typeTag) +
      tdCell(activeDaysCell) +
      tdCell(candidatesCell,'text-align:center') +
      tdCell('<span style="color:#e2e8f0">' + (c.totalCheckins||0) + '</span>','text-align:center') +
      tdCell(noShow,'text-align:center') +
      tdCell('<span style="color:#94a3b8">' + fmtDate(c.lastCheckinDate) + '</span>') +
      tdCell(ckStatusBadge(c)) +
      tdCell(comment(c,70)) +
      '</tr>';

    if (isMulti) {
      html += '<tr id="' + jobId + '" style="display:none"><td colspan="11" style="padding:0;border-bottom:1px solid #0d1117">';
      html += '<table style="width:100%;border-collapse:collapse">';
      openJobs.forEach(function(j) {
        var jName = j.jobName || '\u2014';
        var jDays = j.activeDays ? '<b style="color:' + (parseInt(j.activeDays)>60?'#f87171':parseInt(j.activeDays)>=30?'#fb923c':'#60a5fa') + ';font-size:13px">' + j.activeDays + 'd</b>' : '<span style="color:#475569">\u2014</span>';
        var jCands = j.candidatesPresented || '\u2014';
        html += '<tr style="background:#07111f">' +
          '<td style="padding:7px 14px 7px 52px;color:#64748b;font-size:11px;width:40px">\u2514</td>' +
          '<td style="padding:7px 14px;color:#94a3b8;font-size:11px;font-style:italic">' + jName + '</td>' +
          '<td style="padding:7px 14px;width:110px">' + jDays + '</td>' +
          '<td style="padding:7px 14px;color:#94a3b8;font-size:11px;text-align:center;width:100px">' + jCands + '</td>' +
          '<td colspan="7" style="padding:7px 14px"></td>' +
          '</tr>';
      });
      html += '</table></td></tr>';
    }
  });

  html += '</tbody></table></div>';
  html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + rows.length + ' clients shown</div>';
  document.getElementById('table-open').innerHTML = html;
}

function renderClosed() {
  var base = filterPhase(filterHC(data.filter(function(c) { return c.jobStatus === 'Closed'; })));

  base.forEach(function(c) {
    c._latestDate = c.bestContactDate || mostRecent(c.lastContact, c.lastCheckinDate);
    c._daysNoContact = (c.bestDaysWithoutContact !== null && c.bestDaysWithoutContact !== undefined)
      ? c.bestDaysWithoutContact
      : dsSince(c._latestDate);
  });

  // Separate Cold Leads: Month 3+, ≥10 attempts, 0 real conversations
  function isColdLead(c) {
    return c.phase === 'Month 3+ (Monthly)' && (c.m3attempts || 0) >= 10 && !(c.m3convos > 0);
  }
  var coldLeads = base.filter(isColdLead);
  base = base.filter(function(c) { return !isColdLead(c); });

  // Split: clients with contact data vs clients with no data at all
  var withData = base.filter(function(c) { return c._daysNoContact !== null && c._daysNoContact !== undefined; });
  var noData   = base.filter(function(c) { return c._daysNoContact === null || c._daysNoContact === undefined; });
  withData.sort(function(a,b) { return b._daysNoContact - a._daysNoContact; });

  var total    = base.length;
  var overdue  = withData.filter(function(c) { return c.checkinStatus === 'red'; }).length;
  var zeroChk  = withData.filter(function(c) { return !c.totalCheckins; }).length;
  var no30     = withData.filter(function(c) { return c._daysNoContact > 30; }).length;
  var noRecord = noData.length;

  document.getElementById('cards-closed').innerHTML =
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">' +
    mkCard('closed','all','Total Closed', total, '#60a5fa') +
    mkCard('closed','overdue','Overdue Check-ins', overdue, '#f87171') +
    mkCard('closed','zero','0 Check-ins', zeroChk, '#fb923c') +
    mkCard('closed','no30','No Contact +30d', no30, '#c084fc') +
    mkCard('closed','norecord','No Record', noRecord, '#94a3b8') +
    mkCard('closed','coldleads','Cold Leads', coldLeads.length, '#f59e0b') +
    '</div>';

  var cf = cardFilters['closed'];
  var mainRows  = withData;
  var showMain  = true;
  var showNoRec = (cf === null || cf === undefined || cf === 'all' || cf === 'norecord');
  var showCold  = (cf === null || cf === undefined || cf === 'all' || cf === 'coldleads');

  if (cf && cf !== 'all') {
    if      (cf === 'overdue')   { mainRows = withData.filter(function(c) { return c.checkinStatus === 'red'; }); showMain = true; showNoRec = false; showCold = false; }
    else if (cf === 'zero')      { mainRows = withData.filter(function(c) { return !c.totalCheckins; });          showMain = true; showNoRec = false; showCold = false; }
    else if (cf === 'no30')      { mainRows = withData.filter(function(c) { return c._daysNoContact > 30; });     showMain = true; showNoRec = false; showCold = false; }
    else if (cf === 'norecord')  { showMain = false; showNoRec = true;  showCold = false; }
    else if (cf === 'coldleads') { showMain = false; showNoRec = false; showCold = true;  }
  }

  function closedThead() {
    return '<thead><tr>' +
      theadTh('#') + theadTh('Client','name','closed') + theadTh('HC') + theadTh('Type') + theadTh('Phase') +
      theadTh('Days Since Placement','daysSincePlacement','closed') + theadTh('Check-ins','totalCheckins','closed') +
      theadTh('No-shows','noShows','closed') + theadTh('Last Check-in','lastCheckinDate','closed') +
      theadTh('Check-in Status','checkinStatus','closed') + theadTh('Last Contact','bestContactDate','closed') + theadTh('Days w/o Contact','_daysNoContact','closed') + theadTh('Attempts','m3attempts','closed') + theadTh('Convos','m3convos','closed') + theadTh('Last Comment') +
      '</tr></thead>';
  }

  var html = '';

  // ── Tabla principal (clientes con datos de contacto) ──────────────────────
  if (showMain) {
    applyColSort(mainRows, 'closed');
    html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      closedThead() + '<tbody>';

    mainRows.forEach(function(c, i) {
      var border = c._daysNoContact > 30 ? '3px solid #ef4444' : c._daysNoContact > 14 ? '3px solid #f97316' : '3px solid #22c55e';
      var bg = i % 2 === 0 ? '#0f1520' : 'transparent';
      var dsp = c.daysSincePlacement !== null ? c.daysSincePlacement + 'd' : '\u2014';
      var noShow = (c.noShows||0) > 0 ? '<b style="color:#f87171">' + c.noShows + '</b>' : '<span style="color:#475569">0</span>';
      html += '<tr style="background:' + bg + ';border-left:' + border + ';transition:background .15s" class="data-row">' +
        tdCell(priorityDot(i,mainRows.length) + '<span style="color:#475569">' + (i+1) + '</span>') +
        tdCell('<b style="color:#e2e8f0">' + c.name + '</b>') +
        tdCell(hcPill(c)) +
        tdCell('<span style="color:#94a3b8;font-size:11px">' + (c.typeOfClient||'\u2014') + '</span>') +
        tdCell('<span style="color:#94a3b8;font-size:11px">' + (c.phase||'\u2014') + '</span>') +
        tdCell('<b style="color:#60a5fa">' + dsp + '</b>') +
        tdCell('<span style="color:#e2e8f0">' + (c.totalCheckins||0) + '</span>','text-align:center') +
        tdCell(noShow,'text-align:center') +
        tdCell('<span style="color:#94a3b8">' + fmtDate(c.lastCheckinDate) + '</span>') +
        tdCell(ckStatusBadge(c)) +
        tdCell(bestCell(c)) +
        tdCell(daysContactBadge(c._daysNoContact)) +
        tdCell(m3attCell(c),'text-align:center') +
        tdCell(m3conCell(c),'text-align:center') +
        tdCell(comment(c,60),'white-space:nowrap;overflow:hidden;max-width:220px') +
        '</tr>';
    });

    html += '</tbody></table></div>';
    html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + mainRows.length + ' clients shown</div>';
  }

  // ── Sección "No Contact Record" ───────────────────────────────────────────
  if (showNoRec && noData.length > 0) {
    html += '<div style="display:flex;align-items:center;gap:12px;margin:36px 0 14px">' +
      '<div style="width:4px;height:22px;background:#d97706;border-radius:2px"></div>' +
      '<span style="font-size:13px;font-weight:700;color:#fbbf24">No Contact Record</span>' +
      '<span style="background:#1c1400;color:#d97706;border:1px solid #92400e;padding:1px 9px;border-radius:20px;font-size:11px">' + noData.length + '</span>' +
      '<span style="font-size:11px;color:#52525b">No contact data found in any source for these clients</span>' +
      '</div>';

    html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #292218">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      closedThead() + '<tbody>';

    noData.forEach(function(c, i) {
      var bg = i % 2 === 0 ? '#100f0a' : 'transparent';
      var dsp = c.daysSincePlacement !== null ? c.daysSincePlacement + 'd' : '\u2014';
      var noShow = (c.noShows||0) > 0 ? '<b style="color:#f87171">' + c.noShows + '</b>' : '<span style="color:#52525b">0</span>';
      var noRecBadge  = '<span style="background:#1c1c1c;color:#6b7280;border:1px solid #374151;padding:2px 9px;border-radius:6px;font-size:11px">No record</span>';
      var noDataBadge = '<span style="background:#1c1c1c;color:#6b7280;border:1px solid #374151;padding:2px 9px;border-radius:6px;font-size:11px">No data</span>';
      html += '<tr style="background:' + bg + ';transition:background .15s" class="data-row">' +
        tdCell('<span style="color:#52525b">' + (i+1) + '</span>') +
        tdCell('<span style="color:#a1a1aa;font-weight:600">' + c.name + '</span>') +
        tdCell(hcPill(c)) +
        tdCell('<span style="color:#52525b;font-size:11px">' + (c.typeOfClient||'\u2014') + '</span>') +
        tdCell('<span style="color:#52525b;font-size:11px">' + (c.phase||'\u2014') + '</span>') +
        tdCell('<span style="color:#60a5fa">' + dsp + '</span>') +
        tdCell('<span style="color:#71717a">' + (c.totalCheckins||0) + '</span>','text-align:center') +
        tdCell(noShow,'text-align:center') +
        tdCell('<span style="color:#52525b">' + fmtDate(c.lastCheckinDate) + '</span>') +
        tdCell(ckStatusBadge(c)) +
        tdCell(noRecBadge) +
        tdCell(noDataBadge) +
        tdCell('<span style="color:#475569">\u2014</span>','text-align:center') +
        tdCell('<span style="color:#475569">\u2014</span>','text-align:center') +
        tdCell(comment(c,60),'white-space:nowrap;overflow:hidden;max-width:220px') +
        '</tr>';
    });

    html += '</tbody></table></div>';
  }

  // ── Sección "Cold Leads" ─────────────────────────────────────────────────
  if (showCold && coldLeads.length > 0) {
    html += '<div style="display:flex;align-items:center;gap:12px;margin:36px 0 14px">' +
      '<div style="width:4px;height:22px;background:#f59e0b;border-radius:2px"></div>' +
      '<span style="font-size:13px;font-weight:700;color:#fbbf24">Cold Leads</span>' +
      '<span style="background:#1c1200;color:#f59e0b;border:1px solid #92400e;padding:1px 9px;border-radius:20px;font-size:11px">' + coldLeads.length + '</span>' +
      '<span style="font-size:11px;color:#52525b">Month 3+ · 10+ attempts · 0 real conversations</span>' +
      '</div>';

    coldLeads.sort(function(a,b) { return (b.m3attempts||0) - (a.m3attempts||0); });

    html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #2a2010">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      closedThead() + '<tbody>';

    coldLeads.forEach(function(c, i) {
      var bg = i % 2 === 0 ? '#0e1018' : 'transparent';
      var dsp = c.daysSincePlacement !== null ? c.daysSincePlacement + 'd' : '\u2014';
      var noShow = (c.noShows||0) > 0 ? '<b style="color:#f87171">' + c.noShows + '</b>' : '<span style="color:#52525b">0</span>';
      html += '<tr style="background:' + bg + ';border-left:3px solid #27272a;transition:background .15s" class="data-row">' +
        tdCell('<span style="color:#52525b">' + (i+1) + '</span>') +
        tdCell('<span style="color:#a1a1aa;font-weight:600">' + c.name + '</span>') +
        tdCell(hcPill(c)) +
        tdCell('<span style="color:#52525b;font-size:11px">' + (c.typeOfClient||'\u2014') + '</span>') +
        tdCell('<span style="color:#52525b;font-size:11px">' + (c.phase||'\u2014') + '</span>') +
        tdCell('<span style="color:#60a5fa">' + dsp + '</span>') +
        tdCell('<span style="color:#71717a">' + (c.totalCheckins||0) + '</span>','text-align:center') +
        tdCell(noShow,'text-align:center') +
        tdCell('<span style="color:#52525b">' + fmtDate(c.lastCheckinDate) + '</span>') +
        tdCell(ckStatusBadge(c)) +
        tdCell(bestCell(c)) +
        tdCell(daysContactBadge(c._daysNoContact)) +
        tdCell(m3attCell(c),'text-align:center') +
        tdCell(m3conCell(c),'text-align:center') +
        tdCell(comment(c,60),'white-space:nowrap;overflow:hidden;max-width:220px') +
        '</tr>';
    });

    html += '</tbody></table></div>';
    html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + coldLeads.length + ' cold leads</div>';
  }

  document.getElementById('table-closed').innerHTML = html;
}

function renderUpsell() {
  var now = new Date();
  var curMonth = now.getMonth(), curYear = now.getFullYear();
  var allUpsell = filterHC(data.filter(function(c) { return c.upsellStage && c.upsellStage !== 'N/A' && c.upsellStage !== ''; }));

  // Separate inactive stages from active pipeline
  var failedNeg     = allUpsell.filter(function(c) { return c.upsellStage === 'Failed Negotiation'; });
  var notInterested = allUpsell.filter(function(c) { return c.upsellStage === 'Not Interested'; });
  var base = allUpsell.filter(function(c) { return c.upsellStage !== 'Failed Negotiation' && c.upsellStage !== 'Not Interested'; });

  base.sort(function(a,b) {
    var oa = STAGE_ORDER[a.upsellStage] !== undefined ? STAGE_ORDER[a.upsellStage] : 99;
    var ob = STAGE_ORDER[b.upsellStage] !== undefined ? STAGE_ORDER[b.upsellStage] : 99;
    return oa - ob;
  });

  var stageColors = {Active:'#2563eb',Pitched:'#ea580c',Detected:'#d97706',Seeded:'#7c3aed',Closed:'#16a34a'};
  var stageCounts = {Active:0,Pitched:0,Detected:0,Seeded:0,Closed:0};
  base.forEach(function(c) { if (stageCounts[c.upsellStage] !== undefined) stageCounts[c.upsellStage]++; });
  var closedMonth = base.filter(function(c) {
    if (c.upsellStage !== 'Closed' || !c.upsellStageSince) return false;
    var d = new Date(c.upsellStageSince);
    return d.getMonth() === curMonth && d.getFullYear() === curYear;
  }).length;

  // Funnel: active stages only
  var stages = ['Active','Pitched','Detected','Seeded','Closed'];
  var funnelHtml = '<div style="display:flex;gap:3px;margin-bottom:24px;border-radius:12px;overflow:hidden;height:70px">';
  stages.forEach(function(s) {
    var cnt = stageCounts[s];
    if (!cnt) return;
    funnelHtml += '<div style="flex:' + cnt + ';background:' + stageColors[s] + ';display:flex;flex-direction:column;justify-content:center;padding:0 16px;min-width:70px">' +
      '<div style="font-size:9px;color:white;opacity:.75;text-transform:uppercase;letter-spacing:.5px">' + s + '</div>' +
      '<div style="font-size:24px;font-weight:800;color:white;line-height:1">' + cnt + '</div></div>';
  });
  var anyStage = stages.some(function(s) { return stageCounts[s] > 0; });
  if (!anyStage) {
    funnelHtml += '<div style="flex:1;background:#1a2540;display:flex;align-items:center;justify-content:center;color:#475569;font-size:13px">No upsell data yet</div>';
  }
  funnelHtml += '</div>';

  document.getElementById('funnel-upsell').innerHTML = funnelHtml;

  document.getElementById('cards-upsell').innerHTML =
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">' +
    mkCard('upsell','all','Pipeline', base.length, '#e2e8f0') +
    mkCard('upsell','Active','Active', stageCounts.Active, '#60a5fa') +
    mkCard('upsell','Pitched','Pitched', stageCounts.Pitched, '#fb923c') +
    mkCard('upsell','Detected','Detected', stageCounts.Detected, '#fde68a') +
    mkCard('upsell','Seeded','Seeded', stageCounts.Seeded, '#c084fc') +
    mkCard('upsell','closedmonth','Closed This Month', closedMonth, '#4ade80') +
    mkCard('upsell','failedneg','Failed Negotiation', failedNeg.length, '#f97316') +
    mkCard('upsell','notinterested','Not Interested', notInterested.length, '#6b7280') +
    '</div>';

  var cf = cardFilters['upsell'];
  var showMain = !cf || cf === 'all' || (cf !== 'failedneg' && cf !== 'notinterested');
  var showFailed  = !cf || cf === 'all' || cf === 'failedneg';
  var showNotInt  = !cf || cf === 'all' || cf === 'notinterested';
  if (cf === 'failedneg')     { showMain = false; showNotInt = false; }
  if (cf === 'notinterested') { showMain = false; showFailed = false; }

  var rows = base;
  if (showMain && cf && cf !== 'all') {
    if (cf === 'closedmonth') rows = rows.filter(function(c) {
      if (c.upsellStage !== 'Closed' || !c.upsellStageSince) return false;
      var d = new Date(c.upsellStageSince);
      return d.getMonth() === curMonth && d.getFullYear() === curYear;
    });
    else rows = rows.filter(function(c) { return c.upsellStage === cf; });
  }

  function upsellRow(c, i, bgEven) {
    var bg = i % 2 === 0 ? bgEven : 'transparent';
    var stageCol = stageColors[c.upsellStage] || '#475569';
    var ghlDate = c.bestContactDate ? bestCell(c) : '\u2014';
    var dis = c.daysInStage !== null && c.daysInStage !== undefined ? '<b style="color:' + stageCol + '">' + c.daysInStage + 'd</b>' : '\u2014';
    var notes = c.upsellNotes ? '<span style="color:#94a3b8;font-size:11px">' + c.upsellNotes.substring(0,60) + (c.upsellNotes.length > 60 ? '\u2026' : '') + '</span>' : '<span style="color:#475569">\u2014</span>';
    return '<tr style="background:' + bg + ';border-left:3px solid ' + stageCol + ';transition:background .15s" class="data-row">' +
      tdCell('<b style="color:#e2e8f0">' + c.name + '</b>') +
      tdCell(hcPill(c)) +
      tdCell(statusBadge(c.jobStatus)) +
      tdCell(stageBadge(c.upsellStage)) +
      tdCell(dis) +
      tdCell('<span style="color:#94a3b8">' + fmtDate(c.lastCheckinDate) + '</span>') +
      tdCell(ghlDate) +
      tdCell(notes) +
      '</tr>';
  }

  function upsellThead() {
    return '<thead><tr>' +
      theadTh('Client','name','upsell') + theadTh('HC') + theadTh('Job Status') + theadTh('Upsell Stage','upsellStage','upsell') +
      theadTh('Days in Stage','daysInStage','upsell') + theadTh('Last Check-in','lastCheckinDate','upsell') +
      theadTh('Last Contact','bestContactDate','upsell') + theadTh('HC Notes') +
      '</tr></thead>';
  }

  var html = '';

  // ── Pipeline activo ───────────────────────────────────────────────────────
  if (showMain) {
    applyColSort(rows, 'upsell');
    html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      upsellThead() + '<tbody>';
    rows.forEach(function(c, i) { html += upsellRow(c, i, '#0f1520'); });
    html += '</tbody></table></div>';
    html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + rows.length + ' clients shown</div>';
  }

  // ── Failed Negotiation ────────────────────────────────────────────────────
  if (showFailed && failedNeg.length > 0) {
    failedNeg.sort(function(a,b) { return (b.daysInStage||0) - (a.daysInStage||0); });
    html += '<div style="display:flex;align-items:center;gap:12px;margin:36px 0 14px">' +
      '<div style="width:4px;height:22px;background:#f97316;border-radius:2px"></div>' +
      '<span style="font-size:13px;font-weight:700;color:#fb923c">Failed Negotiation</span>' +
      '<span style="background:#1a0a00;color:#f97316;border:1px solid #7c2d12;padding:1px 9px;border-radius:20px;font-size:11px">' + failedNeg.length + '</span>' +
      '<span style="font-size:11px;color:#52525b">Revisit after 90 days \u2014 timing was not right</span>' +
      '</div>';
    html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #2a1a08">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      upsellThead() + '<tbody>';
    failedNeg.forEach(function(c, i) { html += upsellRow(c, i, '#120a00'); });
    html += '</tbody></table></div>';
    html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + failedNeg.length + ' clients</div>';
  }

  // ── Not Interested ────────────────────────────────────────────────────────
  if (showNotInt && notInterested.length > 0) {
    notInterested.sort(function(a,b) { return (b.daysInStage||0) - (a.daysInStage||0); });
    html += '<div style="display:flex;align-items:center;gap:12px;margin:36px 0 14px">' +
      '<div style="width:4px;height:22px;background:#6b7280;border-radius:2px"></div>' +
      '<span style="font-size:13px;font-weight:700;color:#9ca3af">Not Interested</span>' +
      '<span style="background:#111111;color:#6b7280;border:1px solid #374151;padding:1px 9px;border-radius:20px;font-size:11px">' + notInterested.length + '</span>' +
      '<span style="font-size:11px;color:#52525b">Archived — no intention to hire</span>' +
      '</div>';
    html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1f1f1f">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      upsellThead() + '<tbody>';
    notInterested.forEach(function(c, i) { html += upsellRow(c, i, '#0d0d0d'); });
    html += '</tbody></table></div>';
    html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + notInterested.length + ' clients</div>';
  }

  document.getElementById('table-upsell').innerHTML = html;
}

function renderPaused() {
  var all = filterHC(data.filter(function(c) { return c.jobStatus === 'On Hold' || c.jobStatus === 'Client Unresponsive' || c.jobStatus === 'Canceled'; }));
  // Pre-computar campos para ordenamiento
  all.forEach(function(c) {
    c._doh = dsSince(c.updatedOn);
    c._dwr = (c.bestDaysWithoutContact !== null && c.bestDaysWithoutContact !== undefined)
      ? c.bestDaysWithoutContact
      : dsSince(mostRecent(c.lastContact, c.lastCheckinDate));
  });
  var onHold = all.filter(function(c) { return c.jobStatus === 'On Hold'; });
  var unresponsive = all.filter(function(c) { return c.jobStatus === 'Client Unresponsive'; });
  var canceled = all.filter(function(c) { return c.jobStatus === 'Canceled'; });

  document.getElementById('cards-paused').innerHTML =
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">' +
    mkCard('paused','onhold','On Hold', onHold.length, '#fb923c') +
    mkCard('paused','unresponsive','Client Unresponsive', unresponsive.length, '#f87171') +
    mkCard('paused','canceled','Canceled', canceled.length, '#6b7280') +
    '</div>';

  var cf = cardFilters['paused'];
  var showOnHold = !cf || cf === 'onhold';
  var showUnresp = !cf || cf === 'unresponsive';
  var showCanceled = !cf || cf === 'canceled';

  var html = '';

  function sectionHeader(label, color, count) {
    return '<div style="display:flex;align-items:center;gap:12px;margin:28px 0 16px">' +
      '<div style="width:4px;height:24px;background:' + color + ';border-radius:2px"></div>' +
      '<span style="font-size:14px;font-weight:700;color:#e2e8f0">' + label + '</span>' +
      '<span style="background:#111827;color:#6b7280;border:1px solid #1f2937;padding:1px 8px;border-radius:20px;font-size:11px">' + count + '</span>' +
      '</div>';
  }

  if (showOnHold) {
    html += sectionHeader('On Hold', '#fb923c', onHold.length);
    if (onHold.length === 0) {
      html += '<p style="color:#475569;font-size:13px;padding:16px 0">No clients on hold.</p>';
    } else {
      html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540;margin-bottom:8px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
        theadTh('#') + theadTh('Client') + theadTh('HC') + theadTh('Days on Hold','_doh','paused') + theadTh('Last Contact','bestContactDate','paused') +
        '</tr></thead><tbody>';
      applyColSort(onHold, 'paused');
      onHold.forEach(function(c, i) {
        var doh = c._doh;
        var bg = i % 2 === 0 ? '#0f1520' : 'transparent';
        var alertBorder = doh > 30 ? '3px solid #ef4444' : '3px solid #fb923c';
        var dohBadge = doh !== null ? daysContactBadge(doh) : '\u2014';
        html += '<tr style="background:' + bg + ';border-left:' + alertBorder + '" class="data-row">' +
          tdCell('<span style="color:#475569">' + (i+1) + '</span>') +
          tdCell('<b style="color:#e2e8f0">' + c.name + '</b>') +
          tdCell(hcPill(c)) +
          tdCell(dohBadge) +
          tdCell(bestCell(c)) +
          '</tr>';
      });
      html += '</tbody></table></div>';
    }
  }

  if (showUnresp) {
    html += sectionHeader('Client Unresponsive', '#f87171', unresponsive.length);
    if (unresponsive.length === 0) {
      html += '<p style="color:#475569;font-size:13px;padding:16px 0">No unresponsive clients.</p>';
    } else {
      html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540;margin-bottom:8px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
        theadTh('#') + theadTh('Client') + theadTh('HC') + theadTh('Last Attempt','bestContactDate','paused') + theadTh('Days Without Response','_dwr','paused') +
        '</tr></thead><tbody>';
      applyColSort(unresponsive, 'paused');
      unresponsive.forEach(function(c, i) {
        var dwr = c._dwr;
        var bg = i % 2 === 0 ? '#0f1520' : 'transparent';
        html += '<tr style="background:' + bg + ';border-left:3px solid #f87171" class="data-row">' +
          tdCell('<span style="color:#475569">' + (i+1) + '</span>') +
          tdCell('<b style="color:#e2e8f0">' + c.name + '</b>') +
          tdCell(hcPill(c)) +
          tdCell(bestCell(c)) +
          tdCell(daysContactBadge(dwr)) +
          '</tr>';
      });
      html += '</tbody></table></div>';
    }
  }

  if (showCanceled) {
    html += sectionHeader('Canceled', '#6b7280', canceled.length);
    if (canceled.length === 0) {
      html += '<p style="color:#475569;font-size:13px;padding:16px 0">No canceled clients.</p>';
    } else {
      html += '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540;margin-bottom:8px">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
        theadTh('#') + theadTh('Client') + theadTh('HC') + theadTh('Reason') + theadTh('Last Contact','bestContactDate','paused') +
        '</tr></thead><tbody>';
      applyColSort(canceled, 'paused');
      canceled.forEach(function(c, i) {
        var bg = i % 2 === 0 ? '#0f1520' : 'transparent';
        html += '<tr style="background:' + bg + ';border-left:3px solid #374151" class="data-row">' +
          tdCell('<span style="color:#475569">' + (i+1) + '</span>') +
          tdCell('<b style="color:#e2e8f0">' + c.name + '</b>') +
          tdCell(hcPill(c)) +
          tdCell(comment(c, 80)) +
          tdCell(bestCell(c)) +
          '</tr>';
      });
      html += '</tbody></table></div>';
    }
  }

  document.getElementById('paused-sections').innerHTML = html;
}

function renderPending() {
  var base = filterHC(data.filter(function(c) { return c.jobStatus === 'Pending to be launched'; }));
  base.sort(function(a,b) { return (parseFloat(b.activeDays)||0) - (parseFloat(a.activeDays)||0); });

  var total = base.length;
  var newC = base.filter(function(c) { return c.typeOfClient === 'New Client'; }).length;

  document.getElementById('cards-pending').innerHTML =
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">' +
    mkCard('pending','all','Total Pending', total, '#c084fc') +
    mkCard('pending','new','New Clients', newC, '#60a5fa') +
    '</div>';

  var rows = base;
  var cf = cardFilters['pending'];
  if (cf === 'new') rows = rows.filter(function(c) { return c.typeOfClient === 'New Client'; });

  if (rows.length === 0) {
    document.getElementById('table-pending').innerHTML = '<p style="color:#475569;padding:20px 0">No clients pending launch.</p>';
    return;
  }

  var html = '<div style="overflow-x:auto;border-radius:12px;border:1px solid #1a2540">' +
    '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
    theadTh('#') + theadTh('Client','name','pending') + theadTh('HC') + theadTh('Type') +
    theadTh('Active Days','activeDays','pending') + theadTh('Candidates','candidatesPresented','pending') +
    theadTh('Last Contact','bestContactDate','pending') + theadTh('Last Comment') +
    '</tr></thead><tbody>';

  applyColSort(rows, 'pending');
  rows.forEach(function(c, i) {
    var bg = i % 2 === 0 ? '#0f1520' : 'transparent';
    html += '<tr style="background:' + bg + ';border-left:3px solid #7c3aed" class="data-row">' +
      tdCell('<span style="color:#475569">' + (i+1) + '</span>') +
      tdCell('<b style="color:#e2e8f0">' + c.name + '</b>') +
      tdCell(hcPill(c)) +
      tdCell('<span style="color:#94a3b8;font-size:11px">' + (c.typeOfClient||'\u2014') + '</span>') +
      tdCell(activeDaysBadge(c.activeDays)) +
      tdCell('<span style="color:#94a3b8;text-align:center">' + (c.candidatesPresented||'\u2014') + '</span>','text-align:center') +
      tdCell(bestCell(c)) +
      tdCell(comment(c,70)) +
      '</tr>';
  });

  html += '</tbody></table></div>';
  html += '<div style="padding:8px 4px;font-size:11px;color:#475569;margin-top:8px">' + rows.length + ' clients shown</div>';
  document.getElementById('table-pending').innerHTML = html;
}

renderAll();
showTab('open');
</script>
</body>
</html>`;
}

main().catch(console.error);
