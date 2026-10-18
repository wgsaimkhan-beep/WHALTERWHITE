/**
 * ATOMX ENGAGE — OPTIONS PAGE LOGIC
 */

document.addEventListener('DOMContentLoaded', async () => {
  const { backendUrl = 'https://twixor.onrender.com', defaultStyle = 'Natural & Concise' } =
    await chrome.storage.sync.get(['backendUrl', 'defaultStyle']);

  document.getElementById('backendUrlInput').value = backendUrl;
  document.getElementById('defaultStyleSelect').value = defaultStyle;

  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('testBtn').addEventListener('click', testConnection);
});

async function saveSettings() {
  const backendUrl = document.getElementById('backendUrlInput').value.trim() || 'https://twixor.onrender.com';
  const defaultStyle = document.getElementById('defaultStyleSelect').value;

  await Promise.all([
    chrome.storage.sync.set({ backendUrl, defaultStyle }),
    chrome.storage.local ? chrome.storage.local.set({ backendUrl, defaultStyle }) : Promise.resolve()
  ]);
  showMessage('✓ Settings saved successfully!', '#22A06B');
}

async function testConnection() {
  const backendUrl = document.getElementById('backendUrlInput').value.trim() || 'https://twixor.onrender.com';
  showMessage('Testing connection to ' + backendUrl + '...', '#6B7280');

  try {
    const res = await fetch(`${backendUrl}/health`, { method: 'GET' }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      showMessage(`✓ Connected to ATOMX Backend (${data.service || 'OK'}, v${data.version || '1.0.0'})`, '#22A06B');
    } else {
      showMessage(`⚠ Server returned status ${res ? res.status : 'offline'}. Make sure backend is running.`, '#D99000');
    }
  } catch (err) {
    showMessage('✗ Failed to connect. Check if server is running on ' + backendUrl, '#D64545');
  }
}

function showMessage(msg, color) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.style.color = color;
}
