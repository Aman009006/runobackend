const { AsyncLocalStorage } = require("async_hooks");

const branchStorage = new AsyncLocalStorage();

function runWithBranch(branch, callback) {
  return branchStorage.run(branch, callback);
}

// Current branch: {
//   id: 'bishkek',
//   name: 'Бишкек',
//   login: 'bishkek',
//   password: 'bishkek0110runo',
//   storeId: '40b43662-2117-11f1-0a80-1cb200302c3c',
//   retailStoreId: 'dfcd40ac-55cb-11f1-0a80-09d2000c8186'
// }

function getCurrentBranch() {
  const branch = branchStorage.getStore();

  if (!branch) {
    throw new Error("Текущий филиал не определён");
  }

  return branch;
}

function tryGetCurrentBranch() {
  return branchStorage.getStore() || null;
}

module.exports = {
  runWithBranch,
  getCurrentBranch,
  tryGetCurrentBranch,
};