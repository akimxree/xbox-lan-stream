'use strict';

/* global xCloudPlayer, Metrics */

const $ = (id) => document.getElementById(id);

const state = {
  info: null,
  apiBase: null,
  lib: null,
  auth: null,
  consoles: [],
  selectedId: null,
  api: null,
  stream: null,
  player: null,
  metrics: null,
  keepalive: null,
  pingTimer: null,
  provisionTimer: null,
  videoProbe: null,
  hudVisible: true,
  forceLan: true,
  gamepadEnabled: true,
  gamepad: null,
  mkbEnabled: true,
  mkb: null,
  kbmPadEnabled: true,
  kbmPad: null,
  kbmSensitivity: 1,
  wheelHandler: null,
  upscaleEnabled: true,
  sharpness: 0.42,
  smoothEnabled: false,
  smoothFps: 45,
  upscaler: null,
  showDecode: false,
  lastKeyframeRequest: 0,
  lastStopAt: 0,
  bitrateKbps: 25000,
  streaming: false,
  fullscreen: false,
  loadingConsoles: false,
  toastTimer: null,
};

/* ------------------------------------------------------------------ boot */

window.addEventListener('DOMContentLoaded', init);

async function init() {
  state.lib = resolveLibrary();
  state.info = await window.lan.appInfo();
  state.apiBase = state.info.proxyOrigin;

  $('factLatency').textContent = state.info.lowLatency ? 'low-lat' : '—';
  renderAppInfo();
  wireUi();
  wireAuth();

  const snapshot = await window.lan.auth.snapshot();
  renderAuth(snapshot);
  window.lan.auth.init().catch(() => {});

  loadNetworkInfo().catch(() => {});
}

function resolveLibrary() {
  const candidate = window.xCloudPlayer;
  if (!candidate) return null;
  if (candidate.Player && candidate.ApiClient) return candidate;
  if (candidate.default && candidate.default.Player) return candidate.default;
  return null;
}

function wireAuth() {
  window.lan.auth.onChanged((snapshot) => renderAuth(snapshot));
}

/* ------------------------------------------------------------- auth / UI */

function renderAuth(snapshot) {
  const wasReady = state.auth && state.auth.state === 'ready';
  state.auth = snapshot;

  const badge = $('authBadge');
  badge.className = 'badge';
  if (snapshot.state === 'ready') {
    badge.classList.add('ok');
    badge.textContent = 'online';
  } else if (snapshot.state === 'needs-auth') {
    badge.classList.add('err');
    badge.textContent = 'нужен вход';
  } else if (snapshot.state === 'authenticating') {
    badge.textContent = 'вход…';
  } else {
    badge.textContent = snapshot.state || '…';
  }

  const box = $('authBox');
  if (snapshot.state === 'ready') {
    box.innerHTML = '';
    $('btnStream').disabled = !state.selectedId || !state.lib;
    if (!wasReady) loadConsoles();
  } else if (snapshot.state === 'authenticating' && snapshot.deviceCode) {
    const dc = snapshot.deviceCode;
    let loginHost = 'Microsoft';
    try {
      loginHost = new URL(dc.verificationUri).host;
    } catch {
      /* keep fallback */
    }
    box.innerHTML = `
      <div class="auth-title">Подтвердите вход в Microsoft</div>
      <div class="muted small">Код действует ${Math.round(dc.expiresIn / 60)} мин. Пароль вводится только на сайте Microsoft.</div>
      <div class="device-code" id="deviceCode">${escapeHtml(dc.userCode)}</div>
      <button class="ghost-btn small" id="btnOpenLogin">Открыть ${escapeHtml(loginHost)}</button>
      <p class="muted small" style="margin-top:10px">После подтверждения окно обновится автоматически.</p>
    `;
    $('btnOpenLogin')?.addEventListener('click', () => window.lan.open(dc.verificationUri));
  } else if (snapshot.state === 'needs-auth') {
    const err = snapshot.error ? `<p class="error">${escapeHtml(snapshot.error)}</p>` : '';
    $('consoleList').innerHTML = '<div class="skeleton">Войдите, чтобы увидеть консоли.</div>';
    box.innerHTML = `
      <div class="auth-title">Нужен вход в Xbox</div>
      <div class="muted small">Device-code flow MSAL. Токен хранится локально в ${escapeHtml(snapshot.tokenPath || '')}.</div>
      ${err}
      <div class="btn-row"><button class="primary small" id="btnLogin">Войти через Microsoft</button></div>
    `;
    $('btnLogin')?.addEventListener('click', async () => {
      try {
        $('btnLogin').disabled = true;
        const code = await window.lan.auth.login();
        if (code?.verificationUri) window.lan.open(code.verificationUri);
      } catch (err) {
        $('connectError').textContent = String(err.message || err);
        $('btnLogin').disabled = false;
      }
    });
  } else {
    box.innerHTML = '<div class="skeleton">Загрузка профиля…</div>';
  }

  if (snapshot.error && snapshot.state === 'needs-auth' && !box.querySelector('.error')) {
    $('connectError').textContent = snapshot.error;
  }
}

async function loadConsoles() {
  if (state.loadingConsoles) return;
  if (!state.lib) {
    $('consoleList').innerHTML =
      '<div class="skeleton">Не найден vendor/xbox-xcloud-player. Выполните <b>npm run setup:player</b> и перезапустите.</div>';
    return;
  }
  if (!state.api) {
    state.api = new state.lib.ApiClient({
      host: state.apiBase,
      locale: 'ru-RU',
      force_1080p: true,
    });
  }

  state.loadingConsoles = true;
  $('consoleList').innerHTML = '<div class="skeleton">Поиск консолей…</div>';
  try {
    const result = await state.api.getConsoles();
    if (!result || result.error || !Array.isArray(result.results)) {
      throw new Error(result?.message || result?.error || 'xHome вернул некорректный список консолей');
    }
    state.consoles = result.results;
    renderConsoles();
  } catch (err) {
    $('consoleList').innerHTML = `<div class="skeleton">Не удалось получить консоли: ${escapeHtml(
      String(err.message || err)
    )}</div>`;
  } finally {
    state.loadingConsoles = false;
  }
}

function renderConsoles() {
  const list = $('consoleList');
  if (!state.consoles.length) {
    list.innerHTML =
      '<div class="skeleton">Консолей не найдено. Включите Xbox, проверьте «Удалённые функции» и тот же аккаунт.</div>';
    return;
  }

  list.innerHTML = '';
  for (const console of state.consoles) {
    const el = document.createElement('div');
    el.className = 'console';
    if (console.serverId === state.selectedId) el.classList.add('selected');
    const online = String(console.powerState).toLowerCase() === 'on';
    el.innerHTML = `
      <div>
        <div class="console-name">${escapeHtml(console.deviceName || 'Xbox')}</div>
        <div class="console-meta">${escapeHtml(console.consoleType || '')} · ${escapeHtml(
      console.serverId || ''
    )}</div>
      </div>
      <span class="power ${online ? 'on' : ''}">${escapeHtml(console.powerState || '?')}</span>
    `;
    el.addEventListener('click', () => {
      state.selectedId = console.serverId;
      $('btnStream').disabled = !state.lib;
      renderConsoles();
    });
    list.appendChild(el);
  }

  if (!state.selectedId) {
    const first = state.consoles.find((c) => String(c.powerState).toLowerCase() === 'on') || state.consoles[0];
    state.selectedId = first.serverId;
    renderConsoles();
    return;
  }
  $('btnStream').disabled = !state.lib;
}

/* ------------------------------------------------------------- streaming */

async function startStream() {
  const console = state.consoles.find((c) => c.serverId === state.selectedId);
  if (!console || !state.api) return;

  // xHome needs a moment to tear down the previous session; starting inside
  // that window produces a half-provisioned session that never reaches
  // Provisioned.
  const sinceStop = Date.now() - state.lastStopAt;
  if (sinceStop < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 3000 - sinceStop));
  }

  $('connectError').textContent = '';
  state.streaming = true;
  $('btnStream').disabled = true;
  window.lan.power.stream(true).catch(() => {});
  showStreamView(true);
  setStateLabel('provisioning');
  toast('Запрос сессии…');

  try {
    const stream = await state.api.startStream('home', console.serverId);
    state.stream = stream;

    state.keepalive = setInterval(() => {
      stream
        .sendKeepalive()
        .then((response) => {
          if (response && (response.code === 'SessionNotActive' || response.code === 'SessionNotFound')) {
            clearInterval(state.keepalive);
          }
        })
        .catch(() => {});
    }, 30_000);

    stream.onProvisioned = () => {
      setStateLabel('provisioned');
      createPlayer();
    };

    stream.onReadyToConnect = async () => {
      setStateLabel('authorizing');
      try {
        const lpt = await fetch(state.apiBase + '/api/msal').then((r) => r.text());
        await stream.sendMSALAuth(lpt);
        setStateLabel('connecting');
      } catch (err) {
        failStream('MSAL auth failed: ' + String(err.message || err));
      }
    };

    state.provisionTimer = setTimeout(() => {
      if (!state.player) failStream('Консоль не подготовила сессию за 45 с. Проверьте, что она включена и Remote Features разрешены.');
    }, 45_000);

    stream.waitForState('Provisioned');
  } catch (err) {
    failStream(String(err.message || err));
  }
}

async function createPlayer() {
  if (state.player) return;
  clearTimeout(state.provisionTimer);

  const player = new state.lib.Player('videoHolder', {
    video_bitrate: state.bitrateKbps,
    audio_bitrate: 0,
    // Do not ask for an I-frame every 5 s. On a lossless LAN that only adds
    // periodic bitrate spikes; WebRTC requests keyframes on actual loss.
    keyframe_interval: 0,
  });
  state.player = player;
  preferCodecs(player);

  player.onConnectionStateChange((connectionState) => {
    setStateLabel(connectionState);
    if (connectionState === 'connected') {
      toast('Поток установлен');
      // Controller registration must happen after the control-channel
      // authorization handshake; otherwise its sendGamepadState(0,false)
      // clears the handler we just installed.
      attachGamepad(player);
      startPingLoop();
    }
    if (connectionState === 'failed' || connectionState === 'disconnected') {
      toast('Соединение ' + connectionState, 4000);
    }
  });

  try {
    const offer = await player.createOffer();
    if (state.bitrateKbps > 0) offer.sdp = setVideoBandwidth(offer.sdp, state.bitrateKbps);
    if (state.forceLan) offer.sdp = filterSdpCandidates(offer.sdp);
    await waitForIce(player._peerConnection, 1500);

    const sdpResponse = await state.stream.sendSDPOffer(offer);
    const answer = JSON.parse(sdpResponse.exchangeResponse);
    player.setRemoteOffer(state.forceLan ? filterSdpCandidates(answer.sdp) : answer.sdp);

    let localCandidates = player.getIceCandidates().filter((c) => c && c.candidate);
    if (state.forceLan) {
      const lanOnly = localCandidates.filter((c) => isLocalCandidate(c.candidate));
      if (lanOnly.length) localCandidates = lanOnly;
      else toast('LAN-кандидаты не собрались — отправлены все', 4000);
    }
    if (!localCandidates.length) {
      throw new Error('No local ICE candidates. Check the Ethernet adapter and firewall.');
    }

    const payload = localCandidates.map((c) =>
      JSON.stringify({
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      })
    );

    const iceResponse = await state.stream.sendIceCandidates(payload);
    let remoteCandidates = JSON.parse(iceResponse.exchangeResponse);
    if (!Array.isArray(remoteCandidates)) remoteCandidates = [];
    remoteCandidates = remoteCandidates
      .map((candidate) => {
        if (typeof candidate !== 'string') return candidate;
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (state.forceLan) {
      const lanOnly = remoteCandidates.filter((c) => isLocalCandidate(candidateString(c)));
      if (lanOnly.length) {
        remoteCandidates = lanOnly;
      } else {
        toast('Консоль не предложила LAN-кандидатов — возможен WAN/Teredo', 5000);
      }
    }
    player.setRemoteIceCandidates(remoteCandidates);

    attachMetrics(player);
  } catch (err) {
    failStream('WebRTC setup failed: ' + String(err.message || err));
  }
}

function attachMetrics(player) {
  if (state.metrics) state.metrics.stop();
  state.metrics = new Metrics();
  state.metrics.attach(player._peerConnection, renderMetrics);

  // Ask Chromium for the smallest playout buffer it will accept. Both properties
  // are experimental; unsupported Chromium builds silently ignore them.
  for (const receiver of player._peerConnection.getReceivers()) {
    try {
      receiver.playoutDelayHint = 0;
    } catch {
      /* ignore */
    }
    try {
      receiver.jitterBufferTarget = 0;
    } catch {
      /* ignore */
    }
  }

  clearInterval(state.videoProbe);
  state.videoProbe = setInterval(() => {
    const video = player.getVideoElement && player.getVideoElement();
    if (video) {
      state.metrics.bindVideo(video);
      attachMkb(player, video);
      enableUpscaler(video);
      clearInterval(state.videoProbe);
      state.videoProbe = null;
    }
  }, 200);
}

function attachGamepad(player) {
  if (!state.gamepadEnabled || state.gamepad || !state.lib?.Gamepad) return;
  // In KBM->pad mode the virtual controller owns index 0.
  if (state.kbmPadEnabled && state.mkbEnabled) return;
  try {
    state.gamepad = new state.lib.Gamepad(0);
    state.gamepad.attach(player);

    // The control-channel authorization sends sendGamepadState(0,false)
    // shortly after connect and can race with attach(). Re-register the
    // handler once the handshake has settled.
    setTimeout(() => {
      if (!state.gamepad || !state.player) return;
      const handlers = state.player._channels.control._gamepadHandlers;
      if (!handlers[0]) {
        state.player._channels.control.sendGamepadState(0, true, state.gamepad);
      }
    }, 2500);
  } catch (err) {
    console.warn('[gamepad] attach failed:', err);
    state.gamepad = null;
  }
}

function detachGamepad() {
  if (!state.gamepad) return;
  try {
    state.gamepad.detach();
  } catch {
    /* ignore */
  }
  state.gamepad = null;
}

function attachKbmPad(player, video) {
  if (!state.mkbEnabled || state.kbmPad || !state.lib?.Gamepad || !window.KbmPad) return;
  // The virtual pad must own gamepad index 0.
  detachGamepad();
  try {
    state.kbmPad = new window.KbmPad(player, state.lib.Gamepad, {
      sensitivity: state.kbmSensitivity,
      onProfileChange: (profile) => {
        const labels = {
          onfoot: 'ON FOOT',
          vehicle: 'VEHICLE',
          aircraft: 'AIRCRAFT',
          bicycle: 'BICYCLE',
        };
        const el = $('padProfile');
        if (el) {
          el.textContent = labels[profile] || profile;
          el.classList.remove('hidden');
        }
        toast('Pad profile: ' + (labels[profile] || profile), 1400);
      },
    });
    state.kbmPad.attach(video);
    const profileEl = $('padProfile');
    if (profileEl) {
      profileEl.textContent = 'ON FOOT';
      profileEl.classList.remove('hidden');
    }

    setTimeout(() => {
      if (state.kbmPad) state.kbmPad.ensureRegistered();
    }, 2500);
  } catch (err) {
    console.warn('[kbm-pad] attach failed:', err);
    state.kbmPad = null;
  }
}

function attachMkb(player, video) {
  if (!state.mkbEnabled) return;
  if (state.kbmPadEnabled) {
    attachKbmPad(player, video);
    return;
  }
  if (state.mkb || !state.lib?.MouseKeyboard) return;
  try {
    // Physical gamepad is always index 0; MKB is a second virtual controller
    // so it can never evict the gamepad handler (including during the auth
    // handshake, which toggles index 0).
    const mkb = new state.lib.MouseKeyboard(1);
    mkb.attach(player);
    state.mkb = mkb;

    // The library's click handler forces HTML fullscreen + keyboard lock.
    // Replace it with a plain raw pointer lock that cooperates with Electron.
    try {
      const oldLock = mkb._listener?.lockMouseKeyboard;
      if (oldLock) video.removeEventListener('click', oldLock);
      video.addEventListener('click', () => {
        if (document.pointerLockElement === video) {
          document.exitPointerLock();
          return;
        }
        const request = video.requestPointerLock({ unadjustedMovement: true });
        if (request && typeof request.catch === 'function') {
          request.catch(() => video.requestPointerLock());
        }
      });
    } catch {
      /* keep the library behaviour */
    }

    state.wheelHandler = (event) => {
      event.preventDefault();
      player._channels.input.queueMouseFrame({
        X: 0,
        Y: 0,
        WheelX: 0,
        WheelY: event.deltaY,
        Buttons: event.buttons,
        Relative: 0,
      });
    };
    video.addEventListener('wheel', state.wheelHandler, { passive: false });

    document.addEventListener('pointerlockchange', onPointerLockChange);
  } catch (err) {
    console.warn('[mkb] attach failed:', err);
    state.mkb = null;
  }
}

function detachMkb() {
  $('padProfile')?.classList.add('hidden');
  if (state.kbmPad) {
    try {
      state.kbmPad.detach();
    } catch {
      /* ignore */
    }
    state.kbmPad = null;
  }
  if (state.wheelHandler && state.player?.getVideoElement?.()) {
    state.player.getVideoElement().removeEventListener('wheel', state.wheelHandler);
  }
  state.wheelHandler = null;
  document.removeEventListener('pointerlockchange', onPointerLockChange);
  if (state.mkb) {
    try {
      state.mkb.detach();
    } catch {
      /* ignore */
    }
    state.mkb = null;
  }
}

function onPointerLockChange() {
  const video = state.player?.getVideoElement?.();
  if (document.pointerLockElement === video) {
    toast('Мышь захвачена · Esc — освободить', 2500);
  }
}

function enableUpscaler(video) {
  if (!state.upscaleEnabled || state.upscaler || !window.Upscaler) return;
  try {
    const upscaler = new window.Upscaler($('videoHolder'), video, {
      sharpness: state.sharpness,
      interpolate: state.smoothEnabled,
      targetFps: state.smoothFps,
    });
    if (upscaler.ok) state.upscaler = upscaler;
    else upscaler.destroy();
  } catch (err) {
    console.warn('[upscaler] failed:', err);
  }
}

function disableUpscaler() {
  if (state.upscaler) {
    state.upscaler.destroy();
    state.upscaler = null;
  }
}

function startPingLoop() {
  clearInterval(state.pingTimer);
  const run = async () => {
    const host = state.metrics?.last?.remote?.address;
    if (!host) return;
    const result = await window.lan.net.ping(host);
    state.metrics?.setPing(result ? result.avg : null);
  };
  run();
  state.pingTimer = setInterval(run, 3000);
}

function renderMetrics(m) {
  const smoothDelay = state.upscaler?.interpolate ? 1000 / (m.fps || 30) : 0;
  const latency = m.latency != null ? m.latency + smoothDelay : null;
  $('m-latency').textContent = latency != null ? latency.toFixed(0) : '—';
  const framePart = m.pipeline
    ? `frame ${m.pipeline.toFixed(1)}`
    : `buf+dec ${(m.bufferMs + m.decodeMs).toFixed(1)}`;
  const smoothPart = smoothDelay ? ` + smooth ${smoothDelay.toFixed(0)}` : '';
  $('m-latency-parts').textContent =
    m.rtt != null ? `rtt/2 ${(m.rtt / 2).toFixed(1)} + ${framePart}${smoothPart} ms` : 'нет данных candidate-pair';

  $('m-rtt').textContent = m.rtt == null ? '—' : m.rtt < 0.2 ? '<0.2' : m.rtt.toFixed(1);
  $('m-ping').textContent = m.ping != null ? m.ping.toFixed(0) : '—';
  $('m-bitrate').textContent = m.bitrate ? m.bitrate.toFixed(1) : '0.0';
  $('m-fps').textContent = m.fps ? m.fps.toFixed(0) : '—';
  $('m-decode').textContent = m.decodeMs ? m.decodeMs.toFixed(2) : '—';
  $('m-buffer').textContent = m.bufferMs ? m.bufferMs.toFixed(1) : '—';
  $('m-loss').textContent = m.loss.toFixed(2);
  $('m-jitter').textContent = Number.isFinite(m.jitter) ? m.jitter.toFixed(1) : '—';
  $('m-freeze').textContent = (m.freezeDuration || 0).toFixed(1);
  $('m-drop').textContent = m.framesDropped || 0;
  $('m-res').textContent = m.width && m.height ? `${m.width}×${m.height}` : '—';
  $('m-codec').textContent = m.codec ? m.codec.toUpperCase() : '';

  if (m.stalled) {
    setStateLabel('stalled');
    // Ask the host for an I-frame, at most once every 4 s, to recover quickly
    // from a lost reference frame without waiting for the next GOP.
    if (Date.now() - state.lastKeyframeRequest > 4000 && state.player) {
      state.lastKeyframeRequest = Date.now();
      try {
        state.player._channels.control.requestKeyframeRequest(true);
      } catch {
        /* control channel may not be ready */
      }
    }
  } else if ($('m-state').textContent === 'stalled') {
    setStateLabel('connected');
  }

  const pill = $('m-path');
  pill.className = 'path-pill ' + (m.path.kind === 'lan' ? 'lan' : m.path.kind === 'wan' || m.path.kind === 'relay' ? 'wan' : '');
  pill.textContent = m.path.label;

  $('m-remote').textContent = m.remote
    ? `${m.remote.address}:${m.remote.port} · ${m.remote.type}/${m.remote.protocol}`
    : 'ожидание ICE';

  if (state.showDecode) {
    $('decodeBadge').textContent =
      `decode ${m.decodeMs ? m.decodeMs.toFixed(2) : '—'} ms · jb ${m.bufferMs ? m.bufferMs.toFixed(1) : '—'} ms · ` +
      `${m.fps ? m.fps.toFixed(0) : '—'} fps${m.stalled ? ' · STALL' : ''}`;
  }
  $('factLatency').textContent = latency != null ? latency.toFixed(0) : '—';

  Metrics.drawGraph($('m-graph'), state.metrics ? state.metrics.history : []);
}

function stopStream() {
  state.lastStopAt = Date.now();
  window.lan.power.stream(false).catch(() => {});
  clearInterval(state.keepalive);
  clearInterval(state.pingTimer);
  clearTimeout(state.provisionTimer);
  clearInterval(state.videoProbe);
  state.videoProbe = null;

  detachMkb();
  if (state.upscaler) {
    state.upscaler.destroy();
    state.upscaler = null;
  }
  state.fullscreen = false;
  window.lan.win.fullscreen(false).catch(() => {});

  detachGamepad();

  if (state.metrics) {
    state.metrics.stop();
    state.metrics = null;
  }

  if (state.player) {
    try {
      state.player.destroy();
    } catch {
      /* ignore */
    }
    state.player = null;
  }

  if (state.stream) {
    try {
      state.stream.stop().catch(() => {});
    } catch {
      /* ignore */
    }
    state.stream = null;
  }

  $('videoHolder').innerHTML = '';
  state.streaming = false;
  $('btnStream').disabled = false;
  showStreamView(false);
}

function failStream(message) {
  $('connectError').textContent = message;
  toast(message, 6000);
  stopStream();
}

function showStreamView(streaming) {
  $('connectView').classList.toggle('hidden', streaming);
  $('streamView').classList.toggle('hidden', !streaming);
  if (streaming) {
    $('streamView').classList.remove('hidden');
  }
}

function setStateLabel(label) {
  $('m-state').textContent = label;
}



/* --------------------------------------------------------------- helpers */

function waitForIce(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (!pc || pc.iceGatheringState === 'complete') return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      if (pc.iceGatheringState === 'complete' || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

function candidateString(candidate) {
  if (!candidate) return '';
  if (typeof candidate === 'string') return candidate;
  return candidate.candidate || '';
}

function candidateAddress(candidate) {
  const text = candidateString(candidate).replace(/^a=/, '');
  const parts = text.split(' ');
  return parts[4] || '';
}

function preferCodecs(player) {
  try {
    const caps = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
    const score = (codec) => {
      const mime = String(codec.mimeType || '').toLowerCase();
      const fmtp = String(codec.sdpFmtpLine || '');
      if (mime.includes('rtx')) return -1;
      if (mime.includes('h264')) {
        if (fmtp.includes('profile-level-id=6400')) return 100;
        if (fmtp.includes('profile-level-id=4d00')) return 95;
        if (fmtp.includes('profile-level-id=42e0')) return 90;
        if (fmtp.includes('profile-level-id=4200')) return 85;
        if (fmtp.includes('profile-level-id=f400')) return 80;
        return 75;
      }
      if (mime.includes('h265') || mime.includes('hev1') || mime.includes('hvc1')) return 70;
      if (mime.includes('av1')) return 60;
      if (mime.includes('vp9')) return 50;
      if (mime.includes('vp8')) return 40;
      if (mime.includes('ulpfec') || mime.includes('flexfec') || mime.includes('red')) return 30;
      return 10;
    };

    const preferred = caps
      .filter((codec) => score(codec) > 0)
      .slice()
      .sort((a, b) => score(b) - score(a));

    if (!preferred.length) return;
    for (const transceiver of player._peerConnection.getTransceivers()) {
      if (transceiver.receiver?.track?.kind === 'video') {
        transceiver.setCodecPreferences(preferred);
      }
    }
  } catch (err) {
    console.warn('[codecs] preference update failed:', err);
  }
}

function setVideoBandwidth(sdp, kbps) {
  if (!sdp || !(kbps > 0)) return sdp;
  const lines = sdp.split(/\r?\n/);
  const out = [];
  let inVideo = false;
  let inserted = false;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (inVideo && !inserted) {
        out.push(`b=AS:${kbps}`);
        out.push(`b=TIAS:${kbps * 1000}`);
      }
      inVideo = line.startsWith('m=video');
      inserted = false;
      out.push(line);
      continue;
    }
    if (inVideo && (line.startsWith('b=AS:') || line.startsWith('b=TIAS:'))) continue;
    if (inVideo && !inserted && line.startsWith('a=')) {
      out.push(`b=AS:${kbps}`);
      out.push(`b=TIAS:${kbps * 1000}`);
      inserted = true;
    }
    out.push(line);
  }
  if (inVideo && !inserted) {
    out.push(`b=AS:${kbps}`);
    out.push(`b=TIAS:${kbps * 1000}`);
  }
  return out.join('\r\n');
}

function filterSdpCandidates(sdp) {
  if (!sdp) return sdp;
  return sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true;
      return isLocalCandidate(line.slice(2));
    })
    .join('\r\n');
}

function isLocalCandidate(candidate) {
  const address = candidateAddress(candidate);
  if (!address) return false;
  if (address.endsWith('.local')) return true;
  if (address.startsWith('fe80')) return true;
  const ipv4 = address.split('.');
  if (ipv4.length !== 4) return false;
  return (
    ipv4[0] === '10' ||
    ipv4[0] === '192' && ipv4[1] === '168' ||
    ipv4[0] === '172' && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31 ||
    ipv4[0] === '169' && ipv4[1] === '254'
  );
}

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* --------------------------------------------------------------- wiring */

function wireUi() {
  $('btnStream').addEventListener('click', startStream);
  $('btnStop').addEventListener('click', () => stopStream());
  $('btnRefreshConsoles').addEventListener('click', () => loadConsoles());

  $('optForceLan').addEventListener('change', (event) => {
    state.forceLan = event.target.checked;
  });
  $('optGamepad').addEventListener('change', (event) => {
    state.gamepadEnabled = event.target.checked;
    if (!state.gamepadEnabled) {
      detachGamepad();
    } else if (state.player && state.player._peerConnection.connectionState === 'connected') {
      attachGamepad(state.player);
    }
  });
  $('optMkb').addEventListener('change', (event) => {
    state.mkbEnabled = event.target.checked;
    if (!state.mkbEnabled) {
      detachMkb();
      if (state.player?._peerConnection.connectionState === 'connected') attachGamepad(state.player);
    } else if (state.player?.getVideoElement?.()) {
      attachMkb(state.player, state.player.getVideoElement());
    }
  });

  $('optKbmPad').addEventListener('change', (event) => {
    state.kbmPadEnabled = event.target.checked;
    if (!state.streaming) return;
    detachMkb();
    detachGamepad();
    const video = state.player?.getVideoElement?.();
    if (state.kbmPadEnabled) {
      if (video) attachKbmPad(state.player, video);
    } else {
      attachGamepad(state.player);
      if (video) attachMkb(state.player, video);
    }
  });

  $('inpKbmSens').addEventListener('input', (event) => {
    state.kbmSensitivity = Math.max(0.1, Math.min(3, Number(event.target.value) || 1));
    $('kbmSensValue').textContent = state.kbmSensitivity.toFixed(2);
    if (state.kbmPad) state.kbmPad.setSensitivity(state.kbmSensitivity);
  });

  $('btnSettings').addEventListener('click', () => toggleDrawer(true));
  $('btnCloseSettings').addEventListener('click', () => toggleDrawer(false));
  $('drawerScrim').addEventListener('click', () => toggleDrawer(false));

  $('btnRefreshAuth').addEventListener('click', async () => {
    try {
      await window.lan.auth.refresh();
      toast('Токен обновлён');
    } catch (err) {
      toast(String(err.message || err), 5000);
    }
  });
  $('btnLogout').addEventListener('click', async () => {
    await window.lan.auth.forget();
    state.api = null;
    state.consoles = [];
    state.selectedId = null;
    renderConsoles();
    toast('Вы вышли из аккаунта');
  });

  $('btnIcsOn').addEventListener('click', async () => {
    const publicAlias = $('selPublic').value;
    const privateAlias = $('selPrivate').value;
    if (!publicAlias || !privateAlias || publicAlias === privateAlias) {
      $('icsStatus').textContent = 'Выберите два разных адаптера.';
      return;
    }
    $('icsStatus').textContent = 'Включаю ICS…';
    const result = await window.lan.ics.enable({ publicAlias, privateAlias });
    $('icsStatus').textContent = JSON.stringify(result, null, 2);
    loadNetworkInfo().catch(() => {});
  });

  $('btnIcsOff').addEventListener('click', async () => {
    $('icsStatus').textContent = 'Выключаю ICS…';
    const result = await window.lan.ics.disable();
    $('icsStatus').textContent = JSON.stringify(result, null, 2);
    loadNetworkInfo().catch(() => {});
  });

  $('btnNatOn').addEventListener('click', async () => {
    const publicAlias = $('selPublic').value;
    const privateAlias = $('selPrivate').value;
    if (!publicAlias || !privateAlias || publicAlias === privateAlias) {
      $('icsStatus').textContent = 'Выберите два разных адаптера.';
      return;
    }
    $('icsStatus').textContent = 'Включаю NAT fallback…';
    const result = await window.lan.nat.enable({ publicAlias, privateAlias });
    $('icsStatus').textContent = JSON.stringify(result, null, 2);
    loadNetworkInfo().catch(() => {});
  });

  $('btnNatOff').addEventListener('click', async () => {
    $('icsStatus').textContent = 'Выключаю NAT fallback…';
    const result = await window.lan.nat.disable();
    $('icsStatus').textContent = JSON.stringify(result, null, 2);
    loadNetworkInfo().catch(() => {});
  });

  $('inpBitrate').addEventListener('change', (event) => {
    state.bitrateKbps = Math.max(0, Number(event.target.value) || 0);
  });

  $('optUpscale').addEventListener('change', (event) => {
    state.upscaleEnabled = event.target.checked;
    const video = state.player?.getVideoElement?.();
    if (state.upscaleEnabled && video) enableUpscaler(video);
    else if (!state.upscaleEnabled) disableUpscaler();
  });

  $('inpSharp').addEventListener('input', (event) => {
    state.sharpness = Math.max(0, Math.min(1.5, Number(event.target.value) || 0));
    $('sharpValue').textContent = state.sharpness.toFixed(2);
    if (state.upscaler) state.upscaler.setSharpness(state.sharpness);
  });

  $('optSmooth').addEventListener('change', (event) => {
    state.smoothEnabled = event.target.checked;
    if (!state.upscaler) {
      if (state.smoothEnabled) toast('Сначала включите upscale + sharpen', 3000);
      return;
    }
    state.upscaler.setInterpolation(state.smoothEnabled, state.smoothFps);
    toast(
      state.smoothEnabled
        ? `Smooth ${state.smoothFps} включён: +1 кадр задержки, возможен ghosting`
        : 'Smooth выключен',
      3000
    );
  });

  $('selSmoothFps').addEventListener('change', (event) => {
    state.smoothFps = Number(event.target.value) === 60 ? 60 : 45;
    if (state.upscaler) {
      state.upscaler.setInterpolation(state.smoothEnabled, state.smoothFps);
    }
  });

  $('optLowLatency').addEventListener('change', async (event) => {
    const wanted = event.target.checked;
    const ok = window.confirm(
      'Приложение перезапустится, стрим закроется.\\n\\n' +
        (wanted
          ? 'Max low-latency: минимальная задержка, выше нагрузка GPU и возможен tearing.'
          : 'Balanced: vsync, ниже нагрузка GPU, задержка +~10 мс.')
    );
    if (!ok) {
      event.target.checked = !wanted;
      return;
    }
    await window.lan.relaunch(wanted);
  });

  window.addEventListener('keydown', (event) => {
    if (['F1', 'F3', 'F11', 'Escape'].includes(event.key)) {
      // Do not leak UI hotkeys into the virtual keyboard channel.
      event.stopImmediatePropagation();
    }

    if (event.key === 'F1') {
      event.preventDefault();
      state.hudVisible = !state.hudVisible;
      $('hud').classList.toggle('hidden', !state.hudVisible);
    } else if (event.key === 'F3') {
      event.preventDefault();
      state.showDecode = !state.showDecode;
      $('decodeBadge').classList.toggle('hidden', !state.showDecode);
    } else if (event.key === 'F11') {
      event.preventDefault();
      state.fullscreen = !state.fullscreen;
      window.lan.win.fullscreen(state.fullscreen);
    } else if (event.key === 'Escape') {
      if (document.pointerLockElement) {
        document.exitPointerLock();
        return;
      }
      toggleDrawer(false);
      if (state.fullscreen) {
        state.fullscreen = false;
        window.lan.win.fullscreen(false);
      } else if (state.streaming) {
        stopStream();
      }
    }
  });
}

function toggleDrawer(open) {
  $('settings').classList.toggle('hidden', !open);
  $('drawerScrim').classList.toggle('hidden', !open);
  $('settings').setAttribute('aria-hidden', String(!open));
  if (open) loadNetworkInfo().catch(() => {});
}

async function loadNetworkInfo() {
  const [ifaces, adapters, ics, nat] = await Promise.all([
    window.lan.net.interfaces(),
    window.lan.net.adapters(),
    window.lan.ics.status(),
    window.lan.nat.status(),
  ]);

  $('ifaceList').innerHTML = ifaces.length
    ? ifaces
        .map(
          (i) => `<div class="kv-row"><span>${escapeHtml(i.name)}</span><span>${escapeHtml(
            i.address
          )}${i.icsHost ? ' · ICS' : ''}</span></div>`
        )
        .join('')
    : '<div class="kv-row"><span>нет интерфейсов</span><span></span></div>';

  const publicSelect = $('selPublic');
  const privateSelect = $('selPrivate');
  const currentPublic = publicSelect.value;
  const currentPrivate = privateSelect.value;
  const physical = adapters.filter((a) => a.Status === 'Up' && a.Virtual !== true);
  const usable = physical.length ? physical : adapters.filter((a) => a.Status === 'Up');
  const options = usable
    .map((a) => `<option value="${escapeHtml(a.Name)}">${escapeHtml(a.Name)} — ${escapeHtml(a.LinkSpeed || '')}</option>`)
    .join('');
  publicSelect.innerHTML = options;
  privateSelect.innerHTML = options;
  if (currentPublic) publicSelect.value = currentPublic;
  if (currentPrivate) privateSelect.value = currentPrivate;
  if (adapters.length > 1 && !privateSelect.value) {
    privateSelect.selectedIndex = Math.min(1, adapters.length - 1);
  }

  $('icsStatus').textContent = JSON.stringify({ ics, nat }, null, 2);
  $('accountInfo').innerHTML = `
    <div class="kv-row"><span>состояние</span><span>${escapeHtml(state.auth?.state || '—')}</span></div>
    <div class="kv-row"><span>gamertag</span><span>${escapeHtml(state.auth?.gamertag || '—')}</span></div>
    <div class="kv-row"><span>region</span><span>${escapeHtml(state.auth?.baseUri || '—')}</span></div>
  `;
}

function renderAppInfo() {
  $('optLowLatency').checked = Boolean(state.info.lowLatency);
  $('appInfo').innerHTML = `
    <div class="kv-row"><span>версия</span><span>${escapeHtml(state.info.version)}</span></div>
    <div class="kv-row"><span>electron</span><span>${escapeHtml(state.info.electron)}</span></div>
    <div class="kv-row"><span>chromium</span><span>${escapeHtml(state.info.chrome)}</span></div>
    <div class="kv-row"><span>proxy</span><span>${escapeHtml(state.apiBase)}</span></div>
  `;
}
