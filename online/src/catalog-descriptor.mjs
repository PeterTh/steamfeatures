import { BINARY_FORMAT } from './catalog-binary.mjs';

export const BINARY_MAX_BYTES = 150 * 1024 * 1024;
export const COMPRESSED_MAX_BYTES = 40 * 1024 * 1024;

function payload(value, filename, maximumBytes, label) {
  if (!value || value.file !== filename || typeof value.sha256 !== 'string' || value.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maximumBytes) {
    throw new Error(`Invalid ${label} descriptor: expected a pinned filename, SHA-256 checksum, and bounded size.`);
  }
}

/** Validate the browser payload descriptor before resolving paths or downloading data. */
export function validateBinaryDescriptor(descriptor) {
  if (descriptor?.format !== BINARY_FORMAT) throw new Error('This binary catalog format is not supported.');
  const filename = `catalog.${String(descriptor.sha256).slice(0, 16)}.bin`;
  payload(descriptor, filename, BINARY_MAX_BYTES, 'binary catalog');
  payload(descriptor.gzip, `${filename}.gz`, COMPRESSED_MAX_BYTES, 'gzip binary catalog');
  payload(descriptor.brotli, `${filename}.br`, COMPRESSED_MAX_BYTES, 'Brotli binary catalog');
  return descriptor;
}
