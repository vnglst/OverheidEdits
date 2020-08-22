#!/usr/bin/env node

const ipv6 = require("ipv6");
const async = require("async");
const Twit = require("twit");
const minimist = require("minimist");
const Mustache = require("mustache");
const { WikiChanges } = require("wikichanges");

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false,
    config: "./config.json",
  },
});

const address = function (ip) {
  if (ip.includes(":")) return new ipv6.v6.Address(ip);
  const i = new ipv6.v4.Address(ip);
  const subnetMask = 96 + i.subnetMask;
  ip = "::ffff:" + i.toV6Group() + "/" + subnetMask;
  return new ipv6.v6.Address(ip);
};

const ipToInt = function (ip) {
  const i = address(ip);
  return i.bigInteger();
};

const compareIps = function (ip1, ip2) {
  const r = ipToInt(ip1).compareTo(ipToInt(ip2));
  if (r === 0) return 0;
  if (r > 0) return 1;
  return -1;
};

const isIpInRange = function (ip, block) {
  if (Array.isArray(block)) {
    return compareIps(ip, block[0]) >= 0 && compareIps(ip, block[1]) <= 0;
  }

  const a = address(ip);
  const b = address(block);
  return a.isInSubnet(b);
};

const isIpInAnyRange = function (ip, blocks) {
  for (let block of Array.from(blocks)) {
    if (isIpInRange(ip, block)) {
      return true;
    }
  }
  return false;
};

const getConfig = function (path) {
  const config = loadJson(path);
  // see if ranges are externally referenced as a separate .json files
  if (config.accounts) {
    for (let account of Array.from(config.accounts)) {
      if (typeof account.ranges === "string") {
        account.ranges = loadJson(account.ranges);
      }
    }
  }
  console.log("loaded config from", path);
  return config;
};

var loadJson = function (path) {
  if (path[0] !== "/" && path.slice(0, 2) !== "./") {
    path = "./" + path;
  }
  return require(path);
};

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

const lastChange = {};

const isRepeat = function (edit) {
  const k = `${edit.wikipedia}`;
  const v = `${edit.page}:${edit.user}`;
  const r = lastChange[k] === v;
  lastChange[k] = v;
  return r;
};

const tweet = function (account, status, edit) {
  console.log(status);
  if (!argv.noop && (!account.throttle || !isRepeat(edit))) {
    const twitter = new Twit(account);
    return twitter.post("statuses/update", { status }, function (err) {
      if (err) {
        return console.log(err);
      }
    });
  }
};

function inspect(account, edit) {
  if (!edit.url) return;

  let status;

  if (argv.verbose) {
    console.log(edit.url);
  }

  if (
    account.whitelist &&
    account.whitelist[edit.wikipedia] &&
    account.whitelist[edit.wikipedia][edit.page]
  ) {
    status = getStatus(edit, edit.user, account.template);
    return tweet(account, status, edit);
  } else if (
    account.namespaces != null &&
    !Array.from(account.namespaces).includes(edit.namespace)
  ) {
  } else if (account.ranges && edit.anonymous) {
    return (() => {
      const result = [];
      for (let name in account.ranges) {
        const ranges = account.ranges[name];
        if (isIpInAnyRange(edit.user, ranges)) {
          status = getStatus(edit, name, account.template);
          result.push(tweet(account, status, edit));
        } else {
          result.push(undefined);
        }
      }
      return result;
    })();
  }
}

const checkConfig = function (config, error) {
  if (config.accounts) {
    return async.each(config.accounts, canTweet, error);
  } else {
    return error("missing accounts stanza in config");
  }
};

function canTweet(account, error) {
  try {
    const twitter = new Twit(account);
    const a = account["access_token"];

    function handleTestGet(err, data, response) {
      if (err) {
        return error(err + " for access_token " + a);
      } else if (
        !response.headers["x-access-level"] ||
        response.headers["x-access-level"].substring(0, 10) !== "read-write"
      ) {
        return error("no read-write permission for access token " + a);
      } else {
        return error(null);
      }
    }

    return twitter.get("search/tweets", { q: "cats" }, handleTestGet);
  } catch (err) {
    return error(
      "unable to create twitter client for account: " + account + " Error: ",
      err
    );
  }
}

function main() {
  const config = getConfig(argv.config);
  return checkConfig(config, function (err) {
    if (err) return console.log(err);

    const wikipedia = new WikiChanges({ ircNickname: config.nick });

    return wikipedia.listen((edit) =>
      config.accounts.map((account) => inspect(account, edit))
    );
  });
}

if (require.main === module) {
  main();
}

// for testing
exports.address = address;
exports.compareIps = compareIps;
exports.isIpInRange = isIpInRange;
exports.isIpInAnyRange = isIpInAnyRange;
exports.ipToInt = ipToInt;
exports.getStatus = getStatus;
exports.main = main;
