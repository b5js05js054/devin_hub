---
kind: upgrade-guide
description: "桌面端在 run_code 中召唤专家时返回后台任务编号。"
---

# 用 job_output 领取桌面专家的答复

[English](guide.md) | 中文

## 变更

以前通过 `run_code` 调用 `summon_expert` 或 `summon_experts` 时，程序会直接收到最终答案。现在主会话受理任务后就返回 `{ kind: 'background', jobId }`，批量召唤的所有专家共用一个编号。直接调用召唤工具仍会返回答案。

## 迁移

1. 保存返回的 `jobId`。如果程序在显示编号前超时，重新派发前先用 `job_list` 查找已受理的任务。
2. 收到完成通知后，调用 `job_output({ job_id: jobId })`。成功完成时，将返回值的 `text` 按 JSON 解析，即可得到单个专家的 `{ expert, answer }` 或小组的 `{ results }`。需要提前结束时，使用 `job_kill`。
