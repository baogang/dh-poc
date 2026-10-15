# Road 三分类情绪数据 v1

48 条人工编写的合成案例：中文、英文、阿拉伯文各 16 条，positive 15、negative 15、neutral 18。包含沙特口语、语码混用、讽刺、否定、历史与当前情绪、他人引述及指令注入。每个 expected.route 由已确认的业务规则确定：FAQ 未命中后，negative → human，其余 → loop。

标签在运行前冻结；均为 provisional，尚未经过母语标注人员复核。dev 12 / regression 36。这里直接调用情绪模块，不运行 FAQ；FAQ 命中跳过情绪、负向暂停旧 HITL 等整合路由由 road-v2 和工程测试另测。

另复用 datasets/v3.0/emotion 的 620 条既有输入：608 条 classified 三分类计分，12 条 needs_clarification 原金标为 null，不纳入三分类正确率；后者只检查输出协议是否满足三类约束。两套集合均非真实用户生产准确率。
