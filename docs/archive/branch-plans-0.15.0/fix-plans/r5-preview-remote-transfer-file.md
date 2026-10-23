# R5: preview the actual remote transfer file in saved sessions

Priority: **P2**

## Problem

已保存方案的“远端材料预览”按钮传 role，后端按 role 读取本地副本；纯远端恢复时会失败或显示错误来源。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

远端预览传稳定的 fileNo/name；本地预览与远端预览使用不同身份参数，不允许静默回退到另一来源。

## Acceptance criteria

重新打开仅存在远端材料的 saved 方案可以预览；存在本地同名副本时仍展示指定远端版本。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
