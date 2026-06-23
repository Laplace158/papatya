const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function parseGitHubRemote(remoteUrl) {
  if (!remoteUrl) return null;

  const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!sshMatch) return null;

  return {
    owner: sshMatch[1],
    repo: sshMatch[2]
  };
}

let remoteUrl = '';
try {
  remoteUrl = execSync('git remote get-url origin', {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
} catch {
  console.error('Git origin adresi bulunamadi. Once GitHub repo bagla.');
  process.exit(1);
}

const publishTarget = parseGitHubRemote(remoteUrl);
if (!publishTarget) {
  console.error(`GitHub origin adresi okunamadi: ${remoteUrl}`);
  process.exit(1);
}

packageJson.build = packageJson.build || {};
packageJson.build.publish = [
  {
    provider: 'github',
    owner: publishTarget.owner,
    repo: publishTarget.repo,
    releaseType: 'release'
  }
];

fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`GitHub publish ayari guncellendi: ${publishTarget.owner}/${publishTarget.repo}`);
