'use strict';

/**
 * Authentication and xHome streaming-token management.
 *
 * Everything here is control plane only. It uses the same public MSAL device-code
 * flow as the official Xbox app / Greenlight, then exchanges the Xbox token for a
 * short-lived xHome "gsToken". No password ever touches this app.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TokenStore, Msal } = require('xal-node');

class AuthManager extends EventEmitter {
  /**
   * @param {{userData: string, projectRoot: string}} opts
   */
  constructor({ userData, projectRoot }) {
    super();
    this.userData = userData;
    this.projectRoot = projectRoot;
    this.tokenPath = this._resolveTokenPath();
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    } catch {
      /* the directory usually already exists */
    }
    this.state = 'init';
    this.error = null;
    this.gamertag = null;
    this.baseUri = null;
    this._token = null;
    this._msal = null;
    this._store = null;
    this._inflight = null;
    this._deviceCode = null;
  }

  _resolveTokenPath() {
    const fromProject = path.join(this.projectRoot, '.xbox.tokens.json');
    const fromUserData = path.join(this.userData, '.xbox.tokens.json');
    if (fs.existsSync(fromProject)) return fromProject;
    return fromUserData;
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      gamertag: this.gamertag,
      baseUri: this.baseUri,
      tokenPath: this.tokenPath,
      deviceCode: this._deviceCode,
    };
  }

  _set(state, patch = {}) {
    this.state = state;
    Object.assign(this, patch);
    this.emit('change', this.snapshot());
  }

  async init() {
    if (this._inflight) return this._inflight;
    this._inflight = this._init().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _init() {
    this._set('loading', { error: null });
    try {
      const store = new TokenStore();
      store.load(this.tokenPath, true);
      this._store = store;

      if (store.getAuthenticationMethod() === 'none') {
        this._set('needs-auth', { error: null });
        return this.snapshot();
      }

      this._msal = new Msal(store);
      await this._loadStreamingToken();
      this._set('ready', { error: null });
    } catch (err) {
      this._set('needs-auth', { error: this._humanError(err) });
    }
    return this.snapshot();
  }

  async _loadStreamingToken() {
    const tokens = await this._msal.getStreamingTokens();
    const home = tokens.xHomeToken;
    if (!home || !home.data || !home.data.gsToken) {
      throw new Error('This account is not allowed to use xHome streaming (no gsToken).');
    }
    this._token = home.data.gsToken;
    this.baseUri = home.getDefaultRegion().baseUri;
    try {
      this.gamertag = this._store.getSisuToken?.()?.getGamertag?.() || null;
    } catch {
      this.gamertag = null;
    }
  }

  /**
   * Starts the MSAL device-code flow. Returns the code/URL immediately; the
   * promise resolves when the user finishes signing in.
   */
  async beginDeviceCode() {
    if (this._deviceCode) return this._deviceCode;

    const store = new TokenStore();
    store.load(this.tokenPath, true);
    const msal = new Msal(store);

    this._set('authenticating', { error: null });
    const details = await msal.doDeviceCodeAuth();
    this._deviceCode = {
      userCode: details.user_code,
      verificationUri: details.verification_uri,
      message: details.message,
      expiresIn: details.expires_in,
    };
    this.emit('change', this.snapshot());

    msal
      .doPollForDeviceCodeAuth(details.device_code, details.expires_in * 1000)
      .then(async () => {
        this._store = store;
        this._msal = msal;
        await this._loadStreamingToken();
        this._deviceCode = null;
        this._set('ready', { error: null });
      })
      .catch((err) => {
        this._deviceCode = null;
        this._set('needs-auth', { error: this._humanError(err) });
      });

    return this._deviceCode;
  }

  async refresh() {
    if (!this._msal) throw new Error('Not authenticated');
    await this._loadStreamingToken();
    this._set('ready', { error: null });
    return this.snapshot();
  }

  async getAuth() {
    if (this.state !== 'ready' || !this._token || !this.baseUri) {
      throw new Error('Not authenticated');
    }
    return { token: this._token, baseUri: this.baseUri };
  }

  async getMsalToken() {
    if (!this._msal) throw new Error('Not authenticated');
    const token = await this._msal.getMsalToken();
    return token.data.lpt;
  }

  forget() {
    try {
      if (fs.existsSync(this.tokenPath)) fs.rmSync(this.tokenPath);
    } catch {
      /* ignore */
    }
    this._token = null;
    this._msal = null;
    this._store = null;
    this.baseUri = null;
    this._set('needs-auth', { error: null });
  }

  _humanError(err) {
    const msg = err && (err.message || err.toString());
    if (!msg) return 'Unknown authentication error';
    if (/ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(msg)) {
      return 'No connection to Microsoft sign-in. Internet is required for the initial handshake.';
    }
    if (/invalid_grant|TokenRefreshError/i.test(msg)) {
      return 'The saved session expired. Sign in again.';
    }
    return msg;
  }
}

module.exports = { AuthManager };
