# R7: verify remote transfer cleanup before reporting success

Priority: **P2**

## Problem

clearRemoteTransfer 吞掉多个删除/更新异常，随后只要能重新读取远端对象就可能显示“已成功物理删除”。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

不再无条件吞写入错误；逐项记录结果，并在最终回读中验证目标文件、混合文件、补正条目确实清空后才返回成功。

## Acceptance criteria

注入任一删除失败时不得显示完全成功；全部清空时才进入成功状态；部分成功给出可恢复提示。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
