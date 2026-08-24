'use strict';
const core = require('@actions/core');
const { run } = require('./dismiss');

if (require.main === module) {
  run().catch(err => core.setFailed(err.message));
}

module.exports = { run };
