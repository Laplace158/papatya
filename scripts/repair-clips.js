const fs = require('fs/promises');
const path = require('path');
const fixWebmDuration = require('webm-duration-fix').default;

const clipsDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Videos', 'Papatya Clips');

async function repairClip(filePath) {
  const input = await fs.readFile(filePath);
  const fixed = await fixWebmDuration(new Blob([input], { type: 'video/webm' }));
  const tempPath = `${filePath}.repairing`;
  await fs.writeFile(tempPath, Buffer.from(await fixed.arrayBuffer()));
  await fs.rename(tempPath, filePath);
}

async function main() {
  await fs.mkdir(clipsDir, { recursive: true });
  const files = (await fs.readdir(clipsDir)).filter((name) => name.toLowerCase().endsWith('.webm'));
  for (const file of files) {
    const filePath = path.join(clipsDir, file);
    try {
      await repairClip(filePath);
      console.log(`repaired ${file}`);
    } catch (error) {
      console.warn(`skipped ${file}: ${error.message}`);
    }
  }
  console.log(`done: ${files.length} file(s) checked`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
