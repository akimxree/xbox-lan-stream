'use strict';

/**
 * Local network helpers: ICMP RTT, adapter inventory and Windows ICS control.
 * Nothing here touches the video path; it only helps the user build a clean,
 * dedicated L2 segment between the PC and the console.
 */

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const PS = path.join(SCRIPTS, 'ics.ps1');
const NAT_PS = path.join(SCRIPTS, 'nat.ps1');

function isPrivateIPv4(ip) {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip)
  );
}

function isIPv6(host) {
  return String(host).includes(':');
}

/**
 * ICMP ping. Xbox may rate-limit or block echo requests; a null result is
 * normal and the WebRTC candidate-pair RTT remains the authoritative metric.
 */
async function pingHost(host, { count = 2, timeoutMs = 900 } = {}) {
  if (!host) return null;
  const args = ['-n', String(count), '-w', String(timeoutMs)];
  if (isIPv6(host)) args.push('-6');
  args.push(host);

  try {
    const { stdout } = await execFileAsync('ping', args, {
      timeout: 6000,
      windowsHide: true,
      encoding: 'utf8',
    });
    const values = [];
    const re = /(?:time|время)\s*[=<]\s*(\d+)\s*(?:ms|мс)/gi;
    let m;
    while ((m = re.exec(stdout)) !== null) values.push(Number(m[1]));
    if (!values.length) return null;
    return {
      host,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      samples: values.length,
    };
  } catch {
    return null;
  }
}

function listInterfaces() {
  const result = [];
  const all = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(all)) {
    for (const address of addresses || []) {
      if (address.internal) continue;
      result.push({
        name,
        address: address.address,
        family: address.family,
        mac: address.mac,
        netmask: address.netmask,
        cidr: address.cidr,
        private: address.family === 'IPv4' ? isPrivateIPv4(address.address) : address.address.startsWith('fe80'),
        icsHost: address.address === '192.168.137.1',
      });
    }
  }
  return result;
}

async function listAdapters() {
  const script = [
    'Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed,MacAddress,InterfaceIndex,Virtual | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, windowsHide: true, encoding: 'utf8' }
    );
    const parsed = JSON.parse(stdout.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function psJson(args, scriptPath = PS) {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }
    );
    const text = stdout.trim();
    return text ? JSON.parse(text) : { ok: true };
  } catch (err) {
    const text = String((err && err.stdout) || '').trim();
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      error: String((err && err.stderr) || (err && err.message) || err),
      needAdmin: /administrator|администратор|access is denied|отказано в доступе/i.test(
        String((err && err.stderr) || '')
      ),
    };
  }
}

async function icsStatus() {
  return psJson(['-Action', 'status']);
}

async function icsEnable({ publicAlias, privateAlias, privateIp }) {
  const args = ['-Action', 'enable'];
  if (publicAlias) args.push('-PublicAlias', publicAlias);
  if (privateAlias) args.push('-PrivateAlias', privateAlias);
  if (privateIp) args.push('-PrivateIp', privateIp);
  return psJson(args);
}

async function icsDisable() {
  return psJson(['-Action', 'disable']);
}

async function natStatus() {
  return psJson(['-Action', 'status'], NAT_PS);
}

async function natEnable({ publicAlias, privateAlias, privateIp }) {
  const args = ['-Action', 'enable'];
  if (publicAlias) args.push('-PublicAlias', publicAlias);
  if (privateAlias) args.push('-PrivateAlias', privateAlias);
  if (privateIp) args.push('-PrivateIp', privateIp);
  return psJson(args, NAT_PS);
}

async function natDisable() {
  return psJson(['-Action', 'disable'], NAT_PS);
}

module.exports = {
  pingHost,
  listInterfaces,
  listAdapters,
  icsStatus,
  icsEnable,
  icsDisable,
  natStatus,
  natEnable,
  natDisable,
  isPrivateIPv4,
};
