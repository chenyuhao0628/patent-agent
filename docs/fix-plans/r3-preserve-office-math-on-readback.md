# R3: preserve OfficeMath when reading generated Word documents back

Priority: **P1**

## Problem

DOCX 回读只提取 w:t，Word 原生公式位于 m:* 数学结构，导致公式在预览/重新载入编辑器时消失。

## Root cause / scope

This issue was identified during the 0.15.0 audit at base commit `a713fb1`. Keep this change isolated from unrelated refactors so it can be reviewed and reverted independently.

## Fix plan

增加 OfficeMath 感知的段落提取/转换；无法可靠转换的复杂公式必须显式阻止覆盖，不能静默丢失。

## Acceptance criteria

覆盖普通公式、上下标、分式、根式；导出→外部修改→回读→载入编辑器→再保存后公式信息不丢失。

## Regression policy

Add focused regression coverage for the exact failure path. Do not weaken account/case scope checks, file identity checks, duplicate-transfer protection, or remote read-back verification merely to make the test pass.
