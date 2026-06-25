/**
 * GOOGLE APPS SCRIPT - Log Contact Button
 * =========================================
 * INSTRUCCIONES DE INSTALACION:
 * 1. Abre el Google Sheet del Upsell Tracker
 * 2. Ve a Extensiones -> Apps Script
 * 3. Borra todo el contenido y pega ESTE codigo completo
 * 4. Guarda (Ctrl+S)
 * 5. Recarga el Google Sheet - aparecera el menu "HC Tools"
 *
 * COMO USARLO:
 * - Selecciona la fila del cliente en el Upsell Tracker
 * - Clic en "HC Tools" -> "Log Contact"
 * - Paso 1: Escribe 1 (WhatsApp), 2 (Email) o 3 (Slack) y presiona OK
 * - Paso 2: Clic en Yes o No segun si el cliente respondio
 * - Listo. Fecha, canal y respuesta quedan guardados automaticamente.
 */

var TRACKER_SHEET_NAME = 'Upsell Tracker';
var COL_LAST_EXTERNAL = 12; // Columna L
var COL_CHANNEL = 13;       // Columna M
var COL_RESPONDED = 15;     // Columna O
var COL_CLIENT_NAME = 2;    // Columna B

var CHANNELS = {
  '1': 'WhatsApp',
  '2': 'Email',
  '3': 'Slack'
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('HC Tools')
    .addItem('Log Contact', 'logContact')
    .addItem('Ver resumen del dia', 'showDailySummary')
    .addToUi();
}

function logContact() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRACKER_SHEET_NAME);

  if (!sheet) {
    ui.alert('No se encontro la pestana "' + TRACKER_SHEET_NAME + '".');
    return;
  }

  if (ss.getActiveSheet().getName() !== TRACKER_SHEET_NAME) {
    ui.alert('Asegurate de estar en la pestana "' + TRACKER_SHEET_NAME + '" y tener una fila seleccionada.');
    return;
  }

  var selectedRow = ss.getActiveRange().getRow();
  if (selectedRow <= 1) {
    ui.alert('Selecciona la fila de un cliente (no el header).');
    return;
  }

  var clientName = sheet.getRange(selectedRow, COL_CLIENT_NAME).getValue();
  if (!clientName) {
    ui.alert('La fila seleccionada no tiene un nombre de cliente.');
    return;
  }

  // Un solo prompt: el HC escribe 1, 2 o 3
  var resp = ui.prompt(
    clientName,
    'Select channel:\n\n  1 = WhatsApp\n  2 = Email\n  3 = Slack',
    ui.ButtonSet.OK_CANCEL
  );

  if (resp.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var choice = resp.getResponseText().trim();
  var channel = CHANNELS[choice];

  if (!channel) {
    ui.alert('Opcion invalida. Escribe 1, 2 o 3.');
    return;
  }

  // Paso 2: Did the client respond? (Yes / No — un solo clic)
  var respondResp = ui.alert(
    clientName,
    'Did the client respond?',
    ui.ButtonSet.YES_NO
  );

  if (respondResp === ui.Button.CLOSE) {
    return;
  }

  var responded = (respondResp === ui.Button.YES) ? 'Yes' : 'No';

  // Asegurar que el header de columna N existe
  if (!sheet.getRange(1, COL_RESPONDED).getValue()) {
    sheet.getRange(1, COL_RESPONDED).setValue('Client Responded');
  }

  // Fecha de hoy automatica, sin pedirla al HC
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  sheet.getRange(selectedRow, COL_LAST_EXTERNAL).setValue(today);
  sheet.getRange(selectedRow, COL_CHANNEL).setValue(channel);
  sheet.getRange(selectedRow, COL_RESPONDED).setValue(responded);

  ui.alert('Listo! ' + clientName + ' — ' + channel + ' — Responded: ' + responded + ' — ' + today);
}

function showDailySummary() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TRACKER_SHEET_NAME);

  if (!sheet) {
    ui.alert('No se encontro la pestana "' + TRACKER_SHEET_NAME + '".');
    return;
  }

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var sheetData = sheet.getDataRange().getValues();
  var contacted = [];

  for (var i = 1; i < sheetData.length; i++) {
    var dataRow = sheetData[i];
    var name = dataRow[1];
    var extDate = dataRow[11];
    var ch = dataRow[12];
    if (!name) {
      continue;
    }
    var dateStr;
    if (extDate instanceof Date) {
      dateStr = Utilities.formatDate(extDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else {
      dateStr = String(extDate);
    }
    if (dateStr === today) {
      contacted.push(name + ' -> ' + (ch || 'Sin canal'));
    }
  }

  if (contacted.length === 0) {
    ui.alert('Resumen del dia - ' + today + '\n\nNo hay contactos externos registrados hoy todavia.');
  } else {
    ui.alert(
      'Resumen del dia - ' + today + '\n\n' +
      contacted.length + ' contacto(s) registrado(s):\n\n' +
      contacted.join('\n')
    );
  }
}
