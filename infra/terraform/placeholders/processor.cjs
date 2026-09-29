"use strict";

exports.handler = async function placeholderProcessor() {
  throw new Error(
    "lojo-mail processor placeholder. Run `npm run build:lambda` and set processor_bundle before apply.",
  );
};
