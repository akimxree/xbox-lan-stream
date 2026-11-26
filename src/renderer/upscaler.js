'use strict';

/**
 * GPU post-process for the decoded video.
 *
 * Default path: Catmull-Rom (bicubic) upscale + RCAS-like sharpening.
 *
 * Optional experimental path: 30 -> 45/60 display interpolation. It needs the
 * next decoded frame before it can synthesize an in-between one, so it adds
 * roughly one source frame of latency and produces cross-fade ghosting. It is
 * NOT FSR 3 Frame Generation: a video stream has no motion vectors or depth.
 */

class Upscaler {
  constructor(container, video, options = {}) {
    this.container = container;
    this.video = video;
    this.sharpness = Math.max(0, Math.min(1.5, options.sharpness ?? 0.42));
    this.interpolate = Boolean(options.interpolate);
    this.targetFps = Math.max(30, Math.min(60, Number(options.targetFps) || 45));
    this.destroyed = false;
    this.ok = false;
    this.hasFrame = false;
    this.pair = null;
    this.lastFrameAt = 0;
    this._blendTimer = null;
    this._videoCallback = null;
    this._ro = null;
    this._onFrame = this._onFrame.bind(this);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'upscale-canvas';

    this.gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!this.gl) {
      this.destroy();
      return;
    }

    container.appendChild(this.canvas);
    this._initGl();
    if (!this.program) {
      this.destroy();
      return;
    }
    if (!this.blendProgram) this.interpolate = false;

    this.video.style.opacity = '0';
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._ro.observe(video);
    this._onVideoResize = () => this._resize();
    video.addEventListener('resize', this._onVideoResize);

    this._videoCallback = video.requestVideoFrameCallback(this._onFrame);
    if (this.interpolate) this._startBlendLoop();
    this.ok = true;
  }

  _compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[upscaler] shader:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(vs, fs) {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[upscaler] link:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  _createTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return texture;
  }

  _initGl() {
    const gl = this.gl;
    const vertexSource = `#version 300 es
      layout(location = 0) in vec2 aPos;
      out vec2 vUv;
      void main() {
        vUv = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }`;

    const vs = this._compile(gl.VERTEX_SHADER, vertexSource);
    const fs = this._compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      uniform sampler2D uTex;
      uniform vec2 uOut;
      uniform float uSharp;
      in vec2 vUv;
      out vec4 fragColor;

      float w0(float t) { return ((-0.5 * t + 1.0) * t - 0.5) * t; }
      float w1(float t) { return ((1.5 * t - 2.5) * t) * t + 1.0; }
      float w2(float t) { return ((-1.5 * t + 2.0) * t + 0.5) * t; }
      float w3(float t) { return ((0.5 * t - 0.5) * t) * t; }

      vec3 tap(vec2 p) {
        return texture(uTex, clamp(p / uOut, vec2(0.0), vec2(1.0))).rgb;
      }

      void main() {
        vec2 pos = vUv * uOut - 0.5;
        vec2 b = floor(pos);
        vec2 f = pos - b;
        vec4 wx = vec4(w0(f.x), w1(f.x), w2(f.x), w3(f.x));
        vec4 wy = vec4(w0(f.y), w1(f.y), w2(f.y), w3(f.y));

        vec3 c = vec3(0.0);
        c += tap(b + vec2(-1.0, -1.0) + 0.5) * wx.x * wy.x;
        c += tap(b + vec2( 0.0, -1.0) + 0.5) * wx.y * wy.x;
        c += tap(b + vec2( 1.0, -1.0) + 0.5) * wx.z * wy.x;
        c += tap(b + vec2( 2.0, -1.0) + 0.5) * wx.w * wy.x;

        c += tap(b + vec2(-1.0,  0.0) + 0.5) * wx.x * wy.y;
        c += tap(b + vec2( 0.0,  0.0) + 0.5) * wx.y * wy.y;
        c += tap(b + vec2( 1.0,  0.0) + 0.5) * wx.z * wy.y;
        c += tap(b + vec2( 2.0,  0.0) + 0.5) * wx.w * wy.y;

        c += tap(b + vec2(-1.0,  1.0) + 0.5) * wx.x * wy.z;
        c += tap(b + vec2( 0.0,  1.0) + 0.5) * wx.y * wy.z;
        c += tap(b + vec2( 1.0,  1.0) + 0.5) * wx.z * wy.z;
        c += tap(b + vec2( 2.0,  1.0) + 0.5) * wx.w * wy.z;

        c += tap(b + vec2(-1.0,  2.0) + 0.5) * wx.x * wy.w;
        c += tap(b + vec2( 0.0,  2.0) + 0.5) * wx.y * wy.w;
        c += tap(b + vec2( 1.0,  2.0) + 0.5) * wx.z * wy.w;
        c += tap(b + vec2( 2.0,  2.0) + 0.5) * wx.w * wy.w;

        vec3 blur = (
          tap(pos + vec2( 1.0,  0.0) + 0.5) +
          tap(pos + vec2(-1.0,  0.0) + 0.5) +
          tap(pos + vec2( 0.0,  1.0) + 0.5) +
          tap(pos + vec2( 0.0, -1.0) + 0.5)
        ) * 0.25;

        c += (c - blur) * uSharp;
        fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`
    );

    const fsBlend = this._compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      uniform sampler2D uA;
      uniform sampler2D uB;
      uniform vec2 uOut;
      uniform float uMix;
      uniform float uSharp;
      in vec2 vUv;
      out vec4 fragColor;

      void main() {
        vec3 a = texture(uA, vUv).rgb;
        vec3 b = texture(uB, vUv).rgb;
        vec3 c = mix(a, b, uMix);
        vec2 px = vec2(1.0) / uOut;
        vec3 blur = (
          texture(uB, vUv + vec2(px.x, 0.0)).rgb +
          texture(uB, vUv - vec2(px.x, 0.0)).rgb +
          texture(uB, vUv + vec2(0.0, px.y)).rgb +
          texture(uB, vUv - vec2(0.0, px.y)).rgb
        ) * 0.25;
        c += (c - blur) * uSharp;
        fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`
    );

    if (!vs || !fs) return;

    this.program = this._createProgram(vs, fs);
    if (fsBlend) this.blendProgram = this._createProgram(vs, fsBlend);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (fsBlend) gl.deleteShader(fsBlend);

    if (!this.program) return;

    this.uTex = gl.getUniformLocation(this.program, 'uTex');
    this.uOut = gl.getUniformLocation(this.program, 'uOut');
    this.uSharp = gl.getUniformLocation(this.program, 'uSharp');

    if (this.blendProgram) {
      this.bUa = gl.getUniformLocation(this.blendProgram, 'uA');
      this.bUb = gl.getUniformLocation(this.blendProgram, 'uB');
      this.bUout = gl.getUniformLocation(this.blendProgram, 'uOut');
      this.bUmix = gl.getUniformLocation(this.blendProgram, 'uMix');
      this.bUsharp = gl.getUniformLocation(this.blendProgram, 'uSharp');
    }

    this.texA = this._createTexture();
    this.texB = this._createTexture();

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
  }

  _onFrame() {
    if (this.destroyed) return;
    if (this.video.readyState >= 2) {
      try {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texB);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);

        const now = performance.now();
        if (this.interpolate && this.hasFrame) {
          const duration = this.lastFrameAt
            ? Math.max(16, Math.min(100, now - this.lastFrameAt))
            : 33;
          this.pair = { a: this.texA, b: this.texB, start: now, duration };
        } else if (!this.interpolate) {
          this._drawSharp(this.texB);
        }

        this.hasFrame = true;
        this.lastFrameAt = now;
        [this.texA, this.texB] = [this.texB, this.texA];
      } catch {
        /* the frame may be protected or not ready yet */
      }
    }
    this._videoCallback = this.video.requestVideoFrameCallback(this._onFrame);
  }

  _drawSharp(texture) {
    if (!texture) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uTex, 0);
    gl.uniform2f(this.uOut, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uSharp, this.sharpness);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  _drawBlend(a, b, mix) {
    if (!this.blendProgram) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.blendProgram);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.uniform1i(this.bUa, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b);
    gl.uniform1i(this.bUb, 1);
    gl.uniform2f(this.bUout, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.bUmix, Math.max(0, Math.min(1, mix)));
    gl.uniform1f(this.bUsharp, this.sharpness);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  _startBlendLoop() {
    this._stopBlendLoop();
    const loop = () => {
      if (this.destroyed || !this.interpolate) return;
      if (this.pair) {
        const mix = (performance.now() - this.pair.start) / this.pair.duration;
        this._drawBlend(this.pair.a, this.pair.b, mix);
      } else if (this.hasFrame) {
        this._drawSharp(this.texA);
      }
      this._blendTimer = setTimeout(loop, 1000 / this.targetFps);
    };
    loop();
  }

  _stopBlendLoop() {
    if (this._blendTimer) clearTimeout(this._blendTimer);
    this._blendTimer = null;
  }

  _resize() {
    if (this.destroyed || !this.gl) return;
    const cw = this.container.clientWidth || 1280;
    const ch = this.container.clientHeight || 720;
    const vw = this.video.videoWidth || 1920;
    const vh = this.video.videoHeight || 1080;

    const scale = Math.min(cw / vw, ch / vh);
    const cssW = Math.max(2, Math.floor(vw * scale));
    const cssH = Math.max(2, Math.floor(vh * scale));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let width = Math.floor(cssW * dpr);
    let height = Math.floor(cssH * dpr);
    const pixels = width * height;
    const maxPixels = 3840 * 2160;
    if (pixels > maxPixels) {
      const k = Math.sqrt(maxPixels / pixels);
      width = Math.floor(width * k);
      height = Math.floor(height * k);
    }

    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.interpolate && this.pair) {
        this._drawBlend(this.pair.a, this.pair.b, 1);
      } else if (this.hasFrame) {
        this._drawSharp(this.texA);
      }
    }
  }

  setSharpness(value) {
    this.sharpness = Math.max(0, Math.min(1.5, Number(value) || 0));
  }

  setTargetFps(value) {
    this.targetFps = Math.max(30, Math.min(60, Number(value) || 45));
    if (this.interpolate) this._startBlendLoop();
  }

  setInterpolation(enabled, targetFps) {
    if (targetFps) this.setTargetFps(targetFps);
    const wanted = Boolean(enabled) && Boolean(this.blendProgram);
    if (wanted === this.interpolate && this._blendTimer) return;
    this.interpolate = wanted;
    this.pair = null;
    if (this.interpolate) {
      this._startBlendLoop();
    } else {
      this._stopBlendLoop();
      if (this.hasFrame) this._drawSharp(this.texA);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopBlendLoop();

    if (this._ro) this._ro.disconnect();
    if (this._onVideoResize) this.video.removeEventListener('resize', this._onVideoResize);
    if (this._videoCallback != null && this.video && typeof this.video.cancelVideoFrameCallback === 'function') {
      try {
        this.video.cancelVideoFrameCallback(this._videoCallback);
      } catch {
        /* ignore */
      }
    }
    if (this.video) this.video.style.opacity = '';

    const gl = this.gl;
    if (gl) {
      if (this.texA) gl.deleteTexture(this.texA);
      if (this.texB) gl.deleteTexture(this.texB);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
      if (this.blendProgram) gl.deleteProgram(this.blendProgram);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }

    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.ok = false;
  }
}

window.Upscaler = Upscaler;
