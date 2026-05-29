const $ = (selector) => document.querySelector(selector);
const logsEl = $('#logs');
const appView = $('#app-view');
const loginView = $('#login-view');
const loginForm = $('#login-form');
const loginError = $('#login-error');
const settingsModal = $('#settings-modal');
const settingsForm = $('#settings-form');
const settingsMessage = $('#settings-message');
const logClearKey = 'cloudflareTunnelPanel.logClearedAt';

let current = null;
let localLogs = [];
let events = null;
let currentSettings = null;
let settingsDirty = false;
let localLogClearedAt = Number(localStorage.getItem(logClearKey) || 0);

function formatTime(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date(value));
}

function formatLogTime(value) {
  if (!value) return '--:--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function formatMs(value) {
  if (!value) return '--';
  if (value < 1000) return `${value} ms`;
  return `${Math.round(value / 1000)} s`;
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function render(snapshot) {
  current = snapshot;
  const { state, config } = snapshot;
  document.body.dataset.phase = state.phase;
  setText('#phase', phaseName(state.phase));
  setText('#message', state.message || '--');
  setText('#ha', state.haConnections ?? 0);
  setText('#failures', state.consecutiveFailures ?? 0);
  setText('#threshold', `阈值 ${config.restartFailureThreshold}`);
  setText('#restarts', state.restartCount ?? 0);
  setText('#last-restart', state.lastRestartAt ? formatTime(state.lastRestartAt) : '暂无');
  setText('#pid', state.pid || '--');
  setText('#started', formatTime(state.startedAt));
  setText('#heartbeat', formatTime(state.lastHeartbeatAt));
  setText('#metrics', state.metricsOk ? '可访问' : '不可用');
  setText('#origin', state.originOk === null ? '未配置' : state.originOk ? '正常' : '失败');
  setText('#version', state.cloudflaredVersion || '--');
  setText('#interval', formatMs(config.heartbeatIntervalMs));
  setText('#timeout', formatMs(config.heartbeatTimeoutMs));
  setText('#cooldown', formatMs(config.restartCooldownMs));
  setText('#metrics-url', config.metricsUrl);
  setText('#probe-url', config.originProbeUrl || '未配置');
  setText('#accept-status', currentSettings?.originAcceptStatusCodes || '200-299');
  setText('#protocol', config.protocol || 'auto');
  if (snapshot.settings) {
    currentSettings = snapshot.settings;
    updateSettingsBadge(snapshot.settings);
  }
  if (snapshot.logs) {
    localLogs = filterVisibleLogs(snapshot.logs);
    paintLogs();
  }
}

function phaseName(phase) {
  return {
    starting: '启动中',
    connecting: '连接中',
    connected: '已连接',
    degraded: '异常',
    restarting: '重连中',
    disconnected: '已断开',
    stopped: '已停止',
    misconfigured: '未配置',
    error: '错误'
  }[phase] || phase || '--';
}

function appendLog(entry) {
  if (Date.parse(entry.ts) <= localLogClearedAt) return;
  localLogs.push(entry);
  if (localLogs.length > 300) localLogs = localLogs.slice(-300);
  paintLogs();
}

function filterVisibleLogs(entries) {
  return entries.filter((entry) => Date.parse(entry.ts) > localLogClearedAt);
}

function paintLogs() {
  logsEl.replaceChildren(...localLogs.map((entry) => {
    const row = document.createElement('div');
    row.className = `log-entry ${sourceClass(entry.source)} ${severityClass(entry.line)}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `[${formatLogTime(entry.ts)}]`;

    const source = document.createElement('span');
    source.className = 'log-source';
    source.textContent = entry.source || 'unknown';

    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.line;

    row.append(time, ' ', source, ': ', message);
    return row;
  }));
  logsEl.scrollTop = logsEl.scrollHeight;
}

function sourceClass(source) {
  return `source-${String(source || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

function severityClass(line) {
  const text = String(line || '').toLowerCase();
  if (text.includes(' failure ') || text.includes('failed') || text.includes(' err ') || text.includes('error')) return 'level-error';
  if (text.includes('warn') || text.includes('degraded') || text.includes('timeout')) return 'level-warn';
  if (text.includes('healthy') || text.includes('registered tunnel connection') || text.includes('connection registered')) return 'level-ok';
  return 'level-info';
}

async function api(action) {
  const response = await fetch(`/api/${action}`, { method: 'POST' });
  if (!response.ok) throw new Error(await response.text());
}

async function loadSettings() {
  const response = await fetch('/api/settings');
  if (!response.ok) throw new Error(await response.text());
  currentSettings = await response.json();
  renderSettings(currentSettings);
}

function renderSettings(settings) {
  updateSettingsBadge(settings);
  if (settingsDirty) return;
  $('#setting-protocol').value = settings.protocol || 'auto';
  $('#setting-probe').value = settings.originProbeUrl || '';
  $('#setting-accept-status').value = settings.originAcceptStatusCodes || '200-299';
  $('#setting-interval').value = settings.heartbeatIntervalMs || 10000;
  $('#setting-timeout').value = settings.heartbeatTimeoutMs || 5000;
  $('#setting-threshold').value = settings.restartFailureThreshold || 3;
  $('#setting-cooldown').value = settings.restartCooldownMs || 30000;
  $('#setting-preargs').value = settings.preArgs || '';
}

function updateSettingsBadge(settings) {
  $('#token-state').textContent = settings.tunnelTokenConfigured
    ? `Token 已配置 (${settings.tunnelTokenFingerprint})`
    : 'Token 未配置';
}

async function refresh() {
  const response = await fetch('/api/status');
  if (response.status === 401) {
    showLogin();
    return;
  }
  if (!response.ok) throw new Error(await response.text());
  render(await response.json());
}

function connectEvents() {
  if (events) events.close();
  events = new EventSource('/events');
  events.addEventListener('state', (event) => render(JSON.parse(event.data)));
  events.addEventListener('log', (event) => appendLog(JSON.parse(event.data)));
  events.addEventListener('logs-cleared', () => {
    localLogClearedAt = 0;
    localStorage.removeItem(logClearKey);
    localLogs = [];
    paintLogs();
  });
  events.onerror = () => {
    setText('#message', '事件流断开，正在等待浏览器自动重连');
  };
}

function showLogin(message = '') {
  if (events) events.close();
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  loginError.textContent = message;
  $('#login-token').focus();
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
}

async function openSettings() {
  settingsDirty = false;
  settingsMessage.textContent = '';
  await loadSettings();
  settingsModal.classList.remove('hidden');
  settingsModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  $('#setting-token').focus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
  settingsModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

async function checkAuth() {
  const response = await fetch('/api/auth');
  const auth = await response.json();
  if (auth.authRequired && !auth.authenticated) {
    showLogin();
    return;
  }
  showApp();
  await refresh();
  await loadSettings();
  connectEvents();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const token = new FormData(loginForm).get('token');
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  if (!response.ok) {
    showLogin('密码不正确');
    return;
  }
  loginForm.reset();
  showApp();
  await refresh();
  await loadSettings();
  connectEvents();
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  settingsMessage.textContent = '正在保存...';
  const form = new FormData(settingsForm);
  const token = String(form.get('tunnelToken') || '').trim();
  const payload = {
    tunnelToken: token || '__KEEP__',
    tunnelName: currentSettings?.tunnelName || '',
    tunnelConfig: currentSettings?.tunnelConfig || '',
    originProbeUrl: String(form.get('originProbeUrl') || '').trim(),
    originAcceptStatusCodes: String(form.get('originAcceptStatusCodes') || '200-299').trim(),
    protocol: form.get('protocol'),
    heartbeatIntervalMs: Number(form.get('heartbeatIntervalMs')),
    heartbeatTimeoutMs: Number(form.get('heartbeatTimeoutMs')),
    restartFailureThreshold: Number(form.get('restartFailureThreshold')),
    restartCooldownMs: Number(form.get('restartCooldownMs')),
    preArgs: String(form.get('preArgs') || '').trim(),
    postArgs: currentSettings?.postArgs || '',
    restart: $('#setting-restart').checked
  };
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    settingsMessage.textContent = await response.text();
    return;
  }
  const result = await response.json();
  currentSettings = result.settings;
  settingsDirty = false;
  $('#setting-token').value = '';
  renderSettings(result.settings);
  settingsMessage.textContent = result.restarted ? '已保存，正在重启 tunnel' : '已保存';
  setTimeout(() => refresh().catch(() => {}), 800);
});

settingsForm.addEventListener('input', () => {
  settingsDirty = true;
});

settingsForm.addEventListener('change', () => {
  settingsDirty = true;
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(button.dataset.action);
      await refresh();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });
});

$('#refresh').addEventListener('click', refresh);
$('#clear-screen').addEventListener('click', () => {
  localLogClearedAt = Date.now();
  localStorage.setItem(logClearKey, String(localLogClearedAt));
  localLogs = [];
  paintLogs();
});
$('#clear-server').addEventListener('click', () => {
  api('logs/clear').catch((error) => alert(error.message));
});
$('#settings-toggle').addEventListener('click', async () => {
  await openSettings();
});
$('#settings-close').addEventListener('click', closeSettings);
document.querySelectorAll('[data-close-settings]').forEach((node) => {
  node.addEventListener('click', closeSettings);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

checkAuth().catch((error) => showLogin(error.message));
