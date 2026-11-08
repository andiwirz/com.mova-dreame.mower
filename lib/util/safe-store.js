'use strict';

/** Normalize Homey store reads that can return a value, null, or a promise. */
module.exports = async function safeGetStoreValue(device, key) {
  try {
    return await Promise.resolve(device.getStoreValue(key));
  } catch (_) {
    return null;
  }
};
