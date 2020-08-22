const ipv6 = require("ipv6");

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

exports.compareIps = compareIps;
exports.isIpInRange = isIpInRange;
exports.isIpInAnyRange = isIpInAnyRange;
