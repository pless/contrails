// Dashboard configuration. The page first tries the live Google Sheet (needs
// "anyone with the link can view" on the sheet); if that fails it uses the
// snapshot in data/cameras.json written by tools/build_dashboard.py.
window.CC_CONFIG = {
  sheetId: "1Wn2NxC56LbhtVOmohMansWGv1uCzy9HBOPA4eqncCGk",
  sheetTab: "cameras",
  sheetUrl: "https://docs.google.com/spreadsheets/d/1Wn2NxC56LbhtVOmohMansWGv1uCzy9HBOPA4eqncCGk/edit",
  driveRootUrl: "https://drive.google.com/drive/folders/1_LHW5Ua-BH-G7-WmF7Hh-Z9TFC0BLOju",
  liveSheet: true,          // set false to always use the snapshot
  refreshSeconds: 60,       // current-image auto refresh on the camera page
  // Notes from the camera page (Robert, 2026-10-17): posted through the cue page's Apps Script
  // (calibration/tools/cue_submit/Code.gs) into the registry spreadsheet's "cues" tab, read back from there;
  // calibration/tools/camera_notes.py lists them for review.
  notesSubmitUrl: "https://script.google.com/macros/s/AKfycbzBZL6q-F68SBA4cjVfBtCuaLX381IOOGYji833ay-UnJEyBMHuE0dV7MYIg7TXtSAv/exec",
  notesTab: "cues",
};
