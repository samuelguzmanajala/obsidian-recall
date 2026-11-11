/** Vault paths never published to the backend: anything inside a `node_modules` folder. */
export function isExcludedPath(path: string): boolean {
  return path.split('/').includes('node_modules');
}
