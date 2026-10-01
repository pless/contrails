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
};
