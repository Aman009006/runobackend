const { AsyncLocalStorage } = require("async_hooks");

const branchStorage = new AsyncLocalStorage();

function runWithBranch(branch, callback) {
  return branchStorage.run(branch, callback);
}

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