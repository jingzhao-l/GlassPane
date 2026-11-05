/**
 * `git verify-tag` / `gpg --verify` 的**真字节**夹具（2026-11-05 在本机逐条量出来，
 * 不是凭印象写的字符串）。
 *
 * 为什么需要这一份：`installer/test/cli.test.mjs` 与 `daily-20261028-probe-and-verify-states.test.mjs`
 * 从前用 `stdout: 'Good signature'` 这种**生产里不存在**的桩喂 `classifyTagVerify`，
 * 于是"退出码 0 = 验签通过"这条错判据在测试里长得和真 gpg 一模一样——测试替判据担保，
 * 判据替字节担保，两头互相引用，没有一头碰过磁盘。现在判据读的是 stderr 里点名钥匙的那一行，
 * 桩就必须带那一行。
 *
 * 每一段的来源（命令都在本机跑过，可用文件里那句注释复现）：
 *  · `GOOD_SIG_*`     —— `git verify-tag v1.29.1` 对着一次性钥匙环（内置公钥导入进去）；
 *  · `GOOD_SIG_ZH_*`  —— **同一条命令**、不钉 locale 的那一趟：这台机器的语言设置是中文，
 *                        gpg 的散文跟着 locale 走（缺陷 P1 的另一半就藏在这里）；
 *  · `FOREIGN_SIG_*`  —— 一枚临时生成的别的钥匙签出来的 tag（`git tag -s`），用那把钥匙的
 *                        钥匙环验它：退出码 0、`using RSA key 267BF8A4…`；
 *  · `NO_PUBLIC_KEY_*`—— 同一枚 tag 用内置公钥的钥匙环验（读不到那把钥匙）：退出码 1；
 *  · `UNSIGNED_*`     —— 未签名的附注 tag；
 *  · `VALIDSIG_*`     —— updater 那一形（`gpg --status-fd 1 --verify <.asc>`）的机器可读行，
 *                        第一个字段是签名的钥匙、第九个字段才是主钥匙。
 */

/** 内置钉死的发布公钥指纹（与 `installer/cli.js` 的 GLASSPANE_SIGNING_KEY_ID 同值；
 *  这里**不**从 cli.js 读，是因为夹具要能在判据被改坏时仍给出独立的一份期望值——
 *  两处一致由 `daily-20261105-signature-key-id.test.mjs` 那条断言钉）。 */
export const PINNED_KEY_ID = '0929EA31DF4F7429F63FC53189D88B1D043A1298'

/** 本机临时生成的一把别的钥匙（`gpg --batch --gen-key`，uid Foreign Tester）。 */
export const FOREIGN_KEY_ID = '267BF8A4BEB709A95EE623E1E3EBAB45B61145F7'

/** 发布 tag 的 uid（与 GLASSPANE_SIGNING_KEY_UID 同值）。 */
export const PINNED_KEY_UID = 'jingzhao-l (sign-github) <ET_lin@outlook.com>'

/** 一次性钥匙环 + `LC_ALL=C`（安装器现在跑的形态）：退出码 0。
 *  `[unknown]` 与后面那三行 WARNING 是**导入进来的公钥没有属主信任**时的正常输出，
 *  末尾那一行单独出现的指纹是 gpg 顺手打印的主钥匙指纹——判据不许把它读成"签名的钥匙"，
 *  也不许因为多出来几行就认不出上面那一行。 */
export const GOOD_SIG_STDERR_C_LOCALE = [
  'gpg: Signature made Wed Nov  4 16:20:32 2026 CST',
  'gpg:                using RSA key 0929EA31DF4F7429F63FC53189D88B1D043A1298',
  'gpg: Good signature from "jingzhao-l (sign-github) <ET_lin@outlook.com>" [unknown]',
  'gpg: WARNING: This key is not certified with a trusted signature!',
  'gpg:          There is no indication that the signature belongs to the owner.',
  '      0929EA31DF4F7429F63FC53189D88B1D043A1298',
].join('\n') + '\n'

/** 同一枚 tag、钥匙环里那把钥匙被标成 ultimate 时的那三行（本机 2026-11-05 的另一趟实测）。 */
export const GOOD_SIG_STDERR_C_LOCALE_ULTIMATE = [
  'gpg: Signature made Wed Nov  4 16:20:32 2026 CST',
  'gpg:                using RSA key 0929EA31DF4F7429F63FC53189D88B1D043A1298',
  `gpg: Good signature from "${PINNED_KEY_UID}" [ultimate]`,
].join('\n') + '\n'

/** 同一条命令、**没有** locale 钉：这台机器答中文（逐字节抄自本机的 stderr）。
 *  指纹还在，点名的那一行却不再是英文措辞——不 `LC_ALL=C` 就是让操作系统的语言决定这道
 *  检查出不出得来结论。 */
export const GOOD_SIG_STDERR_ZH_LOCALE = [
  'gpg: 签名建立于 三 11月/ 4 16:20:32 2026 CST',
  'gpg:               使用 RSA 密钥 0929EA31DF4F7429F63FC53189D88B1D043A1298',
  'gpg: 完好的签名，来自于   “jingzhao-l (sign-github) <ET_lin@outlook.com>” [绝对]',
].join('\n') + '\n'

/** 别人的钥匙签的 tag，用**那把**钥匙的钥匙环验：退出码 0，`Good signature`，而点名的
 *  指纹不是钉死的那一枚——这正是"随便一把好钥匙验过"被读成"发布者签过"的那一幕。 */
export const FOREIGN_SIG_STDERR_C_LOCALE = [
  'gpg: Signature made Thu Nov  5 08:32:54 2026 CST',
  `gpg:                using RSA key ${FOREIGN_KEY_ID}`,
  'gpg: Good signature from "Foreign Tester <foreign@example.test>" [ultimate]',
].join('\n') + '\n'

/** 同一枚别人的 tag，用**内置公钥**的钥匙环验（钥匙环里没有那把）：退出码 1。 */
export const NO_PUBLIC_KEY_STDERR = [
  'gpg: Signature made Thu Nov  5 08:32:54 2026 CST',
  `gpg:                using RSA key ${FOREIGN_KEY_ID}`,
  "gpg: Can't check signature: No public key",
  'error: gpg failed to verify the signature',
  'error: could not verify v9.9.9',
].join('\n') + '\n'

/** 未签名的附注 tag（`git verify-tag v0.0.0` 实测：git 自己打印这一行，退 1）。 */
export const UNSIGNED_STDERR = 'error: no signature found\n'

/** 签名对不上（文件被换过）时 gpg 的那一句英文措辞 + git 的两行。
 *  `已损坏的签名，来自于` 是它的中文对应（本机同一趟量到的），英文这一行按 gpg 的 C locale
 *  输出写；这一档的判据本来就不读它（退出码非 0 且不是"no signature found"就是 invalid）。 */
export const BAD_SIG_STDERR = [
  `gpg: Signature made Thu Nov  5 08:32:54 2026 CST`,
  `gpg:                using RSA key ${FOREIGN_KEY_ID}`,
  'gpg: BAD signature from "Foreign Tester <foreign@example.test>" [ultimate]',
  'error: gpg failed to verify the signature',
].join('\n') + '\n'

/** updater 那一形：`gpg --batch --status-fd 1 --verify SHA256SUMS-<ver>.txt.asc`。
 *  `VALIDSIG` 的第一个字段是做出签名的钥匙，第九个字段是主钥匙——子钥匙签名时两者不同，
 *  判据只取第一个（与 `updater/lib/signature.js` 的 `validSigFingerprint` 同一口径）。
 *  下面的行是本机用临时钥匙真签真验量出来的形状，指纹换成内置那一枚的是为了把"同一条
 *  判据读两种生产输出"这件事测到。 */
export function statusFdLines(fingerprint, keyid = fingerprint.slice(-16), uid = PINNED_KEY_UID) {
  return [
    '[GNUPG:] BEGIN  ',
    '[GNUPG:] NEWSIG ',
    `[GNUPG:] GOODSIG ${keyid} ${uid}`,
    `[GNUPG:] VALIDSIG ${fingerprint} 2026-11-04 1793780432 0 4 0 1 8 00 ${fingerprint}`,
    '[GNUPG:] TRUST_UNDEFINED 0 pgp',
    '[GNUPG:] END  ',
  ].join('\n') + '\n'
}

/** `--status-fd` 那趟的 stderr（与上面 stdout 同一次运行）。 */
export const STATUS_FD_STDERR = GOOD_SIG_STDERR_C_LOCALE
