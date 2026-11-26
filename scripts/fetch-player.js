'use strict';

/**
 * One-time vendor bootstrap:
 *   git clone xbox-xcloud-player -> npm ci -> npm run build
 *
 * The app loads the resulting UMD bundle from vendor/.../dist/assets.
 * Requires git + Node.js + npm on PATH.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor');
const target = path.join(vendorDir, 'xbox-xcloud-player');
const bundle = path.join(target, 'dist', 'assets', 'xCloudPlayer.min.js');

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

try {
  if (fs.existsSync(bundle)) {
    console.log('Player bundle already present:', bundle);
    process.exit(0);
  }

  fs.mkdirSync(vendorDir, { recursive: true });

  if (!fs.existsSync(path.join(target, 'package.json'))) {
    run('git', ['clone', '--depth', '1', 'https://github.com/unknownskl/xbox-xcloud-player.git', target], vendorDir);
  }

  try {
    run('npm', ['ci', '--no-audit', '--no-fund'], target);
  } catch {
    run('npm', ['install', '--no-audit', '--no-fund'], target);
  }
  run('npm', ['run', 'build'], target);

  if (!fs.existsSync(bundle)) {
    throw new Error('Build finished but bundle is missing: ' + bundle);
  }
  console.log('\nReady:', bundle);
} catch (err) {
  console.error('\nBootstrap failed:', err.message);
  console.error('Manual fallback:');
  console.error('  git clone https://github.com/unknownskl/xbox-xcloud-player vendor/xbox-xcloud-player');
  console.error('  cd vendor/xbox-xcloud-player && npm ci && npm run build');
  process.exit(1);
}