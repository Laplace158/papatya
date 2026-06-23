const { spawn } = require('child_process');
const fs = require('fs');
const electron = require('electron');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronExe = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) {
  console.error([
    'Papatya kaynak kurulumunda Electron bulunamadi.',
    'Node.js kurulu degilse once onu kur: https://nodejs.org/',
    'Sonra proje klasorunde `npm install` calistir.'
  ].join('\n'));
  process.exit(1);
}

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
