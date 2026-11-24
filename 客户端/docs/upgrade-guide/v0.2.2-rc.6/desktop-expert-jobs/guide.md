---
kind: upgrade-guide
description: "Desktop expert calls inside run_code return a background job ID."
---

# Collect desktop expert answers with job_output

English | [中文](guide.zh.md)

## Change

Programs that call `summon_expert` or `summon_experts` through `run_code` previously received the finished answer inline. They now receive `{ kind: 'background', jobId }` as soon as the session accepts the job. A batch receives one ID for all its experts. Direct calls still return the answer inline.

## Migration

1. Keep the returned `jobId`. If the program times out before displaying it, use `job_list` to find accepted work before submitting it again.
2. After the completion notice, call `job_output({ job_id: jobId })`. For a completed job, parse its `text` as JSON to obtain `{ expert, answer }` or the batch’s `{ results }`. Use `job_kill` to stop the job early.
