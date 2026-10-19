import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";

/**
 * 内网 https 的自签证书（方案 B，2026-10-19 老板拍板）。
 *
 * 为什么存在：浏览器硬性规定「摄像头只在 https / localhost 下可用」，
 * 内网 667 的 http 地址永远开不了扫码 —— 唯一出路是内网也上一个 https 端口。
 *
 * 为什么自己写 DER 而不引依赖：
 * - `selfsigned` 一类包拖着 node-forge（好几百 KB），这是给扩展打包用的仓库，依赖能省则省；
 * - `openssl` 命令行法要求机器上恰好装了 Git/openssl，换台机器就断；
 * - Node 内置 crypto 就够：能生成 RSA 密钥对、能做 SHA256 签名，缺的只是一层
 *   X.509 的 DER 组装 —— 下面这百余行就是把这层补上，只组装本场景需要的最小字段。
 *
 * 证书属性（都为「手机能少弹点麻烦」服务）：
 * - SAN 里塞 localhost + 本机所有 IPv4：地址栏是什么就匹配什么，浏览器警告页只有
 *   「自签证书」这一条可抱怨，而不是先报「主机名不匹配」把"继续访问"藏得更深；
 * - 有效期 10 年（UTCTime 到 2049 年都合法，够用）；
 * - 证书+私钥落 cacheDir/https/ 持久化：指纹不变，同一台手机接受过一次警告就不再弹
 *   （重新生成 = 所有手机重新接受一遍）。
 */

// ---------- DER 基础件 ----------

/** DER 长度字段：<128 直接一个字节，否则 0x80|字节数 + 大端 */
function derLen(n: number): number[] {
  if (n < 0x80) {
    return [n];
  }
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** 一个 TLV 元素：tag + 长度 + 内容 */
function tlv(tag: number, content: number[]): number[] {
  return [tag, ...derLen(content.length), ...content];
}

const SEQ = 0x30;
const SET = 0x31;

/** 点分 OID → DER 内容字节（base-128，最高位做续位标记） */
function oid(s: string): number[] {
  const parts = s.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const tmp = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      tmp.unshift(0x80 | (v & 0x7f));
      v >>= 7;
    }
    out.push(...tmp);
  }
  return tlv(0x06, out);
}

const OID_CN = "2.5.4.3";
const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_SAN = "2.5.29.17";
const OID_BASIC = "2.5.29.19";

/** Name：SEQUENCE of SET of SEQUENCE(OID, value)。只用到 CN，值用 UTF8String（0x0C） */
function nameOf(cn: string): number[] {
  const atv = tlv(SEQ, [...oid(OID_CN), ...tlv(0x0c, [...Buffer.from(cn, "utf8")])]);
  return tlv(SEQ, tlv(SET, atv));
}

/** UTCTime：YYMMDDHHMMSSZ（2049 年前都合法） */
function utcTime(d: Date): number[] {
  const p = (n: number): string => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, [...Buffer.from(s, "ascii")]);
}

/** GeneralName：dNSName=[2] IA5String(0x82) / iPAddress=[7] 4 字节(0x87) */
function generalName(host: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    return tlv(0x87, [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return tlv(0x82, [...Buffer.from(host, "ascii")]);
}

/**
 * 组一张自签证书，返回 PEM。
 * ⚠️ subjectPublicKeyInfo 直接用 node 导出的 SPKI DER —— 它本身就是 X.509 要的那个结构，
 *    不用再拆再装（拆了反而容易错）。
 */
function buildCertPem(
  keys: crypto.KeyPairKeyObjectResult,
  hosts: string[],
): string {
  const now = new Date();
  const expires = new Date(now.getTime() + 3650 * 24 * 3600 * 1000);
  const spki = keys.publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const sigAlg = tlv(SEQ, [...oid(OID_SHA256_RSA), ...tlv(0x05, [])]);
  const issuer = nameOf("Cherysis 自签根证书");
  const subject = issuer; // 自签：签发者=使用者
  const validity = tlv(SEQ, [...utcTime(now), ...utcTime(expires)]);
  const serial = tlv(
    0x02,
    // 正随机数 + 首字节压到 <0x80，省掉负数补 0x00 的分支
    [...crypto.randomBytes(15)].map((b, i) => (i === 0 ? b & 0x7f : b)),
  );

  // 扩展：SAN（塞满本机所有地址）+ basicConstraints CA:TRUE（自签根的常规写法）
  const sanNames = tlv(SEQ, hosts.flatMap(generalName));
  const sanExt = tlv(SEQ, [
    ...oid(OID_SAN),
    ...tlv(0x04, sanNames),
  ]);
  const basicExt = tlv(SEQ, [
    ...oid(OID_BASIC),
    ...tlv(0x01, [0xff]), // cA = TRUE
    ...tlv(0x04, tlv(SEQ, tlv(0x01, [0xff]))),
  ]);
  const extensions = tlv(0xa3, tlv(SEQ, [...sanExt, ...basicExt])); // [3] EXPLICIT

  const tbs = tlv(SEQ, [
    ...tlv(0xa0, tlv(0x02, [0x02])), // [0] EXPLICIT version = v3(2)
    ...serial,
    ...sigAlg,
    ...issuer,
    ...validity,
    ...subject,
    ...[...spki],
    ...extensions,
  ]);

  const signature = crypto
    .createSign("SHA256")
    .update(Buffer.from(tbs))
    .sign(keys.privateKey);
  const cert = tlv(SEQ, [...tbs, ...sigAlg, ...tlv(0x03, [0x00, ...signature])]);

  const pem = (tag: string, der: Buffer): string =>
    `-----BEGIN ${tag}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${tag}-----\n`;

  return pem(
    "CERTIFICATE",
    Buffer.from(cert),
  );
}

function rsaPem(keys: crypto.KeyPairKeyObjectResult): string {
  const der = keys.privateKey.export({ type: "pkcs1", format: "der" }) as Buffer;
  return `-----BEGIN RSA PRIVATE KEY-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END RSA PRIVATE KEY-----\n`;
}

/** 本机要写进 SAN 的地址：localhost + 所有 IPv4（剔除 APIPA 169.254.x.x，那个谁也连不上） */
export function localHosts(): string[] {
  const out = new Set<string>(["localhost"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal && !ni.address.startsWith("169.254.")) {
        out.add(ni.address);
      }
    }
  }
  return [...out];
}

/**
 * 拿（或生成）https 要用的证书与私钥。
 * 落 `cacheDir/https/`：指纹十年不变 —— 同一台手机接受过一次警告就一直不再弹。
 * 生成/读盘失败返回 null（调用方降级成「没有内网 https」，绝不能把 http 服务带崩）。
 */
export function ensureTlsCert(cacheDir: string): { key: string; cert: string } | null {
  const dir = path.join(cacheDir, "https");
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  try {
    if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
      const key = fs.readFileSync(keyFile, "utf-8");
      const cert = fs.readFileSync(certFile, "utf-8");
      // 能建出 SecureContext 才算数：文件损坏时宁可重新生成
      tls.createSecureContext({ key, cert });
      return { key, cert };
    }
    fs.mkdirSync(dir, { recursive: true });
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = rsaPem(keys);
    const cert = buildCertPem(keys, localHosts());
    tls.createSecureContext({ key, cert }); // 先验一把再落盘
    fs.writeFileSync(keyFile, key, "utf-8");
    fs.writeFileSync(certFile, cert, "utf-8");
    return { key, cert };
  } catch {
    return null;
  }
}
