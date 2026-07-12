const lib = await import('../dist/index.js');
const node = await import('../dist/node.js');

const requiredConstructors = ['Account', 'SpacemoltClient', 'CatalogCache', 'MapCache', 'Socket'];
for (const name of requiredConstructors) {
  if (typeof lib[name] !== 'function') throw new Error(`dist/index.js is missing runtime export ${name}`);
}
if (!lib.ACTIONS || Object.keys(lib.ACTIONS).length < 200) {
  throw new Error('dist/index.js contains an empty or incomplete action catalog');
}
if (typeof node.FileCredentialStore !== 'function') {
  throw new Error('dist/node.js is missing runtime export FileCredentialStore');
}

console.log(`build smoke: ${Object.keys(lib.ACTIONS).length} actions and required runtime exports loaded under Node`);
