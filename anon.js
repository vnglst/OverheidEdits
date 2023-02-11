#!/usr/bin/env node

const fs = require("fs");
const Twit = require("twit");
const async = require("async");
const minimist = require("minimist");
const Mastodon = require("mastodon");
const Mustache = require("mustache");
const puppeteer = require("puppeteer");
const { WikiChanges } = require("wikichanges");
const { Address4, Address6 } = require("ip-address");

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false,
    config: "./config.json",
  },
});

function log(msg, data) {
  return console.log(
    `[${new Date().toLocaleString()}] ${msg}`,
    data ? data : ""
  );
}

function address(ip) {
  if (Array.from(ip).includes(":")) {
    return new Address6(ip);
  } else {
    const i = new Address4(ip);
    const subnetMask = 96 + i.subnetMask;
    const newIp = `::ffff:${i.toGroup6()}/${subnetMask}`;
    return new Address6(newIp);
  }
}

function ipToInt(ip) {
  return address(ip).bigInteger();
}

function compareIps(ip1, ip2) {
  const r = ipToInt(ip1).compareTo(ipToInt(ip2));
  if (r === 0) {
    return 0;
  } else if (r > 0) {
    return 1;
  } else {
    return -1;
  }
}

function isIpInRange(ip, block) {
  if (Array.isArray(block)) {
    return compareIps(ip, block[0]) >= 0 && compareIps(ip, block[1]) <= 0;
  } else {
    const a = address(ip);
    const b = address(block);
    return a.isInSubnet(b);
  }
}

function isIpInAnyRange(ip, blocks) {
  for (let block of Array.from(blocks)) {
    if (isIpInRange(ip, block)) {
      return true;
    }
  }
  return false;
}

function getConfig(path) {
  const config = loadJson(path);
  // see if ranges are externally referenced as a separate .json files
  if (config.accounts) {
    for (let account of Array.from(config.accounts)) {
      if (typeof account.ranges === "string") {
        account.ranges = loadJson(account.ranges);
      }
    }
  }
  log("loaded config from", path);
  return config;
}

function loadJson(path) {
  if (path[0] !== "/" && path.slice(0, 2) !== "./") {
    path = `./${path}`;
  }
  return require(path);
}

function getStatusLength(edit, name, template) {
  // https://support.twitter.com/articles/78124-posting-links-in-a-tweet
  const fakeUrl = "https://t.co/BzHLWr31Ce";
  const status = Mustache.render(template, {
    name,
    url: fakeUrl,
    page: edit.page,
  });
  return status.length;
}

function getStatus(edit, name, template) {
  let page = edit.page;
  const len = getStatusLength(edit, name, template);
  if (len > 280) {
    const newLength = edit.page.length - (len - 279);
    page = edit.page.slice(0, +newLength + 1 || undefined);
  }
  return Mustache.render(template, {
    name,
    url: edit.url,
    page,
  });
}

const lastChange = {};

function isRepeat(edit) {
  const k = `${edit.wikipedia}`;
  const v = `${edit.page}:${edit.user}`;
  const r = lastChange[k] === v;
  lastChange[k] = v;
  return r;
}

async function takeScreenshot(url) {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox"],
    // enable this for Raspberry Pi
    executablePath: "chromium-browser",
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.setViewport({ width: 1024, height: 768 });

  const filename = Date.now() + ".png";
  const selector = "table.diff.diff-contentalign-left";

  const rect = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const { x, y, width, height } = element.getBoundingClientRect();
    return { left: x, top: y, width, height, id: element.id };
  }, selector);

  await page.screenshot({
    path: filename,
    clip: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
  });

  await browser.close();
  return filename;
}

async function sendStatus(account, status, edit) {
  log(status);

  if (!argv.noop && (!account.throttle || !isRepeat(edit))) {
    const screenshot = await takeScreenshot(edit.url);

    // Mastodon
    if (account.mastodon) {
      const mastodon = new Mastodon(account.mastodon);
      const altText = "Screenshot of edit to " + edit.page;
      const response = await mastodon.post("media", {
        file: fs.createReadStream(screenshot),
        description: altText,
      });
      if (!response.data.id) {
        log("error uploading screenshot to mastodon");
        return;
      }

      mastodon
        .post("statuses", {
          status: status,
          media_ids: [response.data.id],
        })
        .catch((err) => log("error posting to mastodon", err));
    }

    // Twitter
    if (account.access_token) {
      const twitter = new Twit(account);
      const b64content = fs.readFileSync(screenshot, { encoding: "base64" });

      // upload the screenshot to twitter
      twitter.post(
        "media/upload",
        { media_data: b64content },
        function (err, data) {
          if (err) {
            log(err);
            return;
          }

          // add alt text for the media, for use by screen readers
          const mediaIdStr = data.media_id_string;
          const altText = "Screenshot of edit to " + edit.page;
          const metaParams = {
            media_id: mediaIdStr,
            alt_text: { text: altText },
          };

          twitter.post("media/metadata/create", metaParams, function (err) {
            if (err) {
              log(
                "metadata upload for twitter screenshot alt text failed with error",
                err
              );
            }
            const params = {
              status: status,
              media_ids: [mediaIdStr],
            };
            twitter.post("statuses/update", params, function (err) {
              if (err) {
                log(err);
              }
            });
            fs.unlinkSync(screenshot);
          });
        }
      );
    }
  }
}

function inspect(account, edit) {
  if (edit.url) {
    sendRestartMsg(account, edit);

    if (
      account.whitelist &&
      account.whitelist[edit.wikipedia] &&
      account.whitelist[edit.wikipedia][edit.page]
    ) {
      const status = getStatus(edit, edit.user, account.template);
      sendStatus(account, status, edit);
    } else if (account.ranges && edit.anonymous) {
      for (let name in account.ranges) {
        const ranges = account.ranges[name];
        if (isIpInAnyRange(edit.user, ranges)) {
          const status = getStatus(edit, name, account.template);
          sendStatus(account, status, edit);
        }
      }
    }
  }
}

let SHOULD_SEND_TEST = true;

async function sendRestartMsg(account, edit) {
  if (argv.noop) return;
  if (!SHOULD_SEND_TEST) return;
  if (!edit.url.startsWith("https://nl")) return;
  SHOULD_SEND_TEST = false;

  if (account.mastodon) {
    const screenshot = await takeScreenshot(edit.url);
    const mastodon = new Mastodon(account.mastodon);
    const altText = "Screenshot of edit to " + edit.url;
    const response = await mastodon.post("media", {
      file: fs.createReadStream(screenshot),
      description: altText,
    });
    if (!response.data.id) {
      log("error uploading screenshot to mastodon");
      return;
    }

    mastodon
      .post("statuses", {
        status:
          "@koen@maakr.social I just restarted. Here's a test screenshot of a recent edit.",
        visibility: "direct",
        media_ids: [response.data.id],
      })
      .catch((err) => log("error posting to mastodon", err));

    log("sent Mastodon test message");

    fs.unlinkSync(screenshot);
  }

  if (account.access_token) {
    const twitter = new Twit(account);
    twitter.post(
      "statuses/update",
      { status: "@vnglst I just restarted. Should be fine." },
      function (err) {
        if (err) {
          log(err);
        } else {
          log("sent Twitter test message");
        }
      }
    );
  }
}

function checkConfig(config, error) {
  if (config.accounts) {
    return async.each(config.accounts, canTweet, error);
  } else {
    return error("missing accounts stanza in config");
  }
}

function canTweet(account, error) {
  if (!account.access_token) {
    error(null);
  } else {
    try {
      const twitter = new Twit(account);
      const a = account["access_token"];
      return twitter.get(
        "search/tweets",
        { q: "cats" },
        function (err, data, response) {
          if (err) {
            error(err + " for access_token " + a);
          } else if (
            !response.headers["x-access-level"] ||
            response.headers["x-access-level"].substring(0, 10) !== "read-write"
          ) {
            error(`no read-write permission for access token ${a}`);
          } else {
            error(null);
          }
        }
      );
    } catch (err) {
      error(`unable to create twitter client for account: ${account}`);
    }
  }
}

function main() {
  const config = getConfig(argv.config);
  return checkConfig(config, function (err) {
    if (!err) {
      const wikipedia = new WikiChanges({ ircNickname: config.nick });
      return wikipedia.listen((edit) => {
        if (argv.verbose) {
          log(JSON.stringify(edit, null, 4));
        }
        Array.from(config.accounts).map((account) => inspect(account, edit));
      });
    } else {
      return log(err);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  address,
  ipToInt,
  compareIps,
  isIpInRange,
  isIpInAnyRange,
  getConfig,
  getStatus,
  takeScreenshot,
};
