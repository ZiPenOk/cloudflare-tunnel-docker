import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');
const env = process.env;
const dataDir = env.DATA_DIR || '/data';
const configPath = join(dataDir, 'panel-config.json');

const staticConfig = {
  port: toInt(env.PANEL_PORT, 18088),
  host: env.PANEL_HOST || '0.0.0.0',
  authToken: env.PANEL_AUTH_TOKEN || '',
  metricsHost: env.METRICS_HOST || '127.0.0.1',
  metricsPort: toInt(env.METRICS_PORT, 20241),
  logLimit: toInt(env.LOG_LIMIT, 500),
  envTunnelToken: env.TUNNEL_TOKEN || '',
  envTunnelName: env.TUNNEL_NAME || '',
  envTunnelConfig: env.TUNNEL_CONFIG || '',
  envOriginProbeUrl: env.ORIGIN_PROBE_URL || '',
  envOriginAcceptStatusCodes: env.ORIGIN_ACCEPT_STATUS_CODES || '200-299',
  envProtocol: env.TUNNEL_PROTOCOL || 'auto',
  envEdgeIpVersion: env.TUNNEL_EDGE_IP_VERSION || env.EDGE_IP_VERSION || 'auto',
  envNoTlsVerify: toBool(env.NO_TLS_VERIFY || env.TUNNEL_NO_TLS_VERIFY || env.ORIGIN_NO_TLS_VERIFY, false),
  envHaConnections: toInt(env.TUNNEL_HA_CONNECTIONS || env.HA_CONNECTIONS, 4),
  envHeartbeatIntervalMs: toInt(env.HEARTBEAT_INTERVAL_MS, 10000),
  envHeartbeatTimeoutMs: toInt(env.HEARTBEAT_TIMEOUT_MS, 5000),
  envRestartFailureThreshold: toInt(env.RESTART_FAILURE_THRESHOLD, 3),
  envRestartCooldownMs: toInt(env.RESTART_COOLDOWN_MS, 30000),
  envPreArgs: splitArgs(env.CLOUDFLARED_ARGS || env.CLOUDFLARED_PRE_ARGS || env.CLOUDFLARED_EXTRA_ARGS || ''),
  envPostArgs: splitArgs(env.CLOUDFLARED_POST_ARGS || '')
};

let runtimeConfig = defaultRuntimeConfig();

const state = {
  phase: 'starting',
  processRunning: false,
  pid: null,
  startedAt: null,
  lastExit: null,
  lastHeartbeatAt: null,
  lastRestartAt: null,
  restartCount: 0,
  consecutiveFailures: 0,
  haConnections: 0,
  metricsOk: false,
  originOk: null,
  message: 'Starting supervisor',
  cloudflaredVersion: null
};

const logs = [];
const clients = new Set();
let cloudflared = null;
let stoppingForRestart = false;
let manualStop = false;
let heartbeatTimer = null;
let reconnectTimer = null;
let suppressHeartbeatUntil = 0;

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = cleanString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function defaultRuntimeConfig() {
  return {
    tunnelToken: staticConfig.envTunnelToken,
    tunnelName: staticConfig.envTunnelName,
    tunnelConfig: staticConfig.envTunnelConfig,
    originProbeUrl: staticConfig.envOriginProbeUrl,
    originAcceptStatusCodes: staticConfig.envOriginAcceptStatusCodes,
    protocol: normalizeProtocol(staticConfig.envProtocol),
    edgeIpVersion: normalizeEdgeIpVersion(staticConfig.envEdgeIpVersion),
    noTlsVerify: staticConfig.envNoTlsVerify,
    haConnections: clampInt(staticConfig.envHaConnections, 4, 1, 16),
    heartbeatIntervalMs: staticConfig.envHeartbeatIntervalMs,
    heartbeatTimeoutMs: staticConfig.envHeartbeatTimeoutMs,
    restartFailureThreshold: staticConfig.envRestartFailureThreshold,
    restartCooldownMs: staticConfig.envRestartCooldownMs,
    preArgs: staticConfig.envPreArgs,
    postArgs: staticConfig.envPostArgs
  };
}

function normalizeProtocol(value) {
  const protocol = cleanString(value).toLowerCase();
  return ['auto', 'quic', 'http2'].includes(protocol) ? protocol : 'auto';
}

function normalizeEdgeIpVersion(value) {
  const version = cleanString(value).toLowerCase();
  return ['auto', '4', '6'].includes(version) ? version : 'auto';
}

function statusAccepted(status, expression = '200-299') {
  return cleanString(expression)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const [start, end] = part.split('-').map((value) => Number.parseInt(value.trim(), 10));
      if (!Number.isFinite(start)) return false;
      if (!Number.isFinite(end)) return status === start;
      return status >= start && status <= end;
    });
}

function sanitizeRuntimeConfig(input, previous = runtimeConfig) {
  const keepSecret = input.tunnelToken === undefined || input.tunnelToken === null || input.tunnelToken === '__KEEP__';
  return {
    tunnelToken: keepSecret ? previous.tunnelToken : cleanString(input.tunnelToken),
    tunnelName: cleanString(input.tunnelName),
    tunnelConfig: cleanString(input.tunnelConfig),
    originProbeUrl: cleanString(input.originProbeUrl),
    originAcceptStatusCodes: cleanString(input.originAcceptStatusCodes) || '200-299',
    protocol: normalizeProtocol(input.protocol),
    edgeIpVersion: normalizeEdgeIpVersion(input.edgeIpVersion ?? previous.edgeIpVersion),
    noTlsVerify: toBool(input.noTlsVerify, previous.noTlsVerify || false),
    haConnections: clampInt(input.haConnections, previous.haConnections || 4, 1, 16),
    heartbeatIntervalMs: clampInt(input.heartbeatIntervalMs, 10000, 3000, 3600000),
    heartbeatTimeoutMs: clampInt(input.heartbeatTimeoutMs, 5000, 1000, 300000),
    restartFailureThreshold: clampInt(input.restartFailureThreshold, 3, 1, 100),
    restartCooldownMs: clampInt(input.restartCooldownMs, 30000, 5000, 3600000),
    preArgs: Array.isArray(input.preArgs) ? input.preArgs.map(cleanString).filter(Boolean) : splitArgs(input.preArgs || ''),
    postArgs: Array.isArray(input.postArgs) ? input.postArgs.map(cleanString).filter(Boolean) : splitArgs(input.postArgs || '')
  };
}

async function loadRuntimeConfig() {
  try {
    const file = JSON.parse(await readFile(configPath, 'utf8'));
    runtimeConfig = sanitizeRuntimeConfig({ ...defaultRuntimeConfig(), ...file }, defaultRuntimeConfig());
    addLog('supervisor', `Loaded runtime config from ${configPath}`);
  } catch (error) {
    runtimeConfig = defaultRuntimeConfig();
    if (error.code !== 'ENOENT') addLog('supervisor', `Failed to load runtime config: ${error.message}`);
  }
}

async function saveRuntimeConfig(nextConfig) {
  runtimeConfig = sanitizeRuntimeConfig(nextConfig);
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(runtimeConfig, null, 2), 'utf8');
  addLog('supervisor', `Saved runtime config to ${configPath}`);
  resetHeartbeatTimer();
}

function resetHeartbeatTimer() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(heartbeat, runtimeConfig.heartbeatIntervalMs);
  heartbeatTimer.unref?.();
}

function publicSettings() {
  return {
    tunnelTokenConfigured: Boolean(runtimeConfig.tunnelToken),
    tunnelTokenFingerprint: runtimeConfig.tunnelToken ? createHash('sha256').update(runtimeConfig.tunnelToken).digest('hex').slice(0, 12) : null,
    tunnelName: runtimeConfig.tunnelName,
    tunnelConfig: runtimeConfig.tunnelConfig,
    originProbeUrl: runtimeConfig.originProbeUrl,
    originAcceptStatusCodes: runtimeConfig.originAcceptStatusCodes,
    protocol: runtimeConfig.protocol,
    edgeIpVersion: runtimeConfig.edgeIpVersion,
    noTlsVerify: runtimeConfig.noTlsVerify,
    haConnections: runtimeConfig.haConnections,
    heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
    heartbeatTimeoutMs: runtimeConfig.heartbeatTimeoutMs,
    restartFailureThreshold: runtimeConfig.restartFailureThreshold,
    restartCooldownMs: runtimeConfig.restartCooldownMs,
    preArgs: runtimeConfig.preArgs.join(' '),
    postArgs: runtimeConfig.postArgs.join(' ')
  };
}

function healthPayload() {
  return {
    ok: true,
    phase: state.phase,
    processRunning: state.processRunning,
    haConnections: state.haConnections,
    metricsOk: state.metricsOk,
    originOk: state.originOk,
    consecutiveFailures: state.consecutiveFailures,
    message: state.message,
    checkedAt: now()
  };
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) || [];
}

function now() {
  return new Date().toISOString();
}

function redact(text) {
  if (!runtimeConfig.tunnelToken) return text;
  return text.split(runtimeConfig.tunnelToken).join('[redacted-token]');
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

function cookieHeader(value, req, maxAge) {
  const parts = [
    `cf_tunnel_panel=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function addLog(source, line) {
  const entry = { ts: now(), source, line: redact(String(line)).trimEnd() };
  logs.push(entry);
  while (logs.length > staticConfig.logLimit) logs.shift();
  broadcast('log', entry);
}

function clearLogs() {
  logs.length = 0;
  broadcast('logs-cleared', { ts: now() });
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast('state', snapshot());
}

function snapshot() {
  return {
    config: {
      heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
      heartbeatTimeoutMs: runtimeConfig.heartbeatTimeoutMs,
      restartFailureThreshold: runtimeConfig.restartFailureThreshold,
      restartCooldownMs: runtimeConfig.restartCooldownMs,
      metricsUrl: `http://${staticConfig.metricsHost}:${staticConfig.metricsPort}/metrics`,
      originProbeUrl: runtimeConfig.originProbeUrl || null,
      mode: runtimeConfig.tunnelToken ? 'token' : 'config/name',
      protocol: runtimeConfig.protocol,
      edgeIpVersion: runtimeConfig.edgeIpVersion,
      noTlsVerify: runtimeConfig.noTlsVerify,
      haConnections: runtimeConfig.haConnections,
      manualStop
    },
    state,
    logs: logs.slice(-200),
    settings: publicSettings()
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function buildCloudflaredArgs() {
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--metrics',
    `${staticConfig.metricsHost}:${staticConfig.metricsPort}`,
    ...runtimeConfig.preArgs
  ];
  args.push('--edge-ip-version', runtimeConfig.edgeIpVersion);
  args.push('--ha-connections', String(runtimeConfig.haConnections));
  if (runtimeConfig.protocol !== 'auto') args.push('--protocol', runtimeConfig.protocol);
  if (runtimeConfig.noTlsVerify) args.push('--no-tls-verify');
  if (runtimeConfig.tunnelToken) {
    args.push('run', '--token', runtimeConfig.tunnelToken);
  } else {
    if (runtimeConfig.tunnelConfig) args.push('--config', runtimeConfig.tunnelConfig);
    args.push('run');
    if (runtimeConfig.tunnelName) args.push(runtimeConfig.tunnelName);
  }
  args.push(...runtimeConfig.postArgs);
  return args;
}

function startTunnel(reason = 'initial start') {
  if (cloudflared && !cloudflared.killed) return;

  if (!runtimeConfig.tunnelToken && !runtimeConfig.tunnelName && !runtimeConfig.tunnelConfig) {
    setState({
      phase: 'misconfigured',
      processRunning: false,
      message: 'Set TUNNEL_TOKEN, or provide TUNNEL_NAME/TUNNEL_CONFIG for a locally configured tunnel.'
    });
    return;
  }

  manualStop = false;
  const args = buildCloudflaredArgs();
  addLog('supervisor', `Starting cloudflared (${reason}): cloudflared ${redact(args.join(' '))}`);
  cloudflared = spawn('cloudflared', args, {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  setState({
    phase: 'connecting',
    processRunning: true,
    pid: cloudflared.pid,
    startedAt: now(),
    message: `cloudflared started (${reason})`
  });
  setTimeout(() => heartbeat().catch((error) => addLog('heartbeat', `Initial check failed: ${error.message}`)), 1500).unref();

  cloudflared.stdout.on('data', (chunk) => appendProcessLog('cloudflared', chunk));
  cloudflared.stderr.on('data', (chunk) => appendProcessLog('cloudflared', chunk));
  cloudflared.on('error', (error) => {
    addLog('supervisor', `Failed to start cloudflared: ${error.message}`);
    setState({ phase: 'error', processRunning: false, message: error.message });
  });
  cloudflared.on('exit', (code, signal) => {
    const expected = stoppingForRestart || manualStop;
    addLog('supervisor', `cloudflared exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    state.lastExit = { code, signal, at: now() };
    cloudflared = null;
    setState({
      processRunning: false,
      pid: null,
      consecutiveFailures: 0,
      haConnections: 0,
      metricsOk: false,
      phase: expected && manualStop ? 'stopped' : 'disconnected',
      message: expected && manualStop
        ? 'Tunnel is manually stopped; heartbeat reconnect is paused'
        : expected
          ? 'cloudflared stopped'
          : 'cloudflared exited unexpectedly'
    });
    stoppingForRestart = false;
    if (!manualStop) scheduleReconnect(expected ? 1000 : Math.min(runtimeConfig.restartCooldownMs, 10000));
  });
}

function appendProcessLog(source, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    addLog(source, line);
    if (source === 'cloudflared') handleCloudflaredSignal(line);
  }
}

function handleCloudflaredSignal(line) {
  if (/Registered tunnel connection|connection .*registered/i.test(line)) {
    suppressHeartbeatUntil = 0;
    const protocol = line.match(/protocol=([^\s]+)/i)?.[1];
    const location = line.match(/location=([^\s]+)/i)?.[1];
    const details = [protocol, location].filter(Boolean).join(', ');
    setState({
      phase: 'connected',
      processRunning: true,
      consecutiveFailures: 0,
      haConnections: Math.max(state.haConnections, 1),
      metricsOk: state.metricsOk,
      lastHeartbeatAt: now(),
      message: details ? `Tunnel connection registered (${details})` : 'Tunnel connection registered'
    });
    setTimeout(() => heartbeat().catch((error) => addLog('heartbeat', `Metrics refresh failed: ${error.message}`)), 1000).unref();
  }
}

function stopTunnel() {
  manualStop = true;
  if (!cloudflared) {
    setState({
      phase: 'stopped',
      processRunning: false,
      pid: null,
      consecutiveFailures: 0,
      haConnections: 0,
      metricsOk: false,
      originOk: runtimeConfig.originProbeUrl ? false : null,
      message: 'Tunnel is manually stopped; heartbeat reconnect is paused'
    });
    return;
  }
  addLog('supervisor', 'Stopping cloudflared by request');
  cloudflared.kill('SIGTERM');
  setTimeout(() => {
    if (cloudflared && !cloudflared.killed) cloudflared.kill('SIGKILL');
  }, 8000).unref();
}

function restartTunnel(reason = 'manual restart') {
  state.restartCount += 1;
  state.lastRestartAt = now();
  stoppingForRestart = true;
  manualStop = false;
  suppressHeartbeatUntil = Date.now() + Math.max(10000, runtimeConfig.heartbeatTimeoutMs * 2);
  setState({ phase: 'restarting', message: `Restarting: ${reason}` });
  addLog('supervisor', `Restarting cloudflared: ${reason}`);
  if (cloudflared) {
    cloudflared.kill('SIGTERM');
    setTimeout(() => {
      if (cloudflared && !cloudflared.killed) cloudflared.kill('SIGKILL');
    }, 8000).unref();
  } else {
    scheduleReconnect(500);
  }
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!manualStop) startTunnel('scheduled reconnect');
  }, delayMs);
}

async function heartbeat() {
  if (manualStop) {
    const stoppedMessage = 'Tunnel is manually stopped; heartbeat reconnect is paused';
    if (
      state.phase === 'stopped' &&
      state.processRunning === false &&
      state.consecutiveFailures === 0 &&
      state.haConnections === 0 &&
      state.metricsOk === false &&
      state.message === stoppedMessage
    ) {
      return;
    }
    setState({
      phase: 'stopped',
      processRunning: false,
      pid: null,
      consecutiveFailures: 0,
      haConnections: 0,
      metricsOk: false,
      originOk: runtimeConfig.originProbeUrl ? false : null,
      message: stoppedMessage
    });
    return;
  }

  if (Date.now() < suppressHeartbeatUntil) {
    if (state.phase !== 'restarting') {
      setState({
        phase: 'restarting',
        consecutiveFailures: 0,
        message: 'Restarting: waiting for cloudflared to reconnect'
      });
    }
    return;
  }

  const result = {
    metricsOk: false,
    haConnections: 0,
    originOk: runtimeConfig.originProbeUrl ? false : null,
    message: ''
  };

  if (!cloudflared) {
    markHeartbeatFailure('cloudflared process is not running', result);
    return;
  }

  try {
    const metricsText = await fetchText(`http://${staticConfig.metricsHost}:${staticConfig.metricsPort}/metrics`, runtimeConfig.heartbeatTimeoutMs);
    result.metricsOk = true;
    result.haConnections = parseHaConnections(metricsText);
  } catch (error) {
    result.message = `metrics unavailable: ${error.message}`;
  }

  if (runtimeConfig.originProbeUrl) {
    try {
      const response = await fetchWithTimeout(runtimeConfig.originProbeUrl, runtimeConfig.heartbeatTimeoutMs);
      result.originOk = statusAccepted(response.status, runtimeConfig.originAcceptStatusCodes);
      if (!result.originOk) {
        result.message = `origin probe returned HTTP ${response.status} (accepted: ${runtimeConfig.originAcceptStatusCodes})`;
      }
    } catch (error) {
      result.originOk = false;
      result.message = `origin probe failed: ${error.message}`;
    }
  }

  const healthy = result.metricsOk && result.haConnections > 0 && result.originOk !== false;
  if (healthy) {
    setState({
      phase: 'connected',
      lastHeartbeatAt: now(),
      consecutiveFailures: 0,
      haConnections: result.haConnections,
      metricsOk: true,
      originOk: result.originOk,
      message: `Healthy, ${result.haConnections} HA connection(s)`
    });
    return;
  }

  const reason = result.message || (result.metricsOk ? 'no active HA connections' : 'metrics unavailable');
  markHeartbeatFailure(reason, result);
}

function markHeartbeatFailure(reason, result) {
  const failures = state.consecutiveFailures + 1;
  setState({
    phase: cloudflared ? 'degraded' : 'disconnected',
    lastHeartbeatAt: now(),
    consecutiveFailures: failures,
    haConnections: result.haConnections,
    metricsOk: result.metricsOk,
    originOk: result.originOk,
    message: reason
  });
  addLog('heartbeat', `Failure ${failures}/${runtimeConfig.restartFailureThreshold}: ${reason}`);

  const cooldownElapsed = !state.lastRestartAt || Date.now() - Date.parse(state.lastRestartAt) >= runtimeConfig.restartCooldownMs;
  if (failures >= runtimeConfig.restartFailureThreshold && cooldownElapsed) {
    restartTunnel(`heartbeat failed ${failures} times: ${reason}`);
  }
}

async function fetchText(url, timeoutMs) {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseHaConnections(metricsText) {
  const matches = [...metricsText.matchAll(/^cloudflared_tunnel_ha_connections(?:\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/gim)];
  if (!matches.length) return 0;
  return Math.max(...matches.map((match) => Number.parseFloat(match[1]) || 0));
}

function authorized(req) {
  if (!staticConfig.authToken) return true;
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') === staticConfig.authToken) return true;
  if (readCookie(req, 'cf_tunnel_panel') === staticConfig.authToken) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${staticConfig.authToken}`;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  if (pathname.includes('..')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const filePath = join(publicDir, pathname);
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': contentType(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function contentType(filePath) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extname(filePath)] || 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const payload = healthPayload();
    sendJson(res, 200, payload);
    return;
  }

  if (url.pathname === '/events') {
    if (!authorized(req)) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/auth' || url.pathname === '/api/login' || url.pathname === '/api/logout') {
      await handleApi(req, res, url);
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    await handleApi(req, res, url);
    return;
  }

  await serveStatic(req, res);
});

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth') {
    sendJson(res, 200, {
      authRequired: Boolean(staticConfig.authToken),
      authenticated: authorized(req)
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!staticConfig.authToken) {
      sendJson(res, 200, { ok: true, authRequired: false });
      return;
    }
    try {
      const body = await readJson(req);
      if (body.token !== staticConfig.authToken) {
        sendJson(res, 401, { error: 'Invalid password' });
        return;
      }
      sendJson(res, 200, { ok: true }, {
        'set-cookie': cookieHeader(staticConfig.authToken, req, 60 * 60 * 24 * 30)
      });
    } catch {
      sendJson(res, 400, { error: 'Invalid request body' });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sendJson(res, 200, { ok: true }, {
      'set-cookie': cookieHeader('', req, 0)
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    sendJson(res, 200, publicSettings());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    try {
      const body = await readJson(req);
      const nextConfig = sanitizeRuntimeConfig(body, runtimeConfig);
      await saveRuntimeConfig(nextConfig);
      const shouldRestart = body.restart !== false && !manualStop;
      if (shouldRestart) restartTunnel('settings changed');
      sendJson(res, 200, { ok: true, settings: publicSettings(), restarted: shouldRestart });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Invalid settings' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, snapshot());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    startTunnel('manual start');
    sendJson(res, 202, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    stopTunnel();
    sendJson(res, 202, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    restartTunnel('manual restart');
    sendJson(res, 202, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logs/clear') {
    clearLogs();
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function loadVersion() {
  return new Promise((resolve) => {
    const child = spawn('cloudflared', ['--version']);
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('close', () => resolve(output.trim() || null));
    child.on('error', () => resolve(null));
  });
}

process.on('SIGTERM', () => {
  addLog('supervisor', 'Received SIGTERM');
  stopTunnel();
  setTimeout(() => process.exit(0), 1500).unref();
});

process.on('SIGINT', () => {
  addLog('supervisor', 'Received SIGINT');
  stopTunnel();
  setTimeout(() => process.exit(0), 1500).unref();
});

server.listen(staticConfig.port, staticConfig.host, async () => {
  await loadRuntimeConfig();
  state.cloudflaredVersion = await loadVersion();
  addLog('supervisor', `Panel listening on http://${staticConfig.host}:${staticConfig.port}`);
  if (state.cloudflaredVersion) addLog('supervisor', state.cloudflaredVersion);
  startTunnel();
  resetHeartbeatTimer();
});
