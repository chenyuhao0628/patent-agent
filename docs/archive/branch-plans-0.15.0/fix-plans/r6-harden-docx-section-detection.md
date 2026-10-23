# R6: harden DOCX five-part section detection

Priority: **P2**

## Problem

空标题和“说明书/说明书摘要”前缀匹配会把普通正文重复映射到五书或把摘要误识别为说明书。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

拒绝空标题参与匹配；使用规范化精确标题/明确别名映射并按最长/最具体标题判定；无法识别时退回普通正文。

## Acceptance criteria

无标题普通 Word 不生成伪五书；说明书摘要与说明书分别命中正确章节；五书模板仍可正确识别。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
