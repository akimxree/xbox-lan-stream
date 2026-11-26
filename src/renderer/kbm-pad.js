'use strict';

/**
 * Keyboard + mouse -> virtual Xbox controller (GTA VI profile set).
 *
 * The console game has no native MKB, so we synthesize a normal gamepad frame
 * at 60 Hz and feed it into the same input channel as a physical pad.
 *
 * Contexts (F4 cycles, F auto-switches on foot <-> vehicle):
 *   ON FOOT | VEHICLE | AIRCRAFT | BICYCLE
 *
 * Tap/hold:
 *   Z tap = View (map), hold = D-pad Down (task/minimap)
 *   G tap = D-pad Right (detonate), hold = RB (quick throw)
 *   Shift + wheel = D-pad Up/Down (scope zoom)
 *   wheel = Y (weapon switch, on foot)
 */

const PROFILES = ['onfoot', 'vehicle', 'aircraft', 'bicycle'];
const PROFILE_LABEL = {
  onfoot: 'ON FOOT',
  vehicle: 'VEHICLE',
  aircraft: 'AIRCRAFT',
  bicycle: 'BICYCLE',
};

const KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyR',
  'KeyO',
  'KeyF',
  'KeyC',
  'KeyH',
  'KeyX',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'Space',
  'KeyZ',
  'KeyG',
  'KeyM',
  'KeyP',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'CapsLock',
]);

const DECAY = 0.84;

class KbmPad {
  constructor(player, GamepadClass, options = {}) {
    this.player = player;
    this.pad = new GamepadClass(0);
    this.pad.attach(player);

    this._originalGetState = this.pad.getGamepadState.bind(this.pad);
    this.pad.getGamepadState = () => this.frame();

    this.sensitivity = Math.max(0.1, Math.min(3, options.sensitivity ?? 1));
    this.onProfileChange = options.onProfileChange || (() => {});
    this.profile = 'onfoot';

    this.keys = new Set();
    this.mouse = { left: false, right: false, middle: false };
    this.rightX = 0;
    this.rightY = 0;
    this.pulses = new Map();
    this.zHeld = false;
    this.zAt = 0;
    this.gHeld = false;
    this.gAt = 0;
    this.video = null;
    this._listeners = [];

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onBlur = this._onBlur.bind(this);
  }

  attach(video) {
    this.video = video;
    this._add(window, 'keydown', this._onKeyDown);
    this._add(window, 'keyup', this._onKeyUp);
    this._add(window, 'mousemove', this._onMouseMove);
    this._add(window, 'mousedown', this._onMouseDown);
    this._add(window, 'mouseup', this._onMouseUp);
    this._add(window, 'wheel', this._onWheel, { passive: false });
    this._add(window, 'blur', this._onBlur);
    this._add(video, 'click', this._onClick);
    this._add(video, 'contextmenu', (event) => event.preventDefault());
    this._add(window, 'contextmenu', (event) => event.preventDefault());
  }

  ensureRegistered() {
    if (!this.player?._channels?.control) return;
    this.player._channels.control.sendGamepadState(0, true, this.pad);
  }

  setSensitivity(value) {
    this.sensitivity = Math.max(0.1, Math.min(3, Number(value) || 1));
  }

  setProfile(profile) {
    if (!PROFILES.includes(profile) || profile === this.profile) return;
    this.profile = profile;
    this.onProfileChange(profile);
  }

  cycleProfile() {
    const index = PROFILES.indexOf(this.profile);
    this.setProfile(PROFILES[(index + 1) % PROFILES.length]);
  }

  frame() {
    const frame = this.pad.getDefaultFamepadFrame();
    frame.GamepadIndex = 0;
    const now = performance.now();
    const k = this.keys;

    // Mouse -> right stick (spring return).
    frame.RightThumbXAxis = this.rightX;
    frame.RightThumbYAxis = this.rightY;
    this.rightX *= DECAY;
    this.rightY *= DECAY;
    if (Math.abs(this.rightX) < 0.003) this.rightX = 0;
    if (Math.abs(this.rightY) < 0.003) this.rightY = 0;

    // Common buttons.
    if (k.has('KeyP')) frame.Menu = 1;
    if (k.has('KeyM')) frame.LeftShoulder = 1;
    if (k.has('ArrowUp') || this.mouse.middle) frame.DPadUp = 1;
    if (this.zHeld && now - this.zAt > 250) frame.DPadDown = 1;
    if (this.gHeld && now - this.gAt > 250) frame.RightShoulder = 1;

    this._applyProfile(frame);

    for (const [button, until] of this.pulses) {
      if (now < until) frame[button] = 1;
      else this.pulses.delete(button);
    }

    return frame;
  }

  _applyProfile(frame) {
    const k = this.keys;

    if (this.profile === 'onfoot') {
      const lx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const ly = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0);
      this._setLeftStick(frame, lx, ly);

      if (k.has('ShiftLeft') || k.has('ShiftRight')) frame.LeftThumb = 1; // LS: sprint
      if (k.has('KeyQ')) frame.RightShoulder = 1; // RB: cover
      if (k.has('KeyE') || k.has('KeyF')) frame.Y = 1; // Y: interact / enter
      if (k.has('KeyR') || k.has('KeyO')) frame.X = 1; // X: melee light/heavy
      if (k.has('ControlLeft') || k.has('ControlRight')) frame.B = 1; // B: crouch
      if (k.has('Space')) frame.A = 1; // A: jump/climb
      if (k.has('KeyC')) frame.RightThumb = 1; // R3: look back
      if (this.mouse.left) frame.RightTrigger = 1; // RT: fire
      if (this.mouse.right) frame.LeftTrigger = 1; // LT: aim
      return;
    }

    if (this.profile === 'vehicle') {
      const steer = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      frame.LeftThumbXAxis = steer;
      frame.LeftThumbYAxis = 0;

      if (k.has('KeyW')) frame.RightTrigger = 1; // RT: gas
      if (k.has('KeyS')) frame.LeftTrigger = 1; // LT: brake
      if (k.has('Space')) frame.A = 1; // A: handbrake
      if (this.mouse.left) frame.RightShoulder = 1; // RB: drive-by
      if (k.has('KeyE')) frame.LeftThumb = 1; // LS: horn
      if (k.has('KeyF')) frame.Y = 1; // Y: enter/exit
      if (k.has('KeyX') || k.has('KeyH')) frame.B = 1; // B: crouch / headlights
      if (k.has('KeyQ')) frame.DPadLeft = 1; // D-pad left: radio
      return;
    }

    if (this.profile === 'aircraft') {
      const lx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const ly = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0);
      this._setLeftStick(frame, lx, ly);

      if (k.has('KeyW')) frame.RightTrigger = 1; // throttle up
      if (k.has('KeyS')) frame.LeftTrigger = 1; // throttle down
      if (k.has('KeyA')) frame.X = 1; // yaw left
      if (k.has('KeyD')) frame.B = 1; // yaw right
      if (this.mouse.left) frame.RightShoulder = 1; // fire
      if (k.has('KeyF')) frame.Y = 1; // enter/exit
      return;
    }

    if (this.profile === 'bicycle') {
      frame.LeftThumbXAxis = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      frame.LeftThumbYAxis = 0;
      if (k.has('KeyW')) frame.RightTrigger = 1; // pedals
      if (k.has('KeyS')) frame.LeftTrigger = 1; // brake
      if (k.has('Space')) frame.B = 1; // bunnyhop
      if (k.has('CapsLock')) frame.A = 1; // sprint
      if (k.has('KeyF')) frame.Y = 1; // dismount
    }
  }

  _setLeftStick(frame, x, y) {
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    frame.LeftThumbXAxis = x;
    frame.LeftThumbYAxis = y;
  }

  _add(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this._listeners.push([target, type, fn, options]);
  }

  _onKeyDown(event) {
    if (event.target && /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;

    if (event.code === 'F4') {
      event.preventDefault();
      this.cycleProfile();
      return;
    }

    if (/^Digit[1-9]$/.test(event.code)) {
      if (this.profile === 'onfoot') {
        event.preventDefault();
        this._pulse('Y');
      }
      return;
    }

    if (!KEYS.has(event.code)) return;
    event.preventDefault();

    if (event.repeat) return;
    this.keys.add(event.code);

    if (event.code === 'KeyF') {
      if (this.profile === 'onfoot') this.setProfile('vehicle');
      else if (this.profile === 'vehicle') this.setProfile('onfoot');
      else this.setProfile('onfoot');
    }

    if (event.code === 'KeyZ' && !this.zHeld) {
      this.zHeld = true;
      this.zAt = performance.now();
    }
    if (event.code === 'KeyG' && !this.gHeld) {
      this.gHeld = true;
      this.gAt = performance.now();
    }
  }

  _onKeyUp(event) {
    if (!KEYS.has(event.code)) return;
    event.preventDefault();

    if (event.code === 'KeyZ' && this.zHeld) {
      const tap = performance.now() - this.zAt <= 250;
      this.zHeld = false;
      if (tap) this._pulse('View');
    }
    if (event.code === 'KeyG' && this.gHeld) {
      const tap = performance.now() - this.gAt <= 250;
      this.gHeld = false;
      if (tap) this._pulse('DPadRight');
    }

    this.keys.delete(event.code);
  }

  _onMouseMove(event) {
    if (document.pointerLockElement !== this.video) return;
    const scale = 0.011 * this.sensitivity;
    this.rightX = Math.max(-1, Math.min(1, this.rightX + event.movementX * scale));
    this.rightY = Math.max(-1, Math.min(1, this.rightY + event.movementY * scale));
  }

  _onMouseDown(event) {
    if (document.pointerLockElement !== this.video) return;
    if (event.button === 0) this.mouse.left = true;
    if (event.button === 2) this.mouse.right = true;
    if (event.button === 1) {
      this.mouse.middle = true;
      event.preventDefault();
    }
  }

  _onMouseUp(event) {
    if (event.button === 0) this.mouse.left = false;
    if (event.button === 2) this.mouse.right = false;
    if (event.button === 1) this.mouse.middle = false;
  }

  _onWheel(event) {
    if (document.pointerLockElement !== this.video) return;
    event.preventDefault();

    if (event.shiftKey) {
      if (event.deltaY < 0) this._pulse('DPadUp');
      else if (event.deltaY > 0) this._pulse('DPadDown');
      return;
    }

    // Weapon switch (Y) on foot. In vehicles the wheel is not mapped to Y,
    // because Y is enter/exit there.
    if (this.profile === 'onfoot' && event.deltaY !== 0) this._pulse('Y');
  }

  _onClick() {
    if (document.pointerLockElement === this.video) {
      document.exitPointerLock();
      return;
    }
    const request = this.video.requestPointerLock({ unadjustedMovement: true });
    if (request && typeof request.catch === 'function') {
      request.catch(() => this.video.requestPointerLock());
    }
  }

  _onBlur() {
    this.keys.clear();
    this.mouse.left = false;
    this.mouse.right = false;
    this.mouse.middle = false;
    this.rightX = 0;
    this.rightY = 0;
    this.zHeld = false;
    this.gHeld = false;
  }

  _pulse(button) {
    this.pulses.set(button, performance.now() + 100);
  }

  detach() {
    for (const [target, type, fn, options] of this._listeners) {
      target.removeEventListener(type, fn, options);
    }
    this._listeners = [];

    if (document.pointerLockElement === this.video) document.exitPointerLock();
    this.video = null;
    this.keys.clear();
    this.mouse = { left: false, right: false, middle: false };
    this.rightX = 0;
    this.rightY = 0;
    this.zHeld = false;
    this.gHeld = false;

    try {
      this.pad.getGamepadState = this._originalGetState;
      this.pad.detach();
    } catch {
      /* ignore */
    }
  }
}

window.KbmPad = KbmPad;
