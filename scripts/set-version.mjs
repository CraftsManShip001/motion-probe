#!/usr/bin/env node
// Sets one version on every published package and on the internal @motion-probe/* dependencies
// (packages and the demo app). Usage: node scripts/set-version.mjs 0.1.1 && npm install
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <x.y.z>');
  process.exit(1);
}

const deps = (text) => text.replace(/("@motion-probe\/[\w-]+":\s*")[^"]+(")/g, `$1${version}$2`);
const update = (path, transform) => {
  const file = new URL(`../${path}`, import.meta.url);
  writeFileSync(file, transform(readFileSync(file, 'utf8')));
};

for (const name of ['core', 'cli', 'mcp', 'react-native']) {
  // The first "version" key in a package.json is the package's own version.
  update(`packages/${name}/package.json`, (text) => deps(text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)));
}
update('examples/demo/package.json', deps);
console.log(`@motion-probe/* → ${version} (run npm install to update package-lock.json)`);
