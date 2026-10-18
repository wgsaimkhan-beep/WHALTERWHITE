/**
 * ATOMX MINI HUD CONTROLLER (Detached Floating Mini Window)
 * Keeps live sync with workflows via chrome.storage.local
 */

function renderMiniHud(data = {}) {
  const badge = document.getElementById('miniBadge');
  const title = document.getElementById('miniTitle');
  const indicator = document.getElementById('miniIndicator');
  const doneEl = document.getElementById('miniDone');
  const colEl = document.getElementById('miniCollected');
  const skipEl = document.getElementById('miniSkipped');
  const barEl = document.getElementById('miniProgressBar');
  const statusEl = document.getElementById('miniStatusText');
  const stopBtn = document.getElementById('miniStopBtn');

  if (data.title && title) title.textContent = data.title;
  if (data.indicator && indicator) indicator.textContent = data.indicator;
  if (data.done !== undefined && doneEl) doneEl.textContent = data.done;
  if (data.collected !== undefined && colEl) colEl.textContent = data.collected;
  if (data.skipped !== undefined && skipEl) skipEl.textContent = data.skipped;
  if (data.progressPercent !== undefined && barEl) {
    barEl.style.width = `${Math.min(100, Math.max(0, data.progressPercent))}%`;
  }
  if (data.statusText && statusEl) {
    statusEl.textContent = data.statusText;
    statusEl.title = data.statusText;
  }

  if (badge) {
    const s = data.stateBadge || 'RUNNING';
    badge.textContent = s;
    badge.className = 'state-badge';
    if (s === 'STOPPED') {
      badge.classList.add('stopped');
    } else if (s === 'RATE_LIMITED') {
      badge.classList.add('rate-limited');
    }
  }

  if (data.isStopped && stopBtn) {
    stopBtn.style.display = 'none';
  } else if (stopBtn) {
    stopBtn.style.display = 'flex';
  }
}

// Initial read on load
chrome.storage.local.get(['atomx_active_hud'], (res) => {
  if (res?.atomx_active_hud) {
    renderMiniHud(res.atomx_active_hud);
  }
});

// Real-time synchronization via storage events
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.atomx_active_hud) {
    const val = changes.atomx_active_hud.newValue;
    if (val) renderMiniHud(val);
  }
});

// Stop button handler
document.getElementById('miniStopBtn')?.addEventListener('click', () => {
  renderMiniHud({
    stateBadge: 'STOPPED',
    statusText: 'Workflow stopped by user.',
    isStopped: true
  });

  chrome.storage.local.set({
    atomx_active_hud: {
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      isStopped: true,
      active: false
    }
  }).catch(() => null);

  chrome.runtime.sendMessage({ type: 'ABORT_WORKFLOW' }).catch(() => null);
});
