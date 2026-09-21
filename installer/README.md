# glasspane-install

GlassPane 一键安装器（零第三方依赖，Node >= 18，macOS 14+）。

```bash
npx glasspane-install            # 完整安装：编译 → 打包 → 后台服务 → 设置面板
npx glasspane-install --help     # 全部选项
node cli.js --restore-launchd    # 后台服务开机自启被停用后的一条恢复命令
```

安装过程只有两处需要人工：系统设置里的权限勾选（无程序化路径，面板有逐卡
引导与实测），以及对破坏性步骤（替换旧实例）的一次确认。其余检测、验证、
恢复全部机器完成。
License: MIT.
