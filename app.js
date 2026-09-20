// app.js
const CLIENT_ID = '403089530914-8qpqlnfi8f0l2ephvm1ubqsebqagcolh.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive';

let tokenClient;
let accessToken = null;

function getIdFromUrl(url) {
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (matches && matches.length > 1) return matches[1];
  throw new Error('Invalid Google link format configuration.');
}

// Initialize token client once the Google client library is fully loaded.
// We use a flag to avoid multiple initializations.
let tokenClientInitialized = false;

function initTokenClient() {
  if (tokenClientInitialized) return;
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    // Retry if the library hasn't loaded yet.
    setTimeout(initTokenClient, 100);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: '', // Will be set dynamically in getValidToken
  });
  tokenClientInitialized = true;
}

// Wait for DOM and Google library.
window.addEventListener('load', () => {
  initTokenClient();

  // Attach form submit handler.
  const form = document.getElementById('mergeForm');
  if (form) {
    form.addEventListener('submit', handleSubmit);
  }

  // Register service worker.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered successfully:', reg.scope))
      .catch(err => console.error('Service Worker registration failed:', err));
  }
});

function updateProgress(message) {
  const loadingMessage = document.getElementById('loadingMessage');
  if (loadingMessage) loadingMessage.innerText = message;
}

function getValidToken() {
  return new Promise((resolve, reject) => {
    // Ensure tokenClient is ready.
    if (!tokenClient) {
      // Try to initialize on the fly.
      initTokenClient();
      // Wait a bit and retry.
      setTimeout(() => {
        if (!tokenClient) {
          reject(new Error('Google authentication client not ready. Please refresh and try again.'));
          return;
        }
        // Recursive call once client is available.
        getValidToken().then(resolve).catch(reject);
      }, 300);
      return;
    }

    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.access_token);
      }
    };
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

async function handleSubmit(event) {
  event.preventDefault();

  const submitBtn = document.getElementById('submitBtn');
  const loadingState = document.getElementById('loadingState');
  const feedbackBox = document.getElementById('feedbackBox');

  feedbackBox.classList.add('hidden');
  loadingState.classList.remove('hidden');
  submitBtn.disabled = true;
  submitBtn.classList.add('opacity-50', 'cursor-not-allowed');

  try {
    const sheetUrlInput = document.getElementById('sheetUrl');
    const templateUrlInput = document.getElementById('templateUrl');
    const sheetId = getIdFromUrl(sheetUrlInput.value.trim());
    const templateId = getIdFromUrl(templateUrlInput.value.trim());

    updateProgress("Connecting to your Google Account...");
    accessToken = await getValidToken();

    updateProgress("Reading spreadsheet rows...");
    const responseSheet = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!responseSheet.ok) throw new Error("Could not access sheet. Ensure the link matches your logged-in profile access rules.");
    const metaData = await responseSheet.json();
    const tabName = metaData.sheets[0].properties.title;

    const dataResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1:Z1000`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const dataJson = await dataResp.json();
    const sheetData = dataJson.values;

    if (!sheetData || sheetData.length <= 1) {
      throw new Error('No data rows found in the sheet template structure.');
    }

    const headers = sheetData[0];

    updateProgress("Locating destination folder...");
    const driveMetaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${templateId}?fields=parents`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const fileMeta = await driveMetaResp.json();
    const parentFolderId = (fileMeta.parents && fileMeta.parents.length > 0) ? fileMeta.parents[0] : 'root';

    // Create a unique destination folder for this batch execution
    updateProgress("Creating batch output folder...");
    const folderTitle = "Merged Documents Batch - " + new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    const folderResp = await fetch(`https://www.googleapis.com/drive/v3/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderTitle,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
      })
    });
    const newFolder = await folderResp.json();
    const outputFolderId = newFolder.id;

    // Loop through all data rows and create beautifully isolated documents
    for (let i = 1; i < sheetData.length; i++) {
      // Assume the first column contains an identifying name (e.g., Student Name)
      const rowIdentifier = sheetData[i][0] || `Row_${i}`;
      updateProgress(`Generating styled file for ${rowIdentifier} (${i} of ${sheetData.length - 1})...`);

      // Step 1: Clone the template into our new batch folder
      const copyResp = await fetch(`https://www.googleapis.com/drive/v3/files/${templateId}/copy`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Report - ${rowIdentifier}`,
          parents: [outputFolderId]
        })
      });
      const newFile = await copyResp.json();
      const studentDocId = newFile.id;

      // Step 2: Use native replaceAllText (works flawlessly inside styled tables because it updates text in-place)
      let replaceRequests = [];
      for (let j = 0; j < headers.length; j++) {
        replaceRequests.push({
          replaceAllText: {
            containsText: { text: `<<${headers[j]}>>`, matchCase: true },
            replaceText: sheetData[i][j] !== undefined ? sheetData[i][j].toString() : ''
          }
        });
      }

      if (replaceRequests.length > 0) {
        await fetch(`https://docs.googleapis.com/v1/documents/${studentDocId}:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: replaceRequests })
        });
      }
    }

    // --- Display Success Interface UI ---
    loadingState.classList.add('hidden');
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    feedbackBox.classList.remove('hidden');
    feedbackBox.className = "mt-6 p-4 rounded-lg border bg-green-50 text-green-800 border-green-200 text-sm flex flex-col gap-2";
    feedbackBox.innerHTML = `
      <strong>Batch Generation Complete!</strong>
      <p>Successfully created individual, perfectly formatted documents for all rows inside a new folder.</p>
      <a href="https://drive.google.com/drive/folders/${outputFolderId}" target="_blank" class="mt-2 text-center bg-blue-600 text-white font-medium py-2 px-3 rounded-md hover:bg-blue-700 transition inline-block text-xs">
        Open Output Folder
      </a>
    `;

  } catch (error) {
    loadingState.classList.add('hidden');
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    feedbackBox.classList.remove('hidden');
    feedbackBox.className = "mt-6 p-4 rounded-lg border bg-red-50 text-red-800 border-red-200 text-sm";
    feedbackBox.innerText = "Execution Error: " + error.message;
  }
}