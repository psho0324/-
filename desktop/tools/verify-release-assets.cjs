// Validate the actual asset metadata returned by `gh release view --json assets`.
const fs = require('node:fs');
const path = require('node:path');

function verifyReleaseAssets(release, dist) {
  if (!Array.isArray(release?.assets) || release.assets.some(asset => typeof asset?.name !== 'string')) {
    throw new Error('Release asset metadata must contain an assets array with file names');
  }
  const required = ['MyPlanner-Setup.exe', 'latest.yml', 'SHA256SUMS.txt', 'installed.json', 'update-e2e.json'];
  if (fs.existsSync(path.join(dist, 'MyPlanner-Setup.exe.blockmap'))) required.push('MyPlanner-Setup.exe.blockmap');
  const names = new Set(release.assets.map(asset => asset.name));
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw new Error('Published Release is missing: ' + missing.join(', '));
  return required;
}

if (require.main === module) {
  try {
    const [metadata, dist] = process.argv.slice(2);
    if (!metadata || !dist) throw new Error('Usage: verify-release-assets.cjs release.json build-dist');
    const names = verifyReleaseAssets(JSON.parse(fs.readFileSync(metadata, 'utf8')), dist);
    console.log('PASS: published Release contains ' + names.join(', '));
  } catch (error) {
    const message = String(error.message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error('::error title=Release assets verification::' + message);
    process.exitCode = 1;
  }
}
module.exports = { verifyReleaseAssets };
