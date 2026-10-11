# 在 Render Free 发布 POC

仓库：`baogang/dh-poc`；分支：`value`。根目录的 `render.yaml` 创建一个 Docker Web Service，套餐为 Free，区域为 Singapore。镜像包含 Node 24、Python 3、冻结数据和本地业务 mock，无需创建数据库或 Redis。

## 第一次部署

1. 打开 [Render Dashboard](https://dashboard.render.com)，注册或登录；可以使用 GitHub 登录。
2. 选择 **New → Blueprint**，连接 GitHub，并授权读取私有仓库 `baogang/dh-poc`。只授权这个仓库即可。若仓库未出现，在 GitHub 的 Render 应用安装设置中添加该仓库。
3. 选择仓库，分支填 **`value`**，Blueprint 文件路径保持 **`render.yaml`**，Blueprint 名称可填 `dh-poc-demo`。
4. 在要求输入环境变量时填写 **`DEEPSEEK_API_KEY`**。直接填到 Render，不要粘贴到聊天、源码或 GitHub。确认资源列表只有一个 **Free Web Service**，然后点击 **Deploy Blueprint**。
5. 部署变为 **Live** 后，打开服务的 **Environment** 页面，查看自动生成的 **`POC_AUTH_PASSWORD`**。访问服务页面显示的 `https://….onrender.com`，在浏览器账号密码窗口输入用户名 **`admin`** 和该密码。

配置依据：[Render Blueprint 操作步骤](https://render.com/docs/infrastructure-as-code)、[Blueprint 环境变量与随机密码](https://render.com/docs/blueprint-spec)。

## 验收

- 访问 `/healthz` 返回 `{"status":"ok"}`；它不要求密码，也不返回模型信息、数据或凭证。
- 网站首页要求密码。登录后应显示四个测试模块、四个内置数据集，共 804 个案例。
- 先运行工程回归，最多案例数设为 2，并发设为 1；该模块不调用模型。随后选择情绪分析，最多案例数设为 1，并发设为 1，验证 DeepSeek 连接。
- 检查逐案结果、取消运行、导入预览和报告下载。长任务运行时保持页面打开；首次试用用小批量。
- 把公开网址发回本聊天即可继续检查；不用发送 API Key 或网站密码。

## 免费方案的边界

Free 服务闲置 15 分钟后休眠，再访问需要冷启动。导入数据、任务状态和新报告写入容器的临时文件系统，在休眠、重启或重新部署后会丢失；内置冻结数据始终来自镜像。需要留存时及时下载报告与保存导入源文件。长期持久化需要后续改造或付费磁盘。

Free 计算资源为 512 MB / 0.1 CPU，适合低并发演示。免费托管不包含 DeepSeek 调用费用。每个工作区每月共享 750 小时免费实例额度，另有流量与构建额度限制。详见 [Render 免费服务说明](https://render.com/docs/free) 和 [套餐字段](https://render.com/docs/blueprint-spec)。

## 配置与故障排查

`PORT` 和 `RENDER_EXTERNAL_URL` 由 Render 自动提供，程序监听 `0.0.0.0`，并按固定的 HTTPS 网站地址校验 Host 和 Origin；不依赖客户端传入的 forwarded headers。公开启动必须有至少 16 字符的网站密码。普通本机 `npm run web` 仍默认监听 `127.0.0.1:8787`。

`DEEPSEEK_API_KEY` 是模型凭证；`POC_AUTH_PASSWORD` 是网站访问密码，两者用途不同。密码仅在服务端验证，不发给前端。`.env`、本机导入集、运行报告和缓存不进入容器。

- 启动日志出现 `Public access requires POC_AUTH_PASSWORD`：在 Environment 中设置网站密码并重新部署。
- 页面出现 403 域名不匹配：使用服务的 `onrender.com` 地址；如需自定义域名，额外设置 `POC_PUBLIC_ORIGIN=https://你的域名`。程序一次只接受一个网站域名。
- 模型任务失败：确认 Key 有效、供应商账户有可用额度；查看 Render Logs，避免截图暴露环境变量。
- 内存不足或任务中断：将案例并发改为 1、缩小案例数，然后创建新任务。

自动部署等待 GitHub CI 通过。需要手动部署时，在服务页选择 **Manual Deploy → Deploy latest commit**。本项目只部署模拟业务，真实客服与真实后方系统仍需另外接入。
