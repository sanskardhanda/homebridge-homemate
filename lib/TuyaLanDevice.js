'use strict';

// LAN framing is based on the MIT-licensed homebridge-tuya/homebridge-tuya-plus
// TuyaAccessory implementation, with a small public API for this plugin.
const crypto = require('crypto');
const EventEmitter = require('events');
const net = require('net');

const DEFAULT_PORT = 6668;
const DEFAULT_RECONNECT_DELAY = 5000;

const hasKeys = (obj) => obj && Object.keys(obj).length > 0;

class TuyaLanDevice extends EventEmitter {
  constructor(options) {
    super();

    this.context = {
      version: '3.3',
      port: DEFAULT_PORT,
      connectTimeout: 30,
      pingGap: 9,
      pingTimeout: 30,
      reconnectDelay: DEFAULT_RECONNECT_DELAY,
      ...options,
      id: String(options.id).trim(),
      key: String(options.key),
      version: String(options.version || '3.3'),
    };

    this.log = this.context.log || {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };

    this.state = {};
    this.connected = false;
    this.sessionKey = null;

    this._socket = null;
    this._cachedBuffer = Buffer.alloc(0);
    this._sendCounter = 0;
    this._connectionAttempts = 0;
    this._tmpLocalKey = null;
    this._tmpRemoteKey = null;
    this._reconnectTimer = null;
  }

  connect() {
    if (!this.context.ip) {
      throw new Error('HomeMate LAN control requires a configured device IP address.');
    }

    this.close();
    this._socket = new net.Socket();
    this._cachedBuffer = Buffer.alloc(0);
    this._incrementAttemptCounter();

    this._socket.setKeepAlive(true);
    this._socket.setNoDelay(true);

    this._socket._connTimeout = setTimeout(() => {
      this._socket.emit('error', new Error('ERR_CONNECTION_TIMED_OUT'));
    }, this.context.connectTimeout * 1000);

    this._socket.on('connect', () => {
      if (this.context.version !== '3.4' && this.context.version !== '3.5') {
        this._markConnected();
      }
    });

    this._socket.on('ready', () => {
      if (this.context.version === '3.4' || this.context.version === '3.5') {
        this._tmpLocalKey = crypto.randomBytes(16);
        this._send({
          cmd: 3,
          data: this._tmpLocalKey,
          encrypted: true,
        });
      } else {
        this.update();
      }
    });

    this._socket.on('data', (chunk) => this._handleSocketData(chunk));
    this._socket.on('error', (error) => this._handleSocketError(error));
    this._socket.on('close', () => this._handleSocketClose());
    this._socket.on('end', () => this._handleSocketClose());

    this._socket.connect(this.context.port, this.context.ip);
  }

  close() {
    clearTimeout(this._reconnectTimer);

    if (!this._socket) {
      return;
    }

    clearTimeout(this._socket._connTimeout);
    clearTimeout(this._socket._pinger);
    clearTimeout(this._socket._pingRetry);
    this._socket.removeAllListeners();
    this._socket.destroy();
    this._socket = null;
    this.connected = false;
    this.sessionKey = null;
  }

  update(dpsPatch) {
    const dps = {};

    if (dpsPatch) {
      for (const [dp, value] of Object.entries(dpsPatch)) {
        if (!Number.isNaN(Number(dp))) {
          dps[String(dp)] = value;
        }
      }
    }

    if (hasKeys(dps)) {
      const t = Math.round(Date.now() / 1000).toString();

      // gwId is required by most Tuya devices in the control payload.
      // Omitting it causes wall switches and similar devices to silently
      // ignore the command even though the TCP connection is healthy.
      const payload = {
        gwId: this.context.id,
        devId: this.context.id,
        uid: '',
        t,
        dps,
      };

      const data = this._usesNewControlFormat()
        ? {
          data: {
            ...payload,
            ctype: 0,
            t: undefined,
          },
          protocol: 5,
          t,
        }
        : payload;

      const result = this._send({
        cmd: this._usesNewControlFormat() ? 13 : 7,
        data,
      });

      if (this.context.sendEmptyUpdate) {
        this._send({ cmd: this._usesNewControlFormat() ? 13 : 7 });
      }

      return result;
    }

    return this._send({
      cmd: this._usesNewControlFormat() ? 16 : 10,
      data: {
        gwId: this.context.id,
        devId: this.context.id,
      },
    });
  }

  _usesNewControlFormat() {
    return this.context.version === '3.4' || this.context.version === '3.5';
  }

  _uses31Format() {
    return Number.parseFloat(this.context.version) < 3.2;
  }

  _uses33Format() {
    return this.context.version === '3.2' || this.context.version === '3.3';
  }

  _markConnected() {
    clearTimeout(this._socket && this._socket._connTimeout);
    this.connected = true;
    this.emit('connect');
    this.update();
    this._schedulePing(1000);
  }

  _schedulePing(delayMs) {
    if (!this._socket) {
      return;
    }

    clearTimeout(this._socket._pinger);
    this._socket._pinger = setTimeout(() => {
      clearTimeout(this._socket._pingRetry);
      this._socket._pingRetry = setTimeout(() => {
        if (this._socket) {
          this._socket.emit('error', new Error('ERR_PING_TIMED_OUT'));
        }
      }, 5000);

      this._send({ cmd: 9 });
    }, delayMs);
  }

  _handleSocketData(chunk) {
    this._cachedBuffer = Buffer.concat([this._cachedBuffer, chunk]);

    while (this._cachedBuffer.length) {
      const startMarker = this.context.version === '3.5' ? '00006699' : '000055aa';
      const endMarker = this.context.version === '3.5' ? '00009966' : '0000aa55';
      const start = this._cachedBuffer.indexOf(startMarker, 'hex');

      if (start === -1) {
        this._cachedBuffer = Buffer.alloc(0);
        return;
      }

      if (start > 0) {
        this._cachedBuffer = this._cachedBuffer.slice(start);
      }

      let end = this._cachedBuffer.indexOf(endMarker, 'hex');
      if (end === -1) {
        return;
      }
      end += 4;

      const frame = this._cachedBuffer.slice(0, end);
      this._cachedBuffer = this._cachedBuffer.slice(end);

      try {
        this._handleFrame(frame);
      } catch (error) {
        this._handleSocketError(error);
      }
    }
  }

  _handleFrame(frame) {
    if (this._uses31Format()) {
      return this._handleFrame31(frame);
    }

    if (this._uses33Format()) {
      return this._handleFrame33(frame);
    }

    if (this.context.version === '3.4') {
      return this._handleFrame34(frame);
    }

    return this._handleFrame35(frame);
  }

  _handleFrame31(frame) {
    if (!this._is55aaFrame(frame)) {
      return;
    }

    const cmd = frame.readUInt32BE(8);
    let data = frame.slice(frame.length - frame.readUInt32BE(12), frame.length - 8)
      .toString('utf8')
      .trim()
      .replace(/\0/g, '');

    if (cmd === 9) {
      clearTimeout(this._socket && this._socket._pingRetry);
      this._schedulePing((this.context.pingGap || 20) * 1000);
      return;
    }

    if (cmd === 8) {
      try {
        const decipher = crypto.createDecipheriv('aes-128-ecb', this.context.key, '');
        data = decipher.update(data.substr(19), 'base64', 'utf8') + decipher.final('utf8');
      } catch (error) {
        data = data.substr(19).toString('utf8');
      }
    }

    this._consumeJsonPayload(cmd, data, frame);
  }

  _handleFrame33(frame) {
    if (!this._is55aaFrame(frame)) {
      return;
    }

    const cmd = frame.readUInt32BE(8);

    if (cmd === 7) {
      return;
    }

    if (cmd === 9) {
      clearTimeout(this._socket && this._socket._pingRetry);
      this._schedulePing((this.context.pingGap || 20) * 1000);
      return;
    }

    const size = frame.readUInt32BE(12);
    let versionPos = frame.indexOf('3.3');
    if (versionPos === -1) {
      versionPos = frame.indexOf('3.2');
    }

    const cleanMsg = frame.slice(
      versionPos === -1 ? frame.length - size + ((frame.readUInt32BE(16) & 0xffffff00) ? 0 : 4) : 15 + versionPos,
      frame.length - 8,
    );

    let decryptedMsg;
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', this.context.key, '');
      decryptedMsg = decipher.update(cleanMsg, 'buffer', 'utf8') + decipher.final('utf8');
    } catch (error) {
      decryptedMsg = cleanMsg.toString('utf8');
    }

    this._consumeJsonPayload(cmd, decryptedMsg, frame);
  }

  _handleFrame34(frame) {
    if (!this._is55aaFrame(frame)) {
      return;
    }

    const cmd = frame.readUInt32BE(8);

    if (cmd === 7 || cmd === 13) {
      return;
    }

    if (cmd === 9) {
      clearTimeout(this._socket && this._socket._pingRetry);
      this._schedulePing((this.context.pingGap || 20) * 1000);
      return;
    }

    const size = frame.readUInt32BE(12);
    const versionPos = frame.indexOf('3.4');
    const cleanMsg = frame.slice(
      versionPos === -1 ? frame.length - size + ((frame.readUInt32BE(16) & 0xffffff00) ? 0 : 4) : 15 + versionPos,
      frame.length - 0x24,
    );

    const expectedHmac = frame.slice(frame.length - 0x24, frame.length - 4).toString('hex');
    const actualHmac = hmac(frame.slice(0, frame.length - 0x24), this.sessionKey || this.context.key).toString('hex');

    if (expectedHmac !== actualHmac) {
      throw new Error(`HMAC mismatch for ${this.context.name}`);
    }

    const decipher = crypto.createDecipheriv('aes-128-ecb', this.sessionKey || this.context.key, null);
    decipher.setAutoPadding(false);
    let decryptedMsg = Buffer.concat([decipher.update(cleanMsg), decipher.final()]);
    decryptedMsg = removePkcs7Padding(decryptedMsg);

    let payload = this._parseVersionedPayload(decryptedMsg);

    if (cmd === 4 && Buffer.isBuffer(payload)) {
      this._finishSessionKeyExchange34(payload);
      return;
    }

    this._consumeParsedPayload(cmd, payload, frame);
  }

  _handleFrame35(frame) {
    const len = frame.length;
    if (len < 22 || frame.readUInt32BE(0) !== 0x00006699 || frame.readUInt32BE(len - 4) !== 0x00009966) {
      return;
    }

    const cmd = frame.readUInt32BE(10);

    if (cmd === 7 || cmd === 13) {
      return;
    }

    if (cmd === 9) {
      clearTimeout(this._socket && this._socket._pingRetry);
      this._schedulePing((this.context.pingGap || 20) * 1000);
      return;
    }

    const iv = frame.slice(18, 30);
    const encrypted = frame.slice(30, len - 20);
    const tag = frame.slice(len - 20, len - 4);
    const aad = frame.slice(4, 18);

    let decrypted;
    try {
      const decipher = crypto.createDecipheriv('aes-128-gcm', this.sessionKey || this.context.key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (error) {
      this.log.warn(`Failed to decrypt message from ${this.context.name} (${this.context.version}): ${error.message}`);
      return;
    }

    let payloadBytes = decrypted;
    if (decrypted.length > 4) {
      try {
        JSON.parse(decrypted.toString('utf8'));
      } catch (error) {
        payloadBytes = decrypted.slice(4);
      }
    }

    const payload = this._parseVersionedPayload(payloadBytes);

    if (cmd === 4 && Buffer.isBuffer(payload)) {
      this._finishSessionKeyExchange35(payload);
      return;
    }

    this._consumeParsedPayload(cmd, payload, frame);
  }

  _parseVersionedPayload(buffer) {
    let payload = buffer;
    if (payload.indexOf(this.context.version) === 0) {
      payload = payload.slice(15);
    }

    try {
      const parsed = JSON.parse(payload.toString('utf8'));
      if (parsed && parsed.data) {
        parsed.data.t = parsed.t;
        return parsed.data;
      }
      return parsed;
    } catch (error) {
      return payload;
    }
  }

  _consumeJsonPayload(cmd, data, frame) {
    if (cmd === 10 && data === 'json obj data unvalid') {
      this.emit('change', {}, this.state);
      return;
    }

    try {
      this._consumeParsedPayload(cmd, JSON.parse(data), frame);
    } catch (error) {
      this.log.debug(`Ignoring malformed message from ${this.context.name} (${this.context.version}) cmd ${cmd}: ${String(data)}`);
    }
  }

  _consumeParsedPayload(cmd, payload) {
    if ((cmd === 8 || cmd === 10 || cmd === 16) && payload && payload.dps) {
      this._change(payload.dps);
    }
  }

  _finishSessionKeyExchange34(payload) {
    this._tmpRemoteKey = payload.subarray(0, 16);

    const expectedLocalHmac = payload.slice(16, 48).toString('hex');
    const actualLocalHmac = hmac(this._tmpLocalKey, this.sessionKey || this.context.key).toString('hex');
    if (expectedLocalHmac !== actualLocalHmac) {
      throw new Error(`Session key HMAC mismatch for ${this.context.name}`);
    }

    this._send({
      cmd: 5,
      data: hmac(this._tmpRemoteKey, this.context.key),
      encrypted: true,
    });

    this.sessionKey = Buffer.from(this._tmpLocalKey);
    for (let i = 0; i < this._tmpLocalKey.length; i++) {
      this.sessionKey[i] = this._tmpLocalKey[i] ^ this._tmpRemoteKey[i];
    }
    this.sessionKey = encryptEcbNoPadding(this.sessionKey, this.context.key);
    this._markConnected();
  }

  _finishSessionKeyExchange35(payload) {
    this._tmpRemoteKey = payload.subarray(0, 16);

    const expectedLocalHmac = payload.slice(16, 48).toString('hex');
    const actualLocalHmac = hmac(this._tmpLocalKey, this.context.key).toString('hex');
    if (expectedLocalHmac !== actualLocalHmac) {
      throw new Error(`Session key HMAC mismatch for ${this.context.name}`);
    }

    this._send({
      cmd: 5,
      data: hmac(this._tmpRemoteKey, this.context.key),
      encrypted: true,
    });

    const xoredKey = xorBuffers(this._tmpLocalKey, this._tmpRemoteKey);
    this.sessionKey = encryptGcmNoTag(xoredKey, this.context.key, this._tmpLocalKey.slice(0, 12));
    this._markConnected();
  }

  _change(data) {
    if (!hasKeys(data)) {
      return;
    }

    const changes = {};
    for (const [dp, value] of Object.entries(data)) {
      if (this.state[dp] !== value) {
        changes[dp] = value;
      }
    }

    this.state = {
      ...this.state,
      ...data,
    };

    if (hasKeys(changes)) {
      this.emit('change', changes, this.state);
    }
  }

  _send(message) {
    if (!this._socket || (!this.connected && message.cmd !== 3 && message.cmd !== 5)) {
      return false;
    }

    if (this._uses31Format()) {
      return this._send31(message);
    }
    if (this._uses33Format()) {
      return this._send33(message);
    }
    if (this.context.version === '3.4') {
      return this._send34(message);
    }
    return this._send35(message);
  }

  _send31({ cmd, data }) {
    let msg = '';

    if (data) {
      if (cmd === 7) {
        const cipher = crypto.createCipheriv('aes-128-ecb', this.context.key, '');
        const encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64') + cipher.final('base64');
        const hash = crypto
          .createHash('md5')
          .update(`data=${encrypted}||lpv=${this.context.version}||${this.context.key}`, 'utf8')
          .digest('hex')
          .substr(8, 16);
        msg = this.context.version + hash + encrypted;
      } else if (cmd === 10) {
        msg = JSON.stringify(data);
      }
    }

    const payload = Buffer.from(msg);
    const prefix = Buffer.from(`000055aa00000000000000${cmd.toString(16).padStart(2, '0')}`, 'hex');
    const suffix = Buffer.concat([payload, Buffer.from('000000000000aa55', 'hex')]);
    const len = Buffer.allocUnsafe(4);
    len.writeInt32BE(suffix.length, 0);
    return this._socket.write(Buffer.concat([prefix, len, suffix]));
  }

  _send33({ cmd, data }) {
    if (cmd !== 7 || data) {
      this._sendCounter++;
    }

    const hex = [
      '000055aa',
      this._sendCounter.toString(16).padStart(8, '0'),
      cmd.toString(16).padStart(8, '0'),
      '00000000',
    ];

    if (cmd === 7 && !data) {
      hex.push('00000000');
    } else if (cmd !== 9 && cmd !== 10) {
      hex.push('332e33000000000000000000000000');
    }

    if (data) {
      const cipher = crypto.createCipheriv('aes-128-ecb', this.context.key, '');
      hex.push(cipher.update(Buffer.from(JSON.stringify(data)), 'utf8', 'hex') + cipher.final('hex'));
    }

    hex.push('00000000');
    hex.push('0000aa55');

    const payload = Buffer.from(hex.join(''), 'hex');
    payload.writeUInt32BE(payload.length - 16, 12);
    payload.writeInt32BE(getCRC32(payload.slice(0, payload.length - 8)), payload.length - 8);
    return this._socket.write(payload);
  }

  _send34({ cmd, data }) {
    let payload = data || Buffer.alloc(0);
    if (!(payload instanceof Buffer)) {
      payload = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    if (![3, 5, 9, 10, 16, 18].includes(cmd)) {
      payload = Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12), payload]);
    }

    const padding = 0x10 - (payload.length & 0x0f);
    const padded = Buffer.alloc(payload.length + padding, padding);
    payload.copy(padded);
    const encrypted = encryptEcbNoPadding(padded, this.sessionKey || this.context.key);

    if ((cmd !== 7 && cmd !== 13) || payload.length) {
      this._sendCounter++;
    }

    const packet = Buffer.alloc(encrypted.length + 52);
    packet.writeUInt32BE(0x000055aa, 0);
    packet.writeUInt32BE(this._sendCounter, 4);
    packet.writeUInt32BE(cmd, 8);
    packet.writeUInt32BE(encrypted.length + 0x24, 12);
    encrypted.copy(packet, 16);
    hmac(packet.slice(0, encrypted.length + 16), this.sessionKey || this.context.key).copy(packet, encrypted.length + 16);
    packet.writeUInt32BE(0x0000aa55, encrypted.length + 48);
    return this._socket.write(packet);
  }

  _send35({ cmd, data }) {
    let payload = data || Buffer.alloc(0);
    if (!(payload instanceof Buffer)) {
      payload = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    if (![3, 5, 9, 10, 16, 18].includes(cmd)) {
      payload = Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12), payload]);
    }

    if ((cmd !== 7 && cmd !== 13) || payload.length) {
      this._sendCounter++;
    }

    const iv = crypto.randomBytes(12);
    const header = Buffer.alloc(14);
    header.writeUInt16BE(0, 0);
    header.writeUInt32BE(this._sendCounter, 2);
    header.writeUInt32BE(cmd, 6);
    header.writeUInt32BE(12 + payload.length + 16, 10);

    const cipher = crypto.createCipheriv('aes-128-gcm', this.sessionKey || this.context.key, iv);
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();

    return this._socket.write(Buffer.concat([
      Buffer.from('00006699', 'hex'),
      header,
      iv,
      encrypted,
      tag,
      Buffer.from('00009966', 'hex'),
    ]));
  }

  _is55aaFrame(frame) {
    return frame.length >= 16 &&
      frame.readUInt32BE(0) === 0x000055aa &&
      frame.readUInt32BE(frame.length - 4) === 0x0000aa55 &&
      frame.length - 8 >= frame.readUInt32BE(12);
  }

  _handleSocketError(error) {
    this.connected = false;
    this.sessionKey = null;
    this.emit('error', error);
    if (this._socket) {
      this._socket.destroy();
    }
    this._scheduleReconnect();
  }

  _handleSocketClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.sessionKey = null;
    if (wasConnected) {
      this.emit('disconnect');
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      try {
        this.connect();
      } catch (error) {
        this.emit('error', error);
      }
    }, this.context.reconnectDelay);
  }

  _incrementAttemptCounter() {
    this._connectionAttempts++;
    setTimeout(() => {
      this._connectionAttempts = Math.max(0, this._connectionAttempts - 1);
    }, 10000);
  }
}

const encryptEcbNoPadding = (data, key) => {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

const encryptGcmNoTag = (data, key, iv) => {
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  cipher.setAAD(Buffer.alloc(0));
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

const hmac = (data, key) => crypto.createHmac('sha256', key).update(data).digest();

const removePkcs7Padding = (data) => {
  const padding = data[data.length - 1];
  if (!padding || padding > 16) {
    return data;
  }
  return data.slice(0, data.length - padding);
};

const xorBuffers = (a, b) => {
  const len = Math.min(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
};

const crc32LookupTable = [];
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 8; j > 0; j--) {
    crc = crc & 1 ? (crc >>> 1) ^ 3988292384 : crc >>> 1;
  }
  crc32LookupTable.push(crc);
}

const getCRC32 = (buffer) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crc32LookupTable[buffer[i] ^ (crc & 0xff)] ^ (crc >>> 8);
  }
  return ~crc;
};

module.exports = TuyaLanDevice;
