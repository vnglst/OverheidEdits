#!/usr/bin/env node
const async = require("async");
const Twit = require("twit");
const minimist = require("minimist");
const { WikiChanges } = require("wikichanges");

const { isIpInAnyRange } = require("./utils/ip");
const { getStatus } = require("./utils/twitter");
const { isRepeat } = require("./utils/throttle");

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false,
    config: "./config.json",
  },
});

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
exports.getStatus = getStatus;
exports.main = main;
