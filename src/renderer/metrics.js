'use strict';

/**
 * WebRTC metrics collector for the xHome stream.
 *
 * Sources:
 *  - inbound-rtp      : bitrate, fps, resolution, decode time, jitter buffer, loss
 *  - candidate-pair   : STUN RTT on the actual media path + path classification
 *  - rVFC             : receive -> display pipeline (Chromium's frame timing)
 *
 * There is no public API for glass-to-glass latency: the console does not stamp
 * frames and input events are not observable. The HUD therefore shows a measured
 * estimate (RTT/2 + frame pipeline) and every component separately.
 */

class Metrics {
  constructor() {
    this.pc = null;
    this.video = null;
    this.onUpdate = () => {};
    this.timer = null;
    this.prev = null;
    this.frame = { pipeline: 0, processing: 0, count: 0, lastAt: 0 };
    this.smooth = { pipeline: 0, processing: 0 };
    this.ping = null;
    this.history = [];
    this.last = null;
    this._videoBound = false;
    this._rafId = null;
  }

  attach(pc, onUpdate) {
    this.pc = pc;
    this.onUpdate = onUpdate || (() => {});
    this.prev = null;
    this.history = [];
    this.timer = setInterval(() => this._tick(), 1000);
    this._tick();
  }

  bindVideo(video) {
    if (!video || this._videoBound) return;
    this.video = video;
    this._videoBound = true;

    if (video.paused) video.play().catch(() => {});
    if (typeof video.requestVideoFrameCallback !== 'function') return;

    const onFrame = (_now, meta) => {
      if (!this.pc) return;
      const pipeline = Math.max(0, Math.min(1000, meta.expectedDisplayTime - meta.receiveTime));
      const processing = Math.max(0, Math.min(1000, (meta.processingDuration || 0) * 1000));
      if (pipeline > 0 && pipeline < 900) {
        this.frame.pipeline = pipeline;
        this.smooth.pipeline = this.smooth.pipeline
          ? this.smooth.pipeline * 0.85 + pipeline * 0.15
          : pipeline;
      }
      if (processing > 0) {
        this.frame.processing = processing;
        this.smooth.processing = this.smooth.processing
          ? this.smooth.processing * 0.85 + processing * 0.15
          : processing;
      }
      this.frame.count += 1;
      this.frame.lastAt = performance.now();
      this._rafId = video.requestVideoFrameCallback(onFrame);
    };
    this._rafId = video.requestVideoFrameCallback(onFrame);
  }

  setPing(ping) {
    this.ping = ping;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.video && this._rafId != null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this._rafId);
    }
    this.pc = null;
  }

  async _tick() {
    if (!this.pc) return;
    let reports;
    try {
      reports = await this.pc.getStats();
    } catch {
      return;
    }

    const byId = new Map();
    let inbound = null;
    let pair = null;
    let codec = null;

    reports.forEach((r) => byId.set(r.id, r));

    reports.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
        if (!inbound || (r.bytesReceived || 0) > (inbound.bytesReceived || 0)) inbound = r;
      }
      if (r.type === 'candidate-pair' && (r.selected === true || (r.state === 'succeeded' && r.nominated))) {
        if (
          !pair ||
          (r.bytesReceived || 0) > (pair.bytesReceived || 0) ||
          (r.currentRoundTripTime != null && pair.currentRoundTripTime == null)
        ) {
          pair = r;
        }
      }
    });

    // Older Chromium builds omit `selected`/`nominated`; fall back to the pair
    // that actually carried RTP bytes.
    if (!pair) {
      reports.forEach((r) => {
        if (r.type !== 'candidate-pair' || r.state !== 'succeeded') return;
        if ((r.bytesReceived || 0) <= 0 && (r.bytesSent || 0) <= 0) return;
        if (!pair || (r.bytesReceived || 0) > (pair.bytesReceived || 0)) pair = r;
      });
    }

    if (inbound && inbound.codecId) codec = byId.get(inbound.codecId);
    if (inbound && !codec && inbound.codecId) codec = reports.get ? reports.get(inbound.codecId) : null;

    const local = pair ? byId.get(pair.localCandidateId) : null;
    const remote = pair ? byId.get(pair.remoteCandidateId) : null;

    const now = inbound && inbound.timestamp ? inbound.timestamp : performance.now();
    const delta = this.prev ? now - this.prev.at : 0;
    const p = this.prev || {};

    const d = (key) => {
      if (!inbound || inbound[key] == null) return 0;
      const value = inbound[key];
      if (p[key] == null) return 0;
      const diff = value - p[key];
      return diff >= 0 ? diff : 0;
    };

    let bitrate = 0;
    let fps = inbound && inbound.framesPerSecond ? inbound.framesPerSecond : 0;
    let decodeMs = 0;
    let bufferMs = 0;
    let loss = 0;

    if (delta > 250 && inbound) {
      bitrate = (d('bytesReceived') * 8) / (delta / 1000) / 1_000_000;

      const frames = d('framesDecoded');
      if (!fps && frames > 0) fps = frames / (delta / 1000);

      const decodeTime = d('totalDecodeTime');
      if (frames > 0 && decodeTime > 0) decodeMs = (decodeTime / frames) * 1000;

      const jbDelay = d('jitterBufferDelay');
      const jbEmitted = d('jitterBufferEmittedCount');
      if (jbEmitted > 0 && jbDelay > 0) bufferMs = (jbDelay / jbEmitted) * 1000;

      const lost = d('packetsLost');
      const received = d('packetsReceived');
      const total = lost + received;
      if (total > 0) loss = (lost / total) * 100;
    }

    const rtt = pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null;
    const path = classifyPath(remote, local);

    const pipeline = this.smooth.pipeline || 0;
    const render = this.smooth.processing || 0;
    const latency = rtt != null ? rtt / 2 + (pipeline || bufferMs + decodeMs + 8) : pipeline || null;

    const snapshot = {
      at: Date.now(),
      bitrate,
      fps,
      width: (inbound && (inbound.frameWidth || inbound.width)) || 0,
      height: (inbound && (inbound.frameHeight || inbound.height)) || 0,
      decodeMs,
      bufferMs,
      loss,
      rtt,
      ping: this.ping,
      pipeline,
      render,
      latency,
      framesDecoded: inbound ? inbound.framesDecoded || 0 : 0,
      packetsLost: inbound ? inbound.packetsLost || 0 : 0,
      nack: inbound ? inbound.nackCount || 0 : 0,
      pli: inbound ? inbound.pliCount || 0 : 0,
      jitter: inbound && inbound.jitter ? inbound.jitter * 1000 : 0,
      freezeCount: inbound ? inbound.freezeCount || 0 : 0,
      freezeDuration: inbound ? inbound.totalFreezesDuration || 0 : 0,
      framesDropped: inbound ? inbound.framesDropped || 0 : 0,
      codec: codec ? String(codec.mimeType || '').replace('video/', '') : (inbound ? 'H.264' : ''),
      path,
      remote: remote
        ? {
            address: remote.address,
            port: remote.port,
            type: remote.candidateType,
            protocol: remote.protocol,
          }
        : null,
      local: local
        ? {
            address: local.address,
            port: local.port,
            type: local.candidateType,
            protocol: local.protocol,
          }
        : null,
      frameAge: this.frame.lastAt ? performance.now() - this.frame.lastAt : null,
      stalled: this.frame.lastAt ? performance.now() - this.frame.lastAt > 1500 : false,
    };

    this.prev = { at: now };
    if (inbound) {
      for (const key of [
        'bytesReceived',
        'framesDecoded',
        'totalDecodeTime',
        'jitterBufferDelay',
        'jitterBufferEmittedCount',
        'packetsLost',
        'packetsReceived',
      ]) {
        this.prev[key] = inbound[key];
      }
    }

    this.last = snapshot;
    this.history.push({ t: snapshot.at, latency: latency || 0, bitrate });
    if (this.history.length > 90) this.history.shift();

    this.onUpdate(snapshot);
  }
}

function isPrivateIPv4(ip) {
  if (!ip) return false;
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip)
  );
}

function classifyPath(remote, local) {
  if (!remote) return { kind: 'unknown', label: 'PATH ?' };
  const type = remote.candidateType;
  const address = remote.address || '';
  const isV6 = address.includes(':');
  const privateAddr = isV6 ? address.startsWith('fe80') : isPrivateIPv4(address);

  if (type === 'relay') return { kind: 'relay', label: 'RELAY (TURN)' };
  if (privateAddr || address.endsWith('.local')) {
    return { kind: 'lan', label: `LAN ${address}` };
  }
  if (type === 'srflx' || type === 'prflx') return { kind: 'wan', label: 'WAN (NAT)' };
  if (isV6) return { kind: 'wan', label: 'IPv6 WAN' };
  return { kind: type || 'unknown', label: `PATH ${type || '?'}` };
}

function drawGraph(canvas, history) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 260;
  const cssH = canvas.clientHeight || 42;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const values = history.map((h) => h.latency || 0);
  if (values.length < 2) return;
  const max = Math.max(30, ...values) * 1.25;
  const step = cssW / Math.max(1, values.length - 1);

  ctx.beginPath();
  ctx.moveTo(0, cssH);
  values.forEach((v, i) => {
    const x = i * step;
    const y = cssH - (Math.min(v, max) / max) * (cssH - 6) - 3;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(cssW, cssH);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, 0, 0, cssH);
  gradient.addColorStop(0, 'rgba(182, 243, 106, 0.35)');
  gradient.addColorStop(1, 'rgba(182, 243, 106, 0.02)');
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = cssH - (Math.min(v, max) / max) * (cssH - 6) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#b6f36a';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

window.Metrics = Metrics;
window.Metrics.drawGraph = drawGraph;
