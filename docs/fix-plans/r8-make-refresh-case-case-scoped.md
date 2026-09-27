# R8: make Refresh Case operate on the selected case only

## Problem

“刷新本案”先执行 full sync，全账号同步的耗时或失败会阻塞单案刷新。

## Fix plan

将单案刷新改为只请求当前案件需要的流程、材料、案件信息和官方结论；全账号同步保留独立入口。

## Acceptance criteria

其他案件接口失败不影响当前案件刷新；当前案流程/材料/结论仍更新；账号/流程作用域保护不削弱。

## Regression policy

Keep the change isolated. Add focused regression coverage and do not weaken scope, identity, read-back, or duplicate-transfer protections.
