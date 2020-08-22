const Mustache = require("mustache");

const getStatusLength = function (edit, name, template) {
  // https://support.twitter.com/articles/78124-posting-links-in-a-tweet
  const fakeUrl = "http://t.co/BzHLWr31Ce";

  const status = Mustache.render(template, {
    name,
    url: fakeUrl,
    page: edit.page,
  });

  return status.length;
};

const getStatus = function (edit, name, template) {
  let page = edit.page;
  const len = getStatusLength(edit, name, template);

  if (len > 280) {
    const newLength = edit.page.length - (len - 139);
    page = edit.page.slice(0, +newLength + 1 || undefined);
  }

  return Mustache.render(template, {
    name,
    url: edit.url,
    page,
  });
};

exports.getStatus = getStatus;
