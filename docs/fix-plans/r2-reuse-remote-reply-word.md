# R2: allow saving while reusing an existing remote reply Word

Priority: **P1**

## Problem

沿用远端已有意见陈述书而不重新上传 Word 时，回读校验把预期 FileNo 当成空值。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

回读校验使用实际 payload 中保留的 FileNo，而不是仅使用本次上传产生的 replyFile；保留文件身份校验。

## Acceptance criteria

远端已有 Word + 修改表单 + 不重传 Word 可以保存并进入 saved；重新上传 Word 的路径保持通过。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
