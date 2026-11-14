# AGENTS.md — open-code-review-eval 工单目录

## 项目现状（2026-11-15 收尾）

- 本 worktree 归属工单 **186dba00d66a**（评估与试用阿里 open-code-review），状态：**已收尾（复盘完成）**。
- **结论**：阿里 open-code-review 属实可用，已接入本机。入口命令 `ocr`（v1.13.9）；模型配置固化在 `~/.opencodereview/config.json`（provider `local-proxy` → 本机 harness 代理 127.0.0.1:15721，模型 glm-5.3-flash），无需环境变量；常驻技能 `open-code-review`（~/.agents/skills/open-code-review/SKILL.md）。
- **验证状态**：3 缺陷样本两次实跑（3/3 → 2/3，agent 循环非确定性，行号均精确）；清除 ANTHROPIC_* 环境变量的独立配置链验证通过（exit 0）。
- **硬约束**：
  1. npm 包名必须带 scope：`@alibaba-group/open-code-review`（裸名 404）；
  2. ocr 依赖本机 harness 代理在跑，宿主停机不可用；
  3. 检出率有波动，重要评审需人工确认关键文件或复跑取并集；
  4. 官方自述 recall 低于通用 agent（precision 优先），不能当穷尽式审查用。
- **本 work/ 目录与其他工单共享**（playground 仓库按工单分支共存）：本工单文件一律带 `open-code-review-186dba00d66a` 后缀，勿动他单文件。
- 复盘详情：[work/项目复盘-open-code-review-186dba00d66a.md](work/项目复盘-open-code-review-186dba00d66a.md)。
- **落地机制（2026-11-15 定）**：使用机制=技能自动发现+固化配置（已落）；全局规则 `~/.dsh/AGENTS.md` §十七
  （ocr 指针 + 可选初筛定位）；**不做 hook 级强制**——若后续真实使用证明值得默认化再升级。
