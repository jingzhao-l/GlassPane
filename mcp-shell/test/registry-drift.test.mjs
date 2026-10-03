import assert from "node:assert/strict";
import test from "node:test";
import { registryDriftReason } from "../dist/project-registry.js";

/**
 * 注册表是读—改—写，而 `saveProjects` 的 tmp+rename 只挡住"读到写坏的一半"，
 * 挡不住"两次完整的写互相覆盖"。这一份表有三个进程会重写（daemon CLI、
 * shell 工具、面板——`saveProjects` 自己的注释就这么写的），所以真正的失败形状是：
 * 本进程读出 N 条 → 别人往同一份文件追加一条并落盘 → 本进程把自己那 N 条
 * （带新 entry、少别人那条）rename 上去，然后**报告成功**。
 *
 * `projectSet` 是同步的，测试没法在它读盘与写盘之间插一次写，所以判据被抽成
 * 这个纯函数单独验。反向变异：把 `registryDriftReason` 改成恒返回 null
 * （等于没有这道闸），下面四条一起变红。
 */
test("the same file identity is not drift", () => {
  assert.equal(registryDriftReason("/p/projects.json", "1:2:3", "1:2:3"), null);
  assert.equal(registryDriftReason("/p/projects.json", null, null),
    null, "读时不在、写时也不在：没有别人的写在这里");
});

test("an entry appearing underneath the edit is refused, not overwritten", () => {
  const reason = registryDriftReason("/p/projects.json", null, "9:100:11");
  assert.ok(reason, "文件从无到有就是有人写过，必须拦");
  assert.match(reason, /was absent/);
});

test("a changed file is refused and the retry path is named", () => {
  const reason = registryDriftReason("/p/projects.json", "1:2:3", "4:5:6");
  assert.ok(reason);
  assert.match(reason, /Repeat gp_project_set/, "拒绝要给一条做得动的下一步");
  assert.match(reason, /wrote nothing/, "必须说清这次什么都没写");
  assert.match(reason, /do not force the write/,
    "拒绝不许顺手递一把能绕过它的钥匙：强制覆写正是这道闸要防的丢更新");
});

test("the file being taken away is refused too", () => {
  const reason = registryDriftReason("/p/projects.json", "1:2:3", null);
  assert.ok(reason, "读到时在、要写时没了，同样不许盖");
  assert.match(reason, /now absent/);
});
