# R9: recover uncertain transfer using the originally saved target

## Problem

转交请求已实际成功但响应中断时，恢复逻辑依赖新的下一步候选列表；原目标可能已经不在该列表。

## Fix plan

发送前持久化目标 step/user 快照；uncertain 恢复时直接用当前流程对照该快照，不依赖转交后的候选列表。

## Acceptance criteria

模拟请求成功后连接中断且候选列表已变化，刷新仍能确认 submitted；未匹配原目标时保持 uncertain，禁止重复提交。

## Regression policy

Keep the change isolated. Add focused regression coverage and do not weaken scope, identity, read-back, or duplicate-transfer protections.
