const config = require("../config");

const models = {
  primary: config.llm.primaryModel,
  fallback: config.llm.fallbackModel,
};

function getModelList() {
  return [models.primary, models.fallback];
}

module.exports = { models, getModelList };
