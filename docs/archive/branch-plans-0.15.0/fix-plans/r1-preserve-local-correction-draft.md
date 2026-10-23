# R1: preserve local correction drafts when file picking is cancelled

Priority: **P1**

## Problem

取消文件选择会触发远端刷新并可能覆盖本地补正表单。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

将取消文件选择改为无副作用返回；拆分远端状态刷新与表单覆盖；草稿态优先保留已落盘本地 review.form。

## Acceptance criteria

补正草稿保存后取消任意文件选择，所有补正字段保持不变；撤销保存后刷新也不得静默覆盖本地补正。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
