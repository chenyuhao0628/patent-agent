# R4: save transfer draft before switching file source

Priority: **P2**

## Problem

特定“更换文件来源”入口直接清缓存和状态，绕过本地 review 保存。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

切换来源前执行 saveLocalReview；保存失败时禁止清空当前编辑态；只在成功后重置缓存。

## Acceptance criteria

编辑表单后直接更换来源，返回原来源时内容仍存在；模拟保存失败时页面保留当前输入。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
