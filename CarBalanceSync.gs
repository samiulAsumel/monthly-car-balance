const SS_ID = 'YOUR_SPREADSHEET_ID';
const SHEET_NAME = 'CarBalanceData';

function doPost(e) {
  const action = e.parameter.action;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME) || 
                SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_NAME);
  
  if (action === 'load') {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return ContentService.createTextOutput(JSON.stringify({success: true, data: {}}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const dataStr = sheet.getRange(2, 1).getValue();
    const data = dataStr ? JSON.parse(dataStr) : {};
    return ContentService.createTextOutput(JSON.stringify({success: true, data: data}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  if (action === 'save') {
    const body = e.postData.contents;
    const data = JSON.parse(body).db;
    const dataStr = JSON.stringify(data);
    sheet.getRange(2, 1).setValue(dataStr);
    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  return ContentService.createTextOutput(JSON.stringify({success: false, error: 'Invalid action'}))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Car Balance Sync API is running');
}
