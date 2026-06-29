/**
 * Node/Bun-only entry point (`@spacemolt/lib/node`).
 *
 * Exports the parts of the library that depend on Node built-ins, kept out of
 * the main entry so `@spacemolt/lib` stays browser-safe. Import from here in
 * Node/Bun when you want filesystem-backed credential storage.
 */

export { FileCredentialStore } from './auth/file-store.ts';
