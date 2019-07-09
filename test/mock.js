const CONN = require('../core');
const ConnScheduler = require('../scheduler');
const os = require('os');
const fs = require('fs');
const path = require('path');

module.exports = function mock() {
  const testPath = fs.mkdtempSync(path.join(os.tmpdir(), 'conntest-'));

  const mockSSB = {
    addListener() {},
    close: {
      hook: () => {},
    },
    post: () => {},
    connect: (_address, cb) => {
      setTimeout(() => {
        cb(null, {});
      }, 200);
    },
  };
  const mockConfig = {
    path: testPath,
  };

  mockSSB.conn = new CONN(mockSSB, mockConfig);
  mockSSB.connScheduler = new ConnScheduler(mockSSB, mockConfig);

  return mockSSB;
};
