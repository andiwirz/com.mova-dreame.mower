'use strict';

// PR-facing facade: the central garage state machine currently lives in
// GarageSafetyEngine for compatibility with earlier field builds. New code should
// depend on this alias so the internals can be split further without touching the
// original app integration points.
module.exports = require('./GarageSafetyEngine');
