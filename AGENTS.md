# Runtime Ownership — HARD RULE

Windows 微信运行时生命周期完全由用户人工控制。

Coding Agent 永远不得：

- 关闭 Weixin.exe
- 启动 Weixin.exe
- 重启 Weixin.exe
- 关闭 WeixinHook.UI.exe
- 启动 WeixinHook.UI.exe
- 重启 WeixinHook.UI.exe
- kill / terminate / suspend 任何微信相关进程
- 为了刷新环境变量而自行重启进程
- 为了刷新 DLL/artifact 而自行重启进程
- 自动执行 Inject
- 自动执行真实微信发送操作

明确禁止执行，包括但不限于：

- taskkill
- Stop-Process
- kill
- TerminateProcess
- Start-Process ...Weixin...
- Start-Process ...WeixinHook.UI...
- 直接执行 Weixin.exe
- 直接执行 WeixinHook.UI.exe

允许：

- Get-Process / tasklist 等只读检查
- 查询 PID、模块、版本、hash
- 读取日志
- build
- test
- 静态分析
- 准备运行时 artifact
- 给用户生成需要人工执行的命令

如果下一步需要：

- 重启微信
- 重启 Hook UI
- 设置必须在进程启动前继承的环境变量
- Inject
- 人工发送微信消息

Coding Agent 必须立即停止，并输出：

MANUAL_RUNTIME_ACTION_REQUIRED=YES  
REASON=<原因>  
USER_STEPS=<用户需要人工执行的最小步骤>  
RESUME_CONDITION=<什么证据出现后再继续>

然后等待用户提供结果。

不得自行执行 USER_STEPS。

此规则优先级高于任务正文中的 runtime 测试要求。
