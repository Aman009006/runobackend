const BRANCHES = {
  bishkek: {
    id: "bishkek",
    name: "Бишкек",

    login: process.env.BRANCH_BISHKEK_LOGIN,
    password: process.env.BRANCH_BISHKEK_PASSWORD,

    storeId: process.env.MOYSKLAD_STORE_ID_BISHKEK,
    retailStoreId: process.env.MOYSKLAD_RETAIL_STORE_ID_BISHKEK,
  },

  dordoy: {
    id: "dordoy",
    name: "Дордой",

    login: process.env.BRANCH_DORDOY_LOGIN,
    password: process.env.BRANCH_DORDOY_PASSWORD,

    storeId: process.env.MOYSKLAD_STORE_ID_DORDOY,
    retailStoreId: process.env.MOYSKLAD_RETAIL_STORE_ID_DORDOY,
  },

  osh: {
    id: "osh",
    name: "Ош",

    login: process.env.BRANCH_OSH_LOGIN,
    password: process.env.BRANCH_OSH_PASSWORD,

    storeId: process.env.MOYSKLAD_STORE_ID_OSH,
    retailStoreId: process.env.MOYSKLAD_RETAIL_STORE_ID_OSH,
  },
};

function findBranchByCredentials(login, password) {
  return Object.values(BRANCHES).find(
    (branch) =>
      branch.login === login &&
      branch.password === password
  );
}

function getBranchById(branchId) {
  return BRANCHES[branchId] || null;
}

module.exports = {
  BRANCHES,
  findBranchByCredentials,
  getBranchById,
};