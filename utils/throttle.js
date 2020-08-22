const lastChange = {};

const isRepeat = function (edit) {
  const k = `${edit.wikipedia}`;
  const v = `${edit.page}:${edit.user}`;
  const r = lastChange[k] === v;
  lastChange[k] = v;
  return r;
};

exports.isRepeat = isRepeat;
