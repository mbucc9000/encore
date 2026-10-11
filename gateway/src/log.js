'use strict';
// Timestamped logging. Never log secrets, tokens or signatures.
const t = () => new Date().toISOString().slice(11, 23);
module.exports = {
  info: (...a) => console.log(t(), 'I', ...a),
  warn: (...a) => console.warn(t(), 'W', ...a),
  error: (...a) => console.error(t(), 'E', ...a),
};
